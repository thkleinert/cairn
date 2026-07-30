import { supabase } from './supabase';

// Google's Maps JS SDK photo URLs (PhotoService.GetPhoto, embedding a
// session token) are only valid for the browser session that created
// them — they are not meant to be stored long-term. Our own Supabase
// Storage URLs are the only stable kind, so anything still pointing at
// Google's host needs re-resolving and persisting.
export function isEphemeralGoogleUrl(url?: string | null): boolean {
  return !!url && url.includes('maps.googleapis.com');
}

let placesService: google.maps.places.PlacesService | null = null;

function getPlacesService(): google.maps.places.PlacesService | null {
  if (!window.google?.maps?.places) return null;
  if (!placesService) {
    // getDetails only needs a constructor target, not a rendered map/div
    placesService = new google.maps.places.PlacesService(document.createElement('div'));
  }
  return placesService;
}

// Resolves false if the SDK never shows up (ad-blocker, network failure) —
// an unbounded wait would leave callers hung on a forever-pending promise
// and accumulate one listener per attempted photo heal.
function waitForGoogleMaps(timeoutMs = 15000): Promise<boolean> {
  if (window.google?.maps?.places) return Promise.resolve(true);
  return new Promise(resolve => {
    const onLoad = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => {
      window.removeEventListener('gmaps-loaded', onLoad);
      resolve(false);
    }, timeoutMs);
    window.addEventListener('gmaps-loaded', onLoad, { once: true });
  });
}

// Re-resolves a fresh (still-temporary) photo URL for a place via its
// google_place_id — used to self-heal places whose stored URL already
// expired, since a dead URL's bytes can no longer be fetched directly.
export async function fetchFreshGooglePhotoUrl(googlePlaceId: string): Promise<string | null> {
  if (!(await waitForGoogleMaps())) return null;
  const service = getPlacesService();
  if (!service) return null;
  return new Promise(resolve => {
    service.getDetails({ placeId: googlePlaceId, fields: ['photos'] }, (result, status) => {
      if (status === google.maps.places.PlacesServiceStatus.OK && result?.photos?.[0]) {
        resolve(result.photos[0].getUrl({ maxWidth: 800 }));
      } else {
        resolve(null);
      }
    });
  });
}

// Downloads a (temporary) photo URL and re-uploads it into our own
// place-images bucket, returning a stable public URL — or null if the
// download/upload failed, in which case the caller should keep whatever
// URL it already had rather than losing the photo entirely.
//
// This has to go through an Edge Function, not a direct browser fetch —
// Google's photo CDN sends no CORS headers, so fetch(tempUrl) fails
// outright from a browser (confirmed: "TypeError: Failed to fetch").
// The function does the same fetch server-side, where CORS doesn't
// apply, and uploads using the caller's own JWT so the usual storage
// RLS (trip membership) still applies.
export async function persistGooglePhoto(tripId: string, placeId: string, tempUrl: string): Promise<string | null> {
  const path = `${tripId}/${placeId}/cover-${Date.now()}.jpg`;
  try {
    const { data, error } = await supabase.functions.invoke<{ url?: string; error?: string }>('persist-photo', {
      body: { photoUrl: tempUrl, path },
    });
    if (error || !data?.url) return null;
    return data.url;
  } catch {
    return null;
  }
}
