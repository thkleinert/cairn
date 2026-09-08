import { supabase, edgeFunctionMessage } from './supabase';
import { placesService, reverseGeocode } from './placeLookup';
import { spanFromViewport, distanceKm } from './anchor';

// Pasting a Google Maps link into the search field.
//
// The point is to let someone shop for a place where the reviews and photos
// are — Google Maps — and land it in a trip without retyping the name and
// hoping autocomplete picks the same one. On iOS this is the whole of what is
// possible: WebKit has never implemented the Web Share Target API, so an
// installed PWA cannot appear in the system share sheet. Share → Copy Link →
// paste is the flow that exists, and the search field is already the right
// place for it — it is focused and waiting, and iOS offers "Paste" on the
// keyboard bar the moment it opens with a fresh clipboard.
//
// Two steps, because neither can do the other's job: the edge function
// expands the shortlink (impossible in the browser — Google's shortener sends
// no CORS headers), and Google's own SDK turns the identity it finds into the
// full record, with the photo, types and viewport that every other place in
// the app carries.

export interface LinkedPlace {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  google_place_id?: string;
  image_url?: string;
  types?: string[];
  spanKm?: number;
}

export type LinkResult =
  | { ok: true; place: LinkedPlace }
  | { ok: false; reason: string };

interface LinkIdentity {
  placeId: string | null;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
}

// Matches what Google actually hands out: maps.app.goo.gl from the mobile
// apps' share sheet, the legacy goo.gl/maps, and a /maps path on any Google
// country domain for a link copied from the desktop address bar.
//
// Applied to the whole field value rather than tested against it, because
// "Copy Link" is not the only route in — sharing to Notes or Messages first
// yields "Café Central\nhttps://maps.app.goo.gl/…", and that text pasted into
// an input arrives as one line with the URL somewhere in the middle.
const MAPS_URL =
  /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:[a-z0-9-]+\.)*google\.[a-z]{2,3}(?:\.[a-z]{2,3})?\/maps)\S*/i;

export function extractMapsUrl(text: string): string | null {
  const match = text.match(MAPS_URL);
  if (!match) return null;
  // Trailing sentence punctuation from surrounding prose. Deliberately not
  // '!', which is structural in a Maps URL — the coordinates live in a
  // "!8m2!3d48.2!4d16.3" blob that very often ends the whole thing.
  const url = match[0].replace(/[.,;:)\]}'"]+$/, '');
  return url.replace(/^http:/i, 'https:');
}

const DETAIL_FIELDS = ['name', 'formatted_address', 'geometry', 'photos', 'types'];

/**
 * How far the place Google matched may sit from the one the link pinned.
 *
 * Generous on purpose: this is not an accuracy check but a wrong-continent
 * check. A name like "Central Park" or "Hauptbahnhof" exists in dozens of
 * cities, and Find Place will happily return the most famous one if the bias
 * doesn't take. What it is not allowed to do is reject a legitimately large
 * place whose centroid sits some way from the pin — so a few kilometres of
 * slack, not a few hundred metres.
 */
const MAX_MATCH_KM = 5;

function toPlace(
  result: google.maps.places.PlaceResult,
  location: google.maps.LatLng,
  fallbackName: string,
): LinkedPlace {
  return {
    name: result.name ?? fallbackName,
    address: result.formatted_address ?? '',
    latitude: location.lat(),
    longitude: location.lng(),
    google_place_id: result.place_id,
    // Ephemeral session URL, same as the search field's — addPlace re-hosts
    // it to our own storage right after the insert.
    image_url: result.photos?.[0]?.getUrl({ maxWidth: 800 }),
    types: result.types,
    spanKm: spanFromViewport(result.geometry?.viewport),
  };
}

// The link carried a real place id, which is the happy path: one Details
// call, exactly what picking a search suggestion costs.
async function detailsFor(placeId: string): Promise<LinkedPlace | null> {
  const service = await placesService();
  if (!service) return null;
  return new Promise(resolve => {
    service.getDetails({ placeId, fields: DETAIL_FIELDS }, (result, status) => {
      const location = result?.geometry?.location;
      if (status !== google.maps.places.PlacesServiceStatus.OK || !result || !location) {
        resolve(null);
        return;
      }
      resolve(toPlace(result, location, ''));
    });
  });
}

/**
 * No place id in the link — the common case, since most share links identify
 * the place by a hex feature id the Places API won't accept. What they do
 * carry is the name and the pin, which together are enough for Find Place.
 *
 * Cost note: this is a billed Find Place call, not a free Autocomplete
 * session. It is one per link the user actually pastes and never speculative,
 * which puts it in the same bracket as the map's long-press lookup.
 */
async function findByName(
  name: string,
  point: { lat: number; lng: number } | null,
): Promise<LinkedPlace | null> {
  const service = await placesService();
  if (!service) return null;
  const request: google.maps.places.FindPlaceFromQueryRequest = {
    query: name,
    fields: [...DETAIL_FIELDS, 'place_id'],
  };
  // A tight bias rather than a bounds restriction: the pin is Google's own,
  // so the place is right there, but a hard restriction would return nothing
  // at all for anything whose centroid falls just outside.
  if (point) request.locationBias = { center: point, radius: 1000 };

  return new Promise(resolve => {
    service.findPlaceFromQuery(request, (results, status) => {
      const result = results?.[0];
      const location = result?.geometry?.location;
      if (status !== google.maps.places.PlacesServiceStatus.OK || !result || !location) {
        resolve(null);
        return;
      }
      const place = toPlace(result, location, name);
      if (point) {
        const away = distanceKm(
          { latitude: place.latitude, longitude: place.longitude },
          { latitude: point.lat, longitude: point.lng },
        );
        // Matched something, but somewhere else entirely — the same name in
        // another city. The caller falls back to the link's own name and pin,
        // which are never wrong, just thinner.
        if (away > MAX_MATCH_KM) {
          resolve(null);
          return;
        }
      }
      resolve(place);
    });
  });
}

/** Everything before the first comma — "Salvatorstraße 37, 6060 Hall in Tirol". */
function addressHead(address: string): string {
  return (address.split(',')[0] ?? '').trim();
}

/**
 * A pasted Google Maps link, resolved as far as it can be.
 *
 * Degrades one step at a time rather than failing outright, because each
 * fallback is still a place worth adding: a full Google record if we can get
 * one, otherwise the link's own name and pin as a custom place, otherwise the
 * reverse-geocoded address of a dropped pin. Only a link with nothing
 * identifying in it — a directions route, a bare search — comes back as an
 * error.
 */
export async function resolveMapsLink(url: string): Promise<LinkResult> {
  let link: LinkIdentity;
  try {
    const { data, error } = await supabase.functions.invoke<LinkIdentity & { error?: string }>(
      'resolve-maps-url',
      { body: { url } },
    );
    if (error) return { ok: false, reason: await edgeFunctionMessage(error) };
    if (!data || data.error) return { ok: false, reason: data?.error ?? 'Could not read that link' };
    link = data;
  } catch {
    return { ok: false, reason: 'Could not read that link' };
  }

  const point =
    link.latitude !== null && link.longitude !== null
      ? { lat: link.latitude, lng: link.longitude }
      : null;

  if (link.placeId) {
    const place = await detailsFor(link.placeId);
    if (place) return { ok: true, place };
  }

  if (link.name) {
    const place = await findByName(link.name, point);
    if (place) return { ok: true, place };
    if (point) {
      return {
        ok: true,
        place: { name: link.name, address: '', latitude: point.lat, longitude: point.lng },
      };
    }
  }

  if (point) {
    // A dropped pin: Maps wrote the coordinates where the name would go, so
    // the link has no name to offer. An address is a far better thing to see
    // in a trip list than "40°42'46.1"N", and the geocode is free.
    const address = await reverseGeocode(point);
    return {
      ok: true,
      place: {
        name: addressHead(address ?? '') || `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`,
        address: address ?? '',
        latitude: point.lat,
        longitude: point.lng,
      },
    };
  }

  return { ok: false, reason: 'Could not read that link' };
}
