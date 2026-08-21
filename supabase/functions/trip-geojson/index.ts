// trip-geojson — exports a trip's *visited* places as GeoJSON, gated by the
// trip's public share token (same trust model as the /shared/:token web view:
// whoever holds the token may read).
//
//   GET /functions/v1/trip-geojson?token=<share_token>
//
// Response: a GeoJSON FeatureCollection — one LineString per routed leg
// (Mapbox driving directions, straight-line fallback where no road route
// exists), one Point per stop (with a `name` for tooltips), coordinates as
// [lng, lat]. A non-standard top-level `metadata` object carries the trip
// name, dates, centre point and stop count so an importer can build a
// summary entry; strip it if you need strictly valid GeoJSON.
//
// verify_jwt is disabled (pinned in ../../config.toml so deploys can't
// forget): auth is the share token itself, checked below.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// This endpoint is unauthenticated (token-gated), and every leg costs a
// Mapbox Directions call — bound the damage a looping token holder can do:
// legs beyond the cap fall back to straight lines instead of API calls, and
// a computed result is reused for a while (per warm instance) since places
// change far less often than exports are requested.
const MAX_ROUTED_LEGS = 30;
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; body: string }>();

type Place = {
  name: string;
  latitude: number;
  longitude: number;
  visited_at: string;
  kind: 'stop' | 'spot';
  parent_place_id: string | null;
};

// Road snapping via Mapbox directions. Set a MAPBOX_TOKEN secret on the
// function to enable it:
//
//   supabase secrets set MAPBOX_TOKEN=pk.your-own-token
//
// Deliberately no baked-in fallback. A public `pk.` token is not a secret,
// but a hardcoded one in a public repo is a billable credential sitting in
// something bots scrape continuously — and it would be *someone else's*
// quota every fork spends. Without the secret the export still works; every
// leg is just a straight line instead of a road route.
const MAPBOX_TOKEN = Deno.env.get('MAPBOX_TOKEN') ?? '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
};

function json(body: unknown, status = 200, contentType = 'application/json') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': contentType },
  });
}

// Road geometry for one leg via Mapbox driving directions. Returns null when
// there's no token or no drivable route (islands, oceans, different
// continents) — the caller then falls back to a straight line.
async function roadLeg(
  from: [number, number],
  to: [number, number],
): Promise<[number, number][] | null> {
  if (!MAPBOX_TOKEN) return null;
  const coords = `${from[0]},${from[1]};${to[0]},${to[1]}`;
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}` +
    `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.[0]) return null;
    return data.routes[0].geometry.coordinates as [number, number][];
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const token = new URL(req.url).searchParams.get('token')?.trim();
  if (!token) return json({ error: 'missing token' }, 400);

  // share_token is a uuid column; a malformed token can't match any trip, and
  // querying it raw would surface a Postgres cast error. Treat it as not-found.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!isUuid.test(token)) return json({ error: 'no trip for token' }, 404);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Resolve the trip from its share token. Service role bypasses RLS; the
  // token is the authorization.
  const { data: trip, error: tripErr } = await supabase
    .from('trips')
    .select('id, name, start_date, end_date')
    .eq('share_token', token)
    .maybeSingle();

  if (tripErr) return json({ error: 'lookup failed' }, 500);
  if (!trip) return json({ error: 'no trip for token' }, 404);

  // Visited places only, in the order they were actually visited.
  const { data: placesData, error: placesErr } = await supabase
    .from('places')
    .select('name, latitude, longitude, visited_at, kind, parent_place_id')
    .eq('trip_id', trip.id)
    .eq('status', 'visited')
    .not('visited_at', 'is', null)
    .order('visited_at', { ascending: true });

  if (placesErr) return json({ error: 'places load failed' }, 500);
  const places = (placesData ?? []) as Place[];

  // Serve a still-fresh cached export: the visit list is the cache key, so
  // any change to the visited places invalidates it naturally.
  // kind and parent are in the key because they now decide what the track
  // connects: anchoring a visited café changes the exported LineString without
  // touching a coordinate or a date, and a key that ignored them would serve
  // the old route for the whole TTL.
  const cacheKey = trip.id + '|' +
    places.map((p) => `${p.latitude},${p.longitude},${p.visited_at},${p.kind},${p.parent_place_id ?? ''}`).join(';');
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return new Response(hit.body, {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/geo+json' },
    });
  }

  // The track follows stops; a café inside a city is somewhere you were, not
  // somewhere you travelled to. Routing through them spent legs of the Mapbox
  // budget on sub-kilometre hops within one city and reported a two-city trip
  // as five stops. They keep their markers below — this only decides what the
  // line connects.
  //
  // Same predicate as the map's Spots filter: anchored spots only, so
  // one whose stop was deleted still counts rather than silently vanishing
  // from the track.
  const routed = places.filter((p) => !(p.kind === 'spot' && p.parent_place_id));
  // The fallback is for a trip recorded ENTIRELY as spots, which would
  // otherwise export markers and no track at all. It was written `>= 2`, which
  // also swallowed the ordinary one-stop trip: a city with four cafés in it
  // fell through to routing all five, spending four Mapbox calls on
  // sub-kilometre hops inside that city and reporting stopCount 5 — verbatim
  // the failure this filter exists to remove. One stop is a track of one
  // point, and a track of one point is no legs, which the loop below already
  // handles.
  const legs = routed.length > 0 ? routed : places;

  const features: unknown[] = [];

  // Routed legs between consecutive stops. A leg with no drivable route (or
  // when Mapbox isn't configured, or past the routing cap) degrades to a
  // straight line rather than a gap, so the track always stays connected.
  for (let i = 0; i < legs.length - 1; i++) {
    const from: [number, number] = [legs[i].longitude, legs[i].latitude];
    const to: [number, number] = [legs[i + 1].longitude, legs[i + 1].latitude];
    const road = i < MAX_ROUTED_LEGS ? await roadLeg(from, to) : null;
    features.push({
      type: 'Feature',
      properties: { name: `${legs[i].name} → ${legs[i + 1].name}`, road: !!road },
      geometry: { type: 'LineString', coordinates: road ?? [from, to] },
    });
  }

  // Stop markers.
  for (const p of places) {
    features.push({
      type: 'Feature',
      properties: { name: p.name },
      geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
    });
  }

  // Centre of the stops as [lat, lng], for an importer's map-centring fallback.
  const lats = places.map((p) => p.latitude);
  const lngs = places.map((p) => p.longitude);
  const center = places.length
    ? [
        (Math.min(...lats) + Math.max(...lats)) / 2,
        (Math.min(...lngs) + Math.max(...lngs)) / 2,
      ]
    : null;

  const body = JSON.stringify({
    type: 'FeatureCollection',
    features,
    metadata: {
      name: trip.name,
      dateStart: trip.start_date,
      dateEnd: trip.end_date,
      destCoords: center,
      stopCount: legs.length,
    },
  });

  cache.set(cacheKey, { at: Date.now(), body });
  // Drop stale entries so a token-scanning attacker can't grow the map.
  for (const [k, v] of cache) {
    if (Date.now() - v.at >= CACHE_TTL_MS) cache.delete(k);
  }

  return new Response(body, {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/geo+json' },
  });
});
