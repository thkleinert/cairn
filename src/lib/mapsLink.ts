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
  /** The coordinates are a viewport centre, not the place — see MAX_MATCH_KM. */
  fromCamera: boolean;
  /** `name` is Google's own formatted address, not a bare display name. */
  nameIsAddress: boolean;
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

/**
 * The same check when all we have is where the map was pointing.
 *
 * A camera position is a viewport centre at whatever zoom the sharer was at,
 * so for anything large it is legitimately kilometres from the place's own
 * centroid — Khao Sok shared at zoom 10 lands well outside five. Holding a
 * camera to the pin's tolerance rejected exactly the matches most worth
 * having, and dropped them onto the map centre instead. Still tight enough to
 * catch the failure this is for, which is a different city.
 */
const MAX_CAMERA_MATCH_KM = 25;

function toPlace(
  result: google.maps.places.PlaceResult,
  location: google.maps.LatLng,
  known: { name: string; placeId?: string },
): LinkedPlace | null {
  const name = result.name ?? known.name;
  // Nothing to show in a list, and nothing the confirm row could label.
  if (!name) return null;
  return {
    name,
    address: result.formatted_address ?? '',
    latitude: location.lat(),
    longitude: location.lng(),
    // Falls back to the id we already had, because PlacesService returns only
    // the fields that were asked for and `place_id` is not among
    // DETAIL_FIELDS on the getDetails path. Losing it is not cosmetic: the
    // cover-photo self-heal in usePlaces gives up on any place without a
    // google_place_id, so a photo that failed to persist could never be
    // re-resolved and the place would keep a dead image for good.
    google_place_id: result.place_id ?? known.placeId,
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
      resolve(toPlace(result, location, { name: '', placeId }));
    });
  });
}

/**
 * No place id in the link — the common case, since most share links identify
 * the place by a hex feature id the Places API won't accept. What they do
 * carry is the name and the pin, which together are enough for Find Place.
 *
 * The pin is optional in exactly one case. A bare display name without one is
 * not something this can safely act on — "Central Park" and "Hauptbahnhof"
 * exist in dozens of cities, Find Place answers with the most famous, and
 * there is nothing left to check that answer against. A formatted address is
 * different: "…, Mueang Samut Songkhram District, Samut Songkhram 75000,
 * Thailand" names exactly one place on earth and disambiguates itself. That
 * is what the share sheet's `?q=` form carries, and it carries no coordinates
 * at all, so requiring a pin here refused ordinary shared links outright.
 *
 * Cost note: this is a billed Find Place call, not a free Autocomplete
 * session. It is one per link the user actually pastes and never speculative,
 * which puts it in the same bracket as the map's long-press lookup.
 */
async function findByName(
  name: string,
  point: { lat: number; lng: number } | null,
  fromCamera: boolean,
): Promise<LinkedPlace | null> {
  const service = await placesService();
  if (!service) return null;
  const request: google.maps.places.FindPlaceFromQueryRequest = {
    query: name,
    fields: [...DETAIL_FIELDS, 'place_id'],
    // A bias rather than a bounds restriction: the pin is Google's own, so the
    // place is right there, but a hard restriction would return nothing at all
    // for anything whose centroid falls just outside.
    //
    // Scaled with the tolerance below, not fixed. Leaving a 1km bias against a
    // 25km camera allowance made the guard hollow at metro scale: the bias
    // never took, Find Place answered unbiased, and a same-named station 20km
    // away passed the check with a confident name and photo.
  };
  if (point) {
    request.locationBias = {
      center: point,
      radius: (fromCamera ? MAX_CAMERA_MATCH_KM : MAX_MATCH_KM) * 1000,
    };
  }

  return new Promise(resolve => {
    service.findPlaceFromQuery(request, (results, status) => {
      const result = results?.[0];
      const location = result?.geometry?.location;
      if (status !== google.maps.places.PlacesServiceStatus.OK || !result || !location) {
        resolve(null);
        return;
      }
      const place = toPlace(result, location, { name });
      if (!place) {
        resolve(null);
        return;
      }
      // Only checkable when the link gave us somewhere to check against. With
      // no pin this is an address query, which carries its own disambiguation
      // — there is no second "…, Samut Songkhram 75000, Thailand" elsewhere.
      if (point) {
        const away = distanceKm(
          { latitude: place.latitude, longitude: place.longitude },
          { latitude: point.lat, longitude: point.lng },
        );
        // Matched something, but somewhere else entirely — the same name in
        // another city. The caller falls back to the link's own name and pin,
        // which are never wrong, just thinner.
        if (away > (fromCamera ? MAX_CAMERA_MATCH_KM : MAX_MATCH_KM)) {
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
 * reverse-geocoded address of a dropped pin. What comes back as an error is a
 * link with nothing identifying in it — a directions route, a bare search —
 * or one that names a place without saying where it is, which is the one case
 * where guessing would be worse than declining.
 */
const UNREADABLE = 'Could not read that link';

export async function resolveMapsLink(url: string): Promise<LinkResult> {
  let link: LinkIdentity;
  try {
    const { data, error } = await supabase.functions.invoke<LinkIdentity & { error?: string }>(
      'resolve-maps-url',
      { body: { url } },
    );
    // With a fallback, because invoke reports a network failure or an
    // undeployed function as an error in the tuple rather than throwing — the
    // catch below never sees those, and their SDK wording ("Failed to send a
    // request to the Edge Function") is not something to show a user.
    if (error) return { ok: false, reason: await edgeFunctionMessage(error, UNREADABLE) };
    if (!data || data.error) return { ok: false, reason: data?.error ?? UNREADABLE };
    link = data;
  } catch {
    return { ok: false, reason: UNREADABLE };
  }

  const point =
    link.latitude !== null && link.longitude !== null
      ? { lat: link.latitude, lng: link.longitude }
      : null;

  if (link.placeId) {
    const place = await detailsFor(link.placeId);
    if (place) return { ok: true, place };
  }

  // A pin, or a name specific enough not to need one (see findByName).
  if (link.name && (point || link.nameIsAddress)) {
    const place = await findByName(link.name, point, link.fromCamera);
    if (place) return { ok: true, place };
    // Nothing to fall back to without coordinates — a name alone can't be a
    // marker. Rare: it means Google could not find an address Google wrote.
    if (!point) return { ok: false, reason: UNREADABLE };
    // Deliberately no address, even for a camera position where one would say
    // something useful about where the marker is going. Filling it in reads as
    // a free improvement and is not: with no types and no spanKm, `address` is
    // the only signal kindFor has left, and a street-shaped one makes
    // looksSpecific true — so a national park shared zoomed out was filed as a
    // spot inside whichever town lay within 15km, which is worse than the
    // vagueness it was trying to fix. An empty address keeps both fallbacks
    // classifying alike, and both land a stop.
    return {
      ok: true,
      place: {
        name: link.name,
        address: '',
        latitude: point.lat,
        longitude: point.lng,
        // Kept when we had one: getDetails can fail transiently, and the
        // id is the only key later enrichment has.
        google_place_id: link.placeId ?? undefined,
      },
    };
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

  return { ok: false, reason: UNREADABLE };
}
