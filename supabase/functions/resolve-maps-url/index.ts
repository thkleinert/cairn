// resolve-maps-url — turns a Google Maps share link into an identity the
// place search can finish resolving in the browser.
//
//   POST /functions/v1/resolve-maps-url   { url }
//   → { placeId, name, latitude, longitude, fromCamera }
//     (every field but fromCamera nullable)
//
// Why this can't be done client-side: a shared link is almost always a
// maps.app.goo.gl shortlink, and the only thing that expands it is following
// its redirect. Google's shortener sends no CORS headers, so the browser
// can't read the Location header — the request fails before the redirect is
// visible. Server-side there is no such restriction.
//
// What this deliberately is NOT: a general-purpose URL fetcher. Three things
// hold that line. The submitted URL must be a shortener or carry a /maps
// path — the host allowlist alone is wider, since a consent gate isn't on a
// map host, and would leave this a blind GET across Google's estate. Every
// redirect hop is then re-checked against that allowlist rather than trusting
// `redirect: 'follow'`, or an open redirect anywhere in that estate turns
// this into an SSRF probe. And no response body is ever read.
//
// Access: verify_jwt alone does NOT mean "signed in" — it checks the JWT's
// signature, and the publishable anon key is such a JWT, shipped in every
// client bundle. The sibling functions can rely on it because a second gate
// backs them (storage RLS in persist-photo, the SECURITY DEFINER RPC in
// invite-collaborator). This one has none and spends our egress, so it
// resolves the caller itself.

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

// A host that is only ever maps, whatever its path. The share sheet's own
// chain passes through "maps.google.com?q=…" with no path at all, so the
// /maps requirement the other Google hosts carry would turn away a URL
// Google itself produced.
function isMapsHost(hostname: string): boolean {
  return /^maps\.google\.[a-z]{2,3}(\.[a-z]{2,3})?$/.test(hostname.toLowerCase());
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
  // Where we have already been. A consent gate's `continue` points back at
  // the page it is gating, so unwrapping it hands back a URL we just fetched
  // — and fetching it again only earns the same gate. Left unchecked that
  // burns every hop and reports "could not open" for a link that was fully
  // resolved two hops ago.
  const seen = new Set<string>([startUrl.href]);
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

    // Redirects stopped. Still on a shortener means the link never expanded
    // (an interstitial, or a throttle) — a different thing from a long-form
    // URL that opened fine and simply names no place, and it deserves a
    // different message. Asked of where we stand, not of whether we moved: a
    // shortener can self-redirect to add a tracking parameter and still be a
    // shortener.
    const stalled = isShortener(current.hostname);

    if (res.status < 300 || res.status >= 400) return stalled ? null : current;

    const location = res.headers.get('location');
    if (!location) return stalled ? null : current;

    let next: URL;
    try {
      next = new URL(location, current); // relative Locations are legal
    } catch {
      return null;
    }
    if (next.protocol !== 'https:' || !isAllowedHost(next.hostname)) return null;

    // An EU consent gate carries the real destination in `continue`. Reading
    // it is what keeps this working outside the US: following the gate lands
    // on a cookie wall that never redirects onward, and fetch keeps no cookie
    // jar between hops. Prefix-matched, because the wall is served from the
    // country domains too (consent.google.de, .fr, …).
    if (/^consent\.google\./.test(next.hostname.toLowerCase())) {
      const onward = next.searchParams.get('continue');
      if (!onward) return null;
      try {
        next = new URL(onward);
      } catch {
        return null;
      }
      if (next.protocol !== 'https:' || !isAllowedHost(next.hostname)) return null;
    }

    // Stop once the URL identifies a place rather than fetching it to learn
    // what we can already read. That fetch is a round trip against a heavy
    // page we cancel unread, and if it fails the catch above would discard an
    // answer that was already complete and call it a 502.
    if (!needsExpansion(next)) return next;

    // Been here before — the consent gate bouncing us back to the page it
    // gates. That page is the destination; Google is asking for cookies we
    // have no way to give it, not sending us somewhere new.
    if (seen.has(next.href)) return next;
    seen.add(next.href);

    current = next;
  }
  // Out of hops, and `current` is here only because it was known NOT to
  // identify a place — that is what kept the loop going. Returning it would
  // reach the handler's "doesn't point at a place" when the truth is the
  // chain was longer than we would follow.
  return null;
}

/**
 * A Google place id, if the expanded URL happens to carry one:
 * ?query_place_id=ChIJ…, ?q=place_id:ChIJ…, or !1sChIJ… in the `data=` blob.
 *
 * That last one needs care. `!1s` is a *slot*, not a type: for many places it
 * holds a hex feature id ("0x476d07…:0x2e83…"), an identifier space the
 * Places API will not accept. So it is read only when it looks like a place
 * id, and a hex id falls through to the name-and-coordinates path — which is
 * why that path is the common one rather than the fallback.
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

// A route is not a place, and its `data=` blob carries per-waypoint
// coordinates close enough to a pin's to be misread. Refused by path.
function isDirectionsUrl(url: URL): boolean {
  return url.pathname.includes('/maps/dir/');
}

// Just a viewport — "copy link" with nothing selected. Names no place, and
// already final, so there is nothing a fetch could turn it into.
function isCameraUrl(url: URL): boolean {
  return url.pathname.startsWith('/maps/@');
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
 * `!8m2!3d<lat>!4d<lng>` is the place itself. `/@lat,lng,zoom` is where the
 * *camera* sits, often offset to leave room for the info card, so it is a
 * last resort and only on a place URL. That order is what keeps a pasted link
 * landing on the restaurant rather than half a block up the street.
 */
const COORD_PAIR = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

// `?q=48.21,16.36` and `?ll=…`, the documented coordinate forms.
function findParamCoords(url: URL): RegExpMatchArray | null {
  for (const key of ['q', 'll']) {
    const hit = url.searchParams.get(key)?.match(COORD_PAIR);
    if (hit) return hit;
  }
  return null;
}

function findCoords(url: URL): { latitude: number; longitude: number; fromCamera: boolean } | null {
  const blob = decodedBlob(url);
  const pin = blob.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/)
    ?? findParamCoords(url);
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
  // Reported because it matters downstream: a pin is where the place is, a
  // camera only roughly near it, so the client widens its match tolerance.
  return { latitude, longitude, fromCamera: !pin };
}

// A dropped pin has no name, so Maps writes the coordinates where the name
// would go — either as DMS ("40°42'46.1\"N 74°00'21.6\"W") or as a plain
// decimal pair. Both are useless as a place name and worse as a search query,
// so they are rejected here and the caller falls back to reverse geocoding
// the coordinates, which at least yields a street address.
function isCoordinateLabel(name: string): boolean {
  return COORD_PAIR.test(name) || /\d+°\d+'/.test(name);
}

/**
 * The `?q=` name, which is the shape a shared link actually arrives in.
 *
 * This is what the iOS share sheet produces, via two redirects:
 *
 *   maps.app.goo.gl/AmsF…  →  maps.google.com?q=<name>&ftid=0x30e2…
 *
 * and `q` there is not a bare label but the place's full formatted address —
 * "Maeklong Railway Market (Rom Hup Market), Mae Klong, Mueang Samut
 * Songkhram District, Samut Songkhram 75000, Thailand". That distinction is
 * why it is reported separately from a `/maps/place/<name>` segment: a
 * display name needs coordinates beside it before Find Place can be trusted,
 * and an address with a postcode and a country in it does not.
 *
 * The `ftid` riding alongside is the hex feature id — the same identifier
 * space findPlaceId refuses, and the reason there is nothing better to use.
 */
function findQueryName(url: URL): string | null {
  const q = url.searchParams.get('q')?.trim();
  if (!q || q.startsWith('place_id:') || isCoordinateLabel(q)) return null;
  return q;
}

/**
 * Is that `q` a formatted address, or just something typed into the box?
 *
 * The difference decides whether the client may act on the name with no
 * coordinates beside it, so it has to be real rather than assumed. Google
 * writes an address as components — "<place>, <district>, <city> <postcode>,
 * <country>" — while `?q=coffee` or `?q=Central Park` is a search someone
 * typed, and acting on those with no pin is exactly the wrong-city match this
 * has been careful about all along. Three components is the line: it admits
 * "Eiffel Tower, Paris, France" and turns away "coffee, vienna".
 */
function looksLikeAddress(q: string): boolean {
  return q.split(',').filter(part => part.trim()).length >= 3;
}

function findName(url: URL): string | null {
  const fromQuery = findQueryName(url);
  if (fromQuery) return fromQuery;

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
  /** True when the coordinates are a viewport centre, not the place itself. */
  fromCamera: boolean;
  /** True when `name` is Google's own formatted address, not a display name. */
  nameIsAddress: boolean;
}

const NOTHING: Identity = {
  placeId: null, name: null, latitude: null, longitude: null,
  fromCamera: false, nameIsAddress: false,
};

function parseIdentity(url: URL): Identity {
  if (isDirectionsUrl(url)) return NOTHING;
  const coords = findCoords(url);
  const queryName = findQueryName(url);
  return {
    placeId: findPlaceId(url),
    name: findName(url),
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    fromCamera: coords?.fromCamera ?? false,
    nameIsAddress: queryName !== null && looksLikeAddress(queryName),
  };
}

/**
 * Can the client actually do something with this? A place id, a location, or
 * a name specific enough to stand alone.
 *
 * A bare display name is not: Find Place answers "Central Park" with the most
 * famous one and, with no coordinates from the link, nothing is left to check
 * that against. A formatted address is a different thing — it carries its own
 * town, postcode and country — and refusing it is what made a perfectly
 * ordinary shared link fail, since that is the only identity the share
 * sheet's `?q=` form has to offer.
 */
function isResolvable(id: Identity): boolean {
  return !!id.placeId || id.latitude !== null || id.nameIsAddress;
}

/**
 * Is a round trip to Google worth making? Only for a shortener, or a
 * long-form URL that identifies nothing and isn't already declaring what it
 * is. `/maps?cid=…` is the case that earns it. A URL that already says it is
 * a place, a route, a search or a camera view has said everything it will —
 * and Google serves a non-browser client a JS shell with no place data anyway.
 */
function needsExpansion(url: URL): boolean {
  if (isShortener(url.hostname)) return true;
  if (
    isPlaceUrl(url) ||
    isDirectionsUrl(url) ||
    isCameraUrl(url) ||
    url.pathname.includes('/maps/search/')
  ) {
    return false;
  }
  return !isResolvable(parseIdentity(url));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'You need to be signed in' }, 401);

  // Who is actually asking. Without this the public anon key opens the door,
  // and anyone holding it could drive five server-side GETs per request.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  // The error half matters: auth-js does not throw for a flaky auth server,
  // it returns { user: null, error } exactly as for a genuinely anonymous
  // caller. Told apart by status — 0 or 5xx is ours to retry, 401/403 theirs.
  if (authError) {
    const status = (authError as { status?: number }).status ?? 0;
    if (status === 0 || status >= 500) {
      return json({ error: 'Could not check your sign-in — try again' }, 503);
    }
  }
  if (!user) return json({ error: 'You need to be signed in' }, 401);

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
    return json({ error: "That doesn't look like a link" }, 400);
  }
  if (start.protocol !== 'https:' || !isAllowedHost(start.hostname)) {
    return json({ error: 'Not a Google Maps link' }, 400);
  }
  // The allowlist covers all of google.<tld> because the redirect chain needs
  // it; the URL the client *submits* is held to more, or this is a blind
  // authenticated GET across everything Google runs. A segment test, not a
  // prefix one — `startsWith('/maps')` would admit /mapsanything.
  const onMapsPath = start.pathname === '/maps' || start.pathname.startsWith('/maps/');
  if (!isShortener(start.hostname) && !isMapsHost(start.hostname) && !onMapsPath) {
    return json({ error: 'Not a Google Maps link' }, 400);
  }

  let target: URL | null = start;
  if (needsExpansion(start)) {
    target = await expand(start);
    if (!target) return json({ error: 'Could not open that link' }, 502);
  }

  const result = parseIdentity(target);

  // Two failures with different remedies: a route or bare map view names
  // nothing, while a link that named a place we couldn't locate is a
  // different conversation.
  if (!isResolvable(result)) {
    return json({
      error: result.name
        ? "Couldn't work out where that place is"
        : "That link doesn't point at a place",
    }, 422);
  }

  return json(result);
});
