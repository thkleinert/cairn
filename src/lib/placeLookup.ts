import type { NearbyPlace, PointLookup } from '../types';

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

const EMPTY: PointLookup = { address: null, nearby: [] };

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

let services: { places: google.maps.places.PlacesService; geocoder: google.maps.Geocoder } | null = null;

async function getServices() {
  if (services) return services;
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

function nearbySearch(point: { lat: number; lng: number }): Promise<NearbyPlace[]> {
  return getServices().then(svc => {
    if (!svc) return [];
    return new Promise<NearbyPlace[]>(resolve => {
      svc.places.nearbySearch(
        { location: point, radius: NEARBY_RADIUS_M },
        (results, status) => {
          // ZERO_RESULTS is an ordinary outcome for open countryside, not a
          // failure — an empty list is the correct answer there.
          if (status !== google.maps.places.PlacesServiceStatus.OK || !results) {
            resolve([]);
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

const cache = new Map<string, Promise<PointLookup>>();

export function lookupPoint(point: { lat: number; lng: number }): Promise<PointLookup> {
  const key = cacheKey(point);
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = Promise.all([reverseGeocode(point), nearbySearch(point)])
    .then(([address, nearby]) => ({ address, nearby }))
    .catch(() => {
      // A rejected entry must not be served to every later press of this spot.
      cache.delete(key);
      return EMPTY;
    });

  // Bounded: a long session panning around a city shouldn't grow this forever.
  if (cache.size > 50) cache.clear();
  cache.set(key, pending);
  return pending;
}
