// resolve-maps-url — turns a Google Maps share link into an identity the
// place search can finish resolving in the browser.
//
//   POST /functions/v1/resolve-maps-url   { url }
//   → { placeId, name, latitude, longitude }   (every field nullable)
//
// Why this can't be done client-side: a shared link is almost always a
// maps.app.goo.gl shortlink, and the only thing that expands it is following
// its redirect. Google's shortener sends no CORS headers, so the browser
// can't read the Location header — the request fails before the redirect is
// visible. Server-side there is no such restriction.
//
// What this deliberately is NOT: a general-purpose URL fetcher. Three things
// hold that line.
//
// The URL the client submits must be a shortener or carry a /maps path, so
// the reachable surface is Google's map hosts rather than everything Google
// runs. The host allowlist itself is wider than that on purpose — a consent
// gate isn't on a map host — so it alone would leave this a blind
// authenticated GET across the estate.
//
// Every hop of the redirect chain is then re-checked against that allowlist
// rather than trusting `redirect: 'follow'`: an open redirect anywhere in
// Google's estate would otherwise turn this into an SSRF probe against the
// function's own network.
//
// And no response body is ever read. The Location header is all we want, so
// there is nothing to parse and nothing to be fooled by.
//
// Access: verify_jwt is enabled (see ../../config.toml), but on its own that
// only proves the Authorization header carries a JWT signed with the project
// secret — and the publishable anon key is exactly such a JWT, shipped in
// every client bundle. The sibling functions get away with treating that as
// enough because a second gate does the real work behind them (storage RLS
// under the caller's JWT in persist-photo; the SECURITY DEFINER RPC in
// invite-collaborator). This function has no such backstop — it spends our
// egress on outbound requests — so it resolves the caller itself and refuses
// anyone who isn't a signed-in user.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// What the iOS and Android share sheets hand out.
function isShortener(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'maps.app.goo.gl' || h === 'goo.gl';
}

// Which hosts this may talk to at all — any Google country domain, because a
// link copied in Austria arrives as google.at and an EU device's shortlink
// lands on consent.google.com before it ever reaches a map. That breadth is
// why the entry URL is separately held to a /maps path (see the handler): the
// two checks together are what keep this to map links.
function isAllowedHost(hostname: string): boolean {
  if (isShortener(hostname)) return true;
  // google.com, google.co.uk, maps.google.de, www.google.fr, consent.google.com…
  return /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2,3})?$/.test(hostname.toLowerCase());
}

const MAX_HOPS = 5;
const HOP_TIMEOUT_MS = 8000;
// One deadline for the whole chain, not per hop. Five hops at eight seconds
// each is forty seconds of a caller staring at "Reading that link…" with no
// way to cancel; the timeout that matters is how long the *user* waits.
const TOTAL_TIMEOUT_MS = 10000;

/**
 * Follows the shortlink by hand until a non-redirect answers.
 *
 * Manual rather than `redirect: 'follow'` for two reasons: every hop's host
 * gets re-checked against the allowlist, and we never download a response
 * body — a redirect has none worth reading, and the final page is a megabyte
 * of Maps HTML we have no use for. Bodies that do arrive are cancelled
 * explicitly; leaving them dangling leaks the connection in Deno.
 */
async function expand(startUrl: URL): Promise<URL | null> {
  let current = startUrl;
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    let res: Response;
    try {
      res = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(HOP_TIMEOUT_MS, remaining)),
        // Google serves a different (JS-only, redirect-free) page to clients
        // it doesn't recognise as a browser, and that page has no Location
        // header at all — the chain then dead-ends on the first hop.
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Cairn/1.0)' },
      });
    } catch {
      return null;
    }
    // Caught, not floating: a body already disturbed by an errored hop
    // rejects here, and an unhandled rejection in the edge runtime can take
    // the isolate down mid-request.
    res.body?.cancel().catch(() => {});

    if (res.status < 300 || res.status >= 400) return current;

    const location = res.headers.get('location');
    if (!location) return current;

    let next: URL;
    try {
      next = new URL(location, current); // relative Locations are legal
    } catch {
      return null;
    }
    if (next.protocol !== 'https:' || !isAllowedHost(next.hostname)) return null;

    // An EU consent gate carries the real destination in `continue`. Reading
    // it is what keeps this working outside the US — following the gate
    // itself just lands on a cookie wall that never redirects onward.
    if (next.hostname.toLowerCase() === 'consent.google.com') {
      const onward = next.searchParams.get('continue');
      if (!onward) return null;
      try {
        next = new URL(onward);
      } catch {
        return null;
      }
      if (next.protocol !== 'https:' || !isAllowedHost(next.hostname)) return null;
    }

    current = next;
  }
  return current;
}

/**
 * A Google place id, if the expanded URL happens to carry one.
 *
 * Three shapes, in descending order of how much we trust them:
 *
 *   ?query_place_id=ChIJ…   an explicit parameter — unambiguous
 *   ?q=place_id:ChIJ…       the documented Maps URL form
 *   !1sChIJ…                inside the `data=` blob
 *
 * That last one needs care. `!1s` is a *slot*, not a type: for many places it
 * holds a hex feature id ("0x476d07…:0x2e83…"), which is a different
 * identifier space that the Places API will not accept. So it is only read
 * when it looks like a place id — Google's own opaque base64url form — and a
 * hex id is left to fall through to the name-and-coordinates path below,
 * which resolves it properly.
 */
const PLACE_ID = /^[A-Za-z0-9_-]{20,}$/;

// Percent-decoded path + query, which is where the `data=` blob lives. It is
// a path *segment* ("/data=!3m1!4b1…") on current Maps URLs and a query
// parameter on older ones, so both are searched. Decoding can throw on a
// malformed escape; an undecoded string still matches everything below,
// since neither place ids nor coordinates contain escapable characters.
function decodedBlob(url: URL): string {
  const raw = url.pathname + url.search;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isPlaceUrl(url: URL): boolean {
  return url.pathname.includes('/maps/place/');
}

// A route is not a place, and its `data=` blob can carry per-waypoint
// coordinates in shapes close enough to a pin's to be read as one. Refused by
// path rather than picked apart.
function isDirectionsUrl(url: URL): boolean {
  return url.pathname.includes('/maps/dir/');
}

function findPlaceId(url: URL): string | null {
  const explicit = url.searchParams.get('query_place_id');
  if (explicit && PLACE_ID.test(explicit)) return explicit;

  const q = url.searchParams.get('q') ?? '';
  const tagged = q.match(/^place_id:([A-Za-z0-9_-]{20,})$/);
  if (tagged) return tagged[1];

  // The trailing boundary is a negative lookahead rather than `!|$` because
  // the blob continues past the id (`!1sChIJ…!8m2!3d…`) and, for a hex
  // feature id, stops at the ':' that splits its two halves.
  const inData = decodedBlob(url).match(/!1s([A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/);
  if (inData && !inData[1].startsWith('0x')) return inData[1];

  return null;
}

/**
 * The pin's coordinates.
 *
 * `!8m2!3d<lat>!4d<lng>` is the place itself; `/@lat,lng,zoom` is where the
 * *camera* sits, which for a place opened from a search result is often
 * offset — Maps leaves room for the info card. Preferring the former is what
 * keeps a pasted link landing on the restaurant rather than half a block up
 * the street, so `/@` is only a fallback for links that carry nothing better.
 */
function findCoords(url: URL): { latitude: number; longitude: number } | null {
  const blob = decodedBlob(url);
  const pin = blob.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  // The camera is only meaningful on a URL that is *about* a place. Every
  // Maps URL has an `@lat,lng` in it, including a route and a search, and
  // reading those as a location is worse than reading nothing: a directions
  // link from Vienna to Graz would resolve to whatever address happens to sit
  // halfway between them, and be offered as a place to add. With no camera to
  // fall back on, such a link yields nothing and is refused outright.
  const camera = isPlaceUrl(url) ? blob.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/) : null;
  const hit = pin ?? camera;
  if (!hit) return null;
  const latitude = Number(hit[1]);
  const longitude = Number(hit[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

// A dropped pin has no name, so Maps writes the coordinates where the name
// would go — either as DMS ("40°42'46.1\"N 74°00'21.6\"W") or as a plain
// decimal pair. Both are useless as a place name and worse as a search query,
// so they are rejected here and the caller falls back to reverse geocoding
// the coordinates, which at least yields a street address.
function isCoordinateLabel(name: string): boolean {
  return /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(name) || /\d+°\d+'/.test(name);
}

function findName(url: URL): string | null {
  const match = url.pathname.match(/\/maps\/place\/([^/@]+)/);
  if (!match) return null;
  let name: string;
  try {
    name = decodeURIComponent(match[1].replace(/\+/g, ' ')).trim();
  } catch {
    return null;
  }
  if (!name || isCoordinateLabel(name)) return null;
  return name;
}

interface Identity {
  placeId: string | null;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
}

const NOTHING: Identity = { placeId: null, name: null, latitude: null, longitude: null };

function parseIdentity(url: URL): Identity {
  if (isDirectionsUrl(url)) return NOTHING;
  const coords = findCoords(url);
  return {
    placeId: findPlaceId(url),
    name: findName(url),
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
  };
}

function isEmpty(id: Identity): boolean {
  return !id.placeId && !id.name && id.latitude === null;
}

/**
 * Is a round trip to Google worth making?
 *
 * Only for a shortener, or a long-form URL that identifies nothing by itself
 * and isn't already saying what it is. A `/maps?cid=…` link is the case that
 * earns the fetch: it carries no place data and does redirect to one.
 *
 * A URL that already declares itself a place, a route or a search has said
 * everything it is going to say — fetching it can only waste an upstream
 * request before the same answer, and Google serves a non-browser client a
 * JavaScript shell with no place data in it regardless.
 */
function needsExpansion(url: URL): boolean {
  if (isShortener(url.hostname)) return true;
  if (isPlaceUrl(url) || isDirectionsUrl(url) || url.pathname.includes('/maps/search/')) {
    return false;
  }
  return isEmpty(parseIdentity(url));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing authorization' }, 401);

  // Who is actually asking. Without this the anon key alone opens the door,
  // and anyone holding it — it is public by design — could drive up to five
  // authenticated server-side GETs per request out of our egress.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: 'not signed in' }, 401);

  let raw: string;
  try {
    const body = await req.json();
    raw = String(body.url ?? '');
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  let start: URL;
  try {
    start = new URL(raw);
  } catch {
    return json({ error: 'invalid url' }, 400);
  }
  if (start.protocol !== 'https:' || !isAllowedHost(start.hostname)) {
    return json({ error: 'Not a Google Maps link' }, 400);
  }
  // The host allowlist deliberately covers all of google.<tld>, because the
  // redirect chain needs it — an EU consent gate is not on a map host. The
  // URL the client *submits* is held to more than that: without a /maps path
  // this is a blind authenticated GET across everything Google runs, rather
  // than the map-hosts-only fetcher it is documented to be. A shortener has
  // no path worth checking; anything else has to say /maps.
  if (!isShortener(start.hostname) && !start.pathname.startsWith('/maps')) {
    return json({ error: 'Not a Google Maps link' }, 400);
  }

  let target: URL | null = start;
  if (needsExpansion(start)) {
    target = await expand(start);
    if (!target) return json({ error: 'Could not open that link' }, 502);
  }

  const result = parseIdentity(target);

  // A Maps *directions* or *search* URL, or a layout we don't read. Saying so
  // is better than returning four nulls the client would have to interpret as
  // failure anyway.
  if (isEmpty(result)) return json({ error: "That link doesn't point at a place" }, 422);

  return json(result);
});
