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

// A host that is only ever maps, whatever its path — the legacy deep-link
// form "maps.google.com/?q=48.2,16.3" carries its place in the query string
// and nothing in the path, which is the shape most third-party "view on
// Google Maps" links still use. Exempt from the /maps path check below for
// that reason, and no wider for it: the hostname already says maps.
function isMapsHost(hostname: string): boolean {
  return /^maps\.google\.[a-z]{2,3}(\.[a-z]{2,3})?$/.test(hostname.toLowerCase());
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

    // Standing on a shortener when the redirects stop means the link never
    // expanded — Google served an interstitial or throttled us. Handing the
    // shortlink back would have it parsed for a place it cannot contain, and
    // the user told it points at nothing when the truth is it was never
    // opened. Null, so the handler can say that instead.
    //
    // The same non-redirect from a long-form URL means the opposite: it
    // opened fine and simply doesn't name a place, which a bare `/maps/@…`
    // camera link genuinely doesn't. Returning it reaches the 422 that
    // deserves, rather than a 502 inviting a retry that can never work.
    //
    // Asked of where we are standing rather than of whether we have moved: a
    // chain can move and still be on the shortener — a self-redirect adding a
    // tracking parameter — and a "did it move" test would call that expanded.
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
    // it is what keeps this working outside the US — following the gate
    // itself just lands on a cookie wall that never redirects onward, and
    // fetch keeps no cookie jar between hops to get past it.
    //
    // Matched on the prefix, not the exact host: the wall is served from the
    // country domains too (consent.google.de, consent.google.fr, …), and an
    // exact test missed every one of them — which is to say it missed most of
    // the case this branch exists for.
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

    // Stop the moment the URL identifies a place, rather than fetching it to
    // learn what we can already read. That fetch is a round trip against a
    // heavy Maps page whose body we cancel unread — and if it fails, which is
    // a timeout or Google throttling this User-Agent away, the catch above
    // would throw away an answer that was complete after hop 0 and turn it
    // into a 502. It also halves the useful redirect budget.
    if (!needsExpansion(next)) return next;

    current = next;
  }
  // Out of hops. Same rule as above: a shortlink is not an answer.
  return isShortener(current.hostname) ? null : current;
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

// Just a viewport — "copy link" with nothing selected. It names no place and
// findCoords ignores the camera off a place URL, so there is nothing here to
// find and, being a final URL already, nothing a fetch could turn it into.
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
 * Three shapes, in descending order of precision. `!8m2!3d<lat>!4d<lng>` is
 * the place itself. `?q=`/`?ll=` is a coordinate someone wrote down, so it is
 * the place too. `/@lat,lng,zoom` is where the *camera* sits, which for a
 * place opened from a search result is often offset — Maps leaves room for
 * the info card — so it is a last resort, and only on a place URL at that.
 *
 * That order is what keeps a pasted link landing on the restaurant rather
 * than half a block up the street.
 */
const COORD_PAIR = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

// The documented `?q=48.21,16.36` and `?ll=48.21,16.36` forms, which are what
// third-party "view on Google Maps" links and shared coordinates use. They
// carry no data blob and no `@`, so without this they read as empty and a
// link whose coordinates are sitting in plain sight was refused as pointing
// at no place.
function findParamCoords(url: URL): RegExpMatchArray | null {
  for (const key of ['q', 'll']) {
    const value = url.searchParams.get(key);
    const hit = value?.match(COORD_PAIR);
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
  // Reported, because the difference matters downstream: a pin is where the
  // place is, a camera is only roughly near it. The client widens its
  // sanity check and refuses to drop a marker on a bare camera position.
  return { latitude, longitude, fromCamera: !pin };
}

// A dropped pin has no name, so Maps writes the coordinates where the name
// would go — either as DMS ("40°42'46.1\"N 74°00'21.6\"W") or as a plain
// decimal pair. Both are useless as a place name and worse as a search query,
// so they are rejected here and the caller falls back to reverse geocoding
// the coordinates, which at least yields a street address.
function isCoordinateLabel(name: string): boolean {
  // The same pattern findParamCoords reads, deliberately: when the two
  // disagreed about spacing, "48.85 , 2.29" was taken as coordinates *and*
  // kept as a name, so the client spent a Find Place on the literal string
  // and, failing, added a place called "48.85 , 2.29" — never reaching the
  // reverse geocode this guard exists to force.
  return COORD_PAIR.test(name) || /\d+°\d+'/.test(name);
}

function findName(url: URL): string | null {
  // `?q=Some+Place` is the other half of the query-parameter form — a name
  // rather than a coordinate pair. `place_id:` lives in the same parameter
  // and is findPlaceId's to read, never a name.
  const q = url.searchParams.get('q')?.trim();
  if (q && !q.startsWith('place_id:') && !isCoordinateLabel(q)) return q;

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
}

const NOTHING: Identity = {
  placeId: null, name: null, latitude: null, longitude: null, fromCamera: false,
};

function parseIdentity(url: URL): Identity {
  if (isDirectionsUrl(url)) return NOTHING;
  const coords = findCoords(url);
  return {
    placeId: findPlaceId(url),
    name: findName(url),
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    fromCamera: coords?.fromCamera ?? false,
  };
}

/**
 * Can the client actually do something with this?
 *
 * A place id, or a location. Deliberately NOT a bare name: the browser half
 * refuses to act on one, because Find Place answers a name with the most
 * famous match and there would be nothing left to check it against. Counting
 * a name as identified is what made `?q=Eiffel+Tower` stop dead — the URL
 * looked answered, so the redirect that would have produced coordinates was
 * never followed, and the client then rejected what came back.
 */
function isResolvable(id: Identity): boolean {
  return !!id.placeId || id.latitude !== null;
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

  // Who is actually asking. Without this the anon key alone opens the door,
  // and anyone holding it — it is public by design — could drive up to five
  // authenticated server-side GETs per request out of our egress.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  // The error half matters, because auth-js does not throw for a flaky auth
  // server — it returns { user: null, error } just as it does for a caller
  // who really is anonymous. Told apart by status: a retryable fetch failure
  // carries 0, a rejected token carries 401/403. Without this the check now
  // sitting on the critical path of every paste answers "you're not signed
  // in" to a signed-in user whose blip we caused.
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
  // The host allowlist deliberately covers all of google.<tld>, because the
  // redirect chain needs it — an EU consent gate is not on a map host. The
  // URL the client *submits* is held to more than that: without a /maps path
  // this is a blind authenticated GET across everything Google runs, rather
  // than the map-hosts-only fetcher it is documented to be. A shortener has
  // no path worth checking; anything else has to say /maps.
  // A segment test, not a prefix one: `startsWith('/maps')` also lets through
  // /mapsanything, which is precisely the breadth this is here to deny.
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

  // A Maps *directions* or *search* URL, or a layout we don't read. Saying so
  // is better than returning four nulls the client would have to interpret as
  // failure anyway.
  // Two different failures, and the remedies differ: a route or a bare map
  // view names nothing, while a `?q=Some+Place` that never expanded names
  // something we couldn't locate. Neither is usable, but saying which is the
  // difference between "you shared the wrong thing" and "open the place first".
  if (!isResolvable(result)) {
    return json({
      error: result.name
        ? "Couldn't work out where that place is"
        : "That link doesn't point at a place",
    }, 422);
  }

  return json(result);
});
