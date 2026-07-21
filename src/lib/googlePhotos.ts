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

function waitForGoogleMaps(): Promise<void> {
  if (window.google?.maps?.places) return Promise.resolve();
  return new Promise(resolve => {
    window.addEventListener('gmaps-loaded', () => resolve(), { once: true });
  });
}

// Re-resolves a fresh (still-temporary) photo URL for a place via its
// google_place_id — used to self-heal places whose stored URL already
// expired, since a dead URL's bytes can no longer be fetched directly.
export async function fetchFreshGooglePhotoUrl(googlePlaceId: string): Promise<string | null> {
  await waitForGoogleMaps();
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
export async function persistGooglePhoto(tripId: string, placeId: string, tempUrl: string): Promise<string | null> {
  try {
    const res = await fetch(tempUrl);
    if (!res.ok) return null;
    const blob = await res.blob();
    const ext = blob.type.split('/')[1] || 'jpg';
    const path = `${tripId}/${placeId}/cover-${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from('place-images')
      .upload(path, blob, { contentType: blob.type || 'image/jpeg' });
    if (error) return null;
    const { data } = supabase.storage.from('place-images').getPublicUrl(path);
    return data.publicUrl;
  } catch {
    return null;
  }
}
