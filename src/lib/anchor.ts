import type { Place, PlaceKind } from '../types';

// Working out which place sits inside which, from what we already store.
//
// The obvious approach — look for a place's name inside another's address —
// does not survive contact with real data. A café in Bangkok has the address
// "Si Lom, Khet Bang Rak, Krung Thep Maha Nakhon 10500, Thailand": the Thai
// name for the city, which shares not one character with the marked place
// called "Bangkok". Across 24 real places that test found a single pair, and
// got it wrong (a national park matched the province it is named after, 78km
// from the city of the same name).
//
// So this uses two signals that are language-independent and already on the
// row: the SHAPE of the address, which says whether a place is a settlement or
// a venue, and the distance between them.

/** Kilometres. Chosen from real data — see the note on nearestParent. */
export const ANCHOR_MAX_KM = 15;

/**
 * Google's own answer to "what kind of thing is this?", when we have it.
 *
 * This is the signal worth trusting, and it is free: `types` rides along with
 * the Place Details call the search field already makes and with every nearby
 * result, so nothing here adds a request or moves a SKU.
 *
 * Returns null when the types say nothing either way, leaving the address
 * heuristic below to answer.
 */
const BROAD_TYPES = new Set([
  // Settlements and the administrative shells around them.
  'locality', 'sublocality', 'sublocality_level_1', 'neighborhood',
  'administrative_area_level_1', 'administrative_area_level_2',
  'administrative_area_level_3', 'administrative_area_level_4',
  'administrative_area_level_5',
  'country', 'continent', 'colloquial_area', 'postal_town', 'political',
  // Things you go to and move around inside, which this app calls stops even
  // though Google files them as establishments: an island, a lake, a massif,
  // a national park.
  'natural_feature', 'archipelago', 'park',
]);

export function specificFromTypes(types: string[] | undefined): boolean | null {
  if (!types || types.length === 0) return null;
  // Broad wins over establishment, because Google marks a national park as
  // both. Reading `establishment` first filed Khao Sok inside Surat Thani.
  if (types.some(t => BROAD_TYPES.has(t))) return false;
  if (types.includes('establishment') || types.includes('point_of_interest')) return true;
  return null;
}

/**
 * Does this address describe a specific venue rather than a whole settlement?
 *
 * The fallback for when Google's types are absent — a place typed in by hand,
 * or an existing row, which is all the "looks like it's in X" suggestion ever
 * has to work with.
 *
 * Only the FIRST comma-separated component is examined, because that is the
 * only part that describes the thing itself; everything after it is the
 * administrative trail, and in most of the world that trail contains a
 * postcode. Testing the whole string called every one of these a venue:
 *
 *     Les Chapieux, 73700 Bourg-Saint-Maurice, Frankreich   — a hamlet
 *     Lac du Mont Cenis, 73480 Val-Cenis, Frankreich        — a lake
 *     Cornettes de Bise, 74360 La Chapelle-d'Abondance      — a mountain
 *     Ko Lanta, Ko Lanta District, Krabi 81150, Thailand    — an island
 *
 * All four are real rows in a real trip, and the first two sit close enough to
 * a marked stop to have been silently filed inside one. The old rule also
 * counted commas — three or more parts meant a venue — which by itself made a
 * venue of "Cambridge, MA, USA" and of every city Google writes with a region.
 * Both tests are gone; what remains is a house number in the name part.
 */
export function looksSpecific(address: string | null | undefined): boolean {
  if (!address) return false;
  const head = address.split(',')[0] ?? '';
  // A leading postcode is how a town writes itself in much of Europe —
  // "6060 Hall in Tirol" — and it is the whole address, not a number within
  // one. Dropping it is what separates that from "Salvatorstraße 37-33",
  // where the digits sit after a street name.
  return /\d/.test(head.replace(/^\s*\d{4,6}\s+/, ''));
}

/**
 * A place broad enough to contain others.
 *
 * This asks the row what it is rather than guessing from its address. The
 * guess is still made — once, when a place is created (see kindFor) — but it
 * is a default the user can correct, not a fact re-derived on every render.
 */
function couldContain(place: Place): boolean {
  return place.kind === 'stop' && !place.parent_place_id;
}

/** Great-circle distance in kilometres. */
export function distanceKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The place `candidate` most likely contains, or null if none is convincing.
 *
 * The threshold is city-scale, and it is only half of the decision. An earlier
 * version of this comment claimed the sample had a clean gap between 5km and
 * 38km that any threshold in between would separate. That was measured over
 * pairs the OLD classifier had already called venues, and it was wrong on its
 * own data: a hamlet 8.2km from a lake and a lake 10.5km from a village both
 * sit inside the supposed gap, and both were being filed as locations.
 *
 * Distance cannot fix that, because both really are close. What fixes it is
 * not asking the distance question at all unless the thing is actually a
 * venue — which is why the classifier above got stricter and why Google's own
 * types are preferred over it whenever they exist.
 *
 * Deliberately returns nothing rather than a best guess when the nearest
 * settlement is far away: a trip whose café is in a town nobody marked has no
 * right answer, and inventing one is worse than leaving it at the top level.
 */
export function nearestParent(
  candidate: {
    latitude: number; longitude: number;
    address?: string | null; id?: string; types?: string[];
  },
  places: Place[],
  maxKm = ANCHOR_MAX_KM,
): Place | null {
  // Whether this LOOKS like a venue, from its address — never from its stored
  // kind. Preferring the stored kind killed the feature outright: the only
  // caller that passes a stored place is the "looks like it's in X" suggestion,
  // and places_anchored_is_location guarantees every un-anchored place is a
  // 'stop', so the kind branch answered "not a venue" every single time and the
  // suggestion could not render at all.
  //
  // The address is the right signal here precisely because it disagrees with
  // the stored kind. A café filed as a stop is exactly the case worth offering
  // to fix; asking the row what it already is can only ever agree with itself.
  // Google's types when the caller has them — a place being created — and the
  // address otherwise, which is all an existing row carries.
  const specific = specificFromTypes(candidate.types) ?? looksSpecific(candidate.address);
  if (!specific) return null;

  let best: Place | null = null;
  let bestKm = Infinity;
  for (const place of places) {
    if (place.id === candidate.id) continue;
    if (!couldContain(place)) continue;
    const km = distanceKm(candidate, place);
    if (km < bestKm) { bestKm = km; best = place; }
  }
  return bestKm <= maxKm ? best : null;
}

/**
 * What a place being created should be, and what it should sit inside.
 *
 * A place only becomes a location when there is somewhere concrete to put it.
 * Neither classifier is trusted on its own: a misread would file a town as a
 * location with no parent — top-level in the list but hidden whenever the map
 * is showing stops only, which is a confusing thing to happen to a town you
 * just added.
 *
 * Requiring a nearby stop ties the weaker signal to the stronger one. Nothing
 * is ever created as an orphan location, so "stop" keeps meaning "visible and
 * top level", exactly as every place behaves today.
 */
export function kindFor(
  candidate: {
    latitude: number; longitude: number;
    address?: string | null; types?: string[];
  },
  places: Place[],
): { kind: PlaceKind; parentId: string | null } {
  const parent = nearestParent(candidate, places);
  return parent
    ? { kind: 'location', parentId: parent.id }
    : { kind: 'stop', parentId: null };
}
