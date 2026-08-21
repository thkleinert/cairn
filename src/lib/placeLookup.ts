import type { NearbyPlace, PointLookup } from '../types';
import { spanFromViewport } from './anchor';

// "What's here?" for an arbitrary map point: the street address at that spot
// plus the POIs immediately around it.
//
// Cost note — Nearby Search is a Pro-tier SKU (5,000 free calls/month, then
// billed), unlike the search field's Autocomplete session, which is free.
// Every call here is therefore deliberate: one per point the user actually
// long-presses, never speculative, and memoised per rounded coordinate so
// pressing the same spot twice can't bill twice.

const NEARBY_RADIUS_M = 150;
const MAX_NEARBY = 8;
const GOOGLE_READY_TIMEOUT_MS = 8000;

const UNAVAILABLE: PointLookup = { address: null, nearby: [], ok: false };

function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres / 5) * 5} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

// main.tsx injects the Maps script and dispatches `gmaps-loaded` on load.
// Resolve false rather than hanging forever if it never arrives (blocked
// script, missing key, offline) — the sheet still offers the custom path.
function whenGoogleReady(): Promise<boolean> {
  if (window.google?.maps?.places) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      window.removeEventListener('gmaps-loaded', onLoad);
      resolve(ok);
    };
    const onLoad = () => done(true);
    const timer = setTimeout(() => done(false), GOOGLE_READY_TIMEOUT_MS);
    window.addEventListener('gmaps-loaded', onLoad);
  });
}

type Services = { places: google.maps.places.PlacesService; geocoder: google.maps.Geocoder };

let services: Services | null = null;
// Memoised so a blocked script costs one 8s timeout for the whole session, not
// one per lookup — and, since each lookup calls getServices twice, not two.
// Holds the in-flight promise, so concurrent callers share a single wait.
let servicesPromise: Promise<Services | null> | null = null;

function getServices(): Promise<Services | null> {
  if (services) return Promise.resolve(services);
  if (servicesPromise) return servicesPromise;
  servicesPromise = initServices();
  return servicesPromise;
}

async function initServices() {
  if (!(await whenGoogleReady())) return null;
  // PlacesService needs an element to attribute results to; it is never
  // attached to the document — we render the "powered by Google" notice
  // ourselves, as the search dropdown already does.
  services = {
    places: new google.maps.places.PlacesService(document.createElement('div')),
    geocoder: new google.maps.Geocoder(),
  };
  return services;
}

function reverseGeocode(point: { lat: number; lng: number }): Promise<string | null> {
  return getServices().then(svc => {
    if (!svc) return null;
    return new Promise<string | null>(resolve => {
      svc.geocoder.geocode({ location: point }, (results, status) => {
        if (status === google.maps.GeocoderStatus.OK && results?.[0]) {
          resolve(results[0].formatted_address ?? null);
        } else {
          resolve(null);
        }
      });
    });
  });
}

// null means Google didn't answer — distinct from [] ("nothing within 150 m"),
// which is a real answer the UI is allowed to state as fact.
function nearbySearch(point: { lat: number; lng: number }): Promise<NearbyPlace[] | null> {
  return getServices().then(svc => {
    if (!svc) return null;
    return new Promise<NearbyPlace[] | null>(resolve => {
      svc.places.nearbySearch(
        { location: point, radius: NEARBY_RADIUS_M },
        (results, status) => {
          const S = google.maps.places.PlacesServiceStatus;
          // ZERO_RESULTS is an ordinary outcome for open countryside, not a
          // failure — an empty list is the correct answer there. Everything
          // else (REQUEST_DENIED, OVER_QUERY_LIMIT once the Pro-tier free cap
          // is gone, UNKNOWN_ERROR, a dropped connection) is us failing to ask,
          // and must never be presented as "there is nothing here".
          if (status === S.ZERO_RESULTS) {
            resolve([]);
            return;
          }
          if (status !== S.OK || !results) {
            resolve(null);
            return;
          }
          const mapped = results.flatMap(r => {
            const loc = r.geometry?.location;
            // Without coordinates it can't become a pin, and without a
            // place_id we can't key or de-duplicate it.
            if (!loc || !r.place_id || !r.name) return [];
            const latitude = loc.lat();
            const longitude = loc.lng();
            return [{
              place_id: r.place_id,
              name: r.name,
              address: r.vicinity ?? '',
              latitude,
              longitude,
              distance: distanceMetres(point, { lat: latitude, lng: longitude }),
              // Same ephemeral session URL the search field yields; addPlace
              // re-hosts it to our own storage right after insert.
              image_url: r.photos?.[0]?.getUrl({ maxWidth: 800 }),
              // Free — it is already in the response we paid for. This is the
              // only reliable signal on this path: a nearby result carries
              // `vicinity`, which is a neighbourhood rather than a street
              // address, so the address heuristic alone never fires here and
              // a café picked off the map used to arrive as a stop of its own
              // while the same café from the search field nested correctly.
              types: r.types,
              // Documented as getDetails-only, so usually absent here; read
              // when present rather than assumed missing.
              spanKm: spanFromViewport(r.geometry?.viewport),
            }];
          });
          mapped.sort((a, b) => a.distance - b.distance);
          resolve(mapped.slice(0, MAX_NEARBY));
        }
      );
    });
  });
}

// Rounded to ~11 m: two presses inside one fingertip resolve to the same key
// and share a single set of API calls.
function cacheKey(point: { lat: number; lng: number }) {
  return `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`;
}

const CACHE_MAX = 50;
// Entries carry NearbyPlace.image_url, which is one of Google's ephemeral
// session photo URLs. Serving a long-stale one is worse than re-fetching:
// addPlace marks the place in usePlaces' healingRef *before* trying to persist
// it, so when the expired URL fails to fetch, the self-heal that would have
// re-resolved a fresh photo is suppressed for the rest of the session and the
// place keeps a dead cover image. A TTL well inside the URL's life avoids that
// while still covering the case this cache is for — the same spot pressed
// twice in a row, which is what would otherwise bill twice.
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { at: number; value: Promise<PointLookup> }>();

export function lookupPoint(point: { lat: number; lng: number }): Promise<PointLookup> {
  const key = cacheKey(point);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  if (cached) cache.delete(key);

  const pending = Promise.all([reverseGeocode(point), nearbySearch(point)])
    .then(([address, nearby]): PointLookup => {
      // Only a real answer earns its place in the cache. Caching a failure
      // would make it permanent for that spot: the user waits for the map to
      // come alive, presses again, and gets the same stale "nothing here".
      if (nearby === null) {
        cache.delete(key);
        return { address, nearby: [], ok: false };
      }
      return { address, nearby, ok: true };
    })
    .catch(() => {
      cache.delete(key);
      return UNAVAILABLE;
    });

  // Bounded, but evict oldest-first rather than wiping the map: clearing it
  // wholesale would re-bill a Nearby Search for a spot already looked up,
  // which is exactly what this cache exists to prevent.
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  cache.set(key, { at: Date.now(), value: pending });
  return pending;
}
