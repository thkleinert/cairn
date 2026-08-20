import type { Place } from '../types';

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
 * Does this address describe a specific venue rather than a whole settlement?
 *
 * "Bangkok, Thailand" is somewhere you can be inside. "Salvatorstraße 37-33,
 * 6912 Hörbranz, Österreich" is a front door. A house number or postcode, or
 * three or more comma-separated parts, reliably separates the two without
 * knowing the language or the country's addressing conventions.
 *
 * It is a heuristic and it does misfire: a town whose address carries a
 * postcode ("73150 Val-d'Isère, Frankreich") reads as a venue. That only
 * matters if such a town also sits within ANCHOR_MAX_KM of a settlement, and
 * it is why nothing already arranged is ever moved without being asked.
 */
export function looksSpecific(address: string | null | undefined): boolean {
  if (!address) return false;
  if (/\d/.test(address)) return true;
  return (address.match(/,/g)?.length ?? 0) >= 2;
}

/** A place broad enough to contain others: settlement-shaped, and not itself anchored. */
function couldContain(place: Place): boolean {
  return !place.parent_place_id && !looksSpecific(place.address);
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
 * The threshold is not a guess. Measured against a real account: the one
 * genuine containment (a café and the city it is in) sits at 4.9km, and the
 * nearest false pair — a village near a city it is not part of — at 38.2km.
 * Fifteen other pairs run from 44km to 158km. Nothing at all falls between 5
 * and 38, so any threshold in that gap separates them cleanly; 15km is picked
 * to be city-scale rather than tuned to the sample.
 *
 * Deliberately returns nothing rather than a best guess when the nearest
 * settlement is far away: a trip whose café is in a town nobody marked has no
 * right answer, and inventing one is worse than leaving it at the top level.
 */
export function nearestParent(
  candidate: { latitude: number; longitude: number; address?: string | null; id?: string },
  places: Place[],
  maxKm = ANCHOR_MAX_KM,
): Place | null {
  // Only a venue can be inside something. A settlement stays where it is.
  if (!looksSpecific(candidate.address)) return null;

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
