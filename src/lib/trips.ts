import { supabase } from './supabase';
import { toast } from './toast';
import { removeStorageUrls, removeTripStorage } from './storage';
import type { Trip } from '../types';

// Trip mutations as plain functions: TripView needs update/delete/upload-cover
// but no list state — previously it instantiated a second useTrips just for
// these, refetching the whole trip list on every trip open and stranding
// updates in state nobody rendered.

// share_token is deliberately not SELECT-granted to members (it's a bearer
// credential; the owner reads it via the get_share_token RPC), so trips
// queries must name their columns — select('*') fails on the column grant.
export const TRIP_COLUMNS =
  'id, name, description, start_date, end_date, cover_image_url, owner_id, created_at, updated_at';

export async function updateTrip(id: string, updates: Partial<Trip>): Promise<Trip | null> {
  const { data, error } = await supabase
    .from('trips')
    .update(updates)
    .eq('id', id)
    .select(TRIP_COLUMNS)
    .single();
  if (error || !data) {
    toast('Could not save trip');
    return null;
  }
  return data as Trip;
}

export async function deleteTrip(id: string): Promise<boolean> {
  // Storage first: the delete policy needs the caller's (about-to-vanish)
  // membership. If the row delete then fails, files are gone but the trip
  // survives — acceptable for an explicit delete, and photos re-upload.
  await removeTripStorage(id);
  const { error } = await supabase.from('trips').delete().eq('id', id);
  if (error) {
    toast('Could not delete trip');
    return false;
  }
  return true;
}

// Reuses the place-images bucket — its RLS only checks trip membership via the
// first path segment, which a bare {trip_id}/cover-... path satisfies just as
// well as a place's own {trip_id}/{place_id}/... path
export async function uploadTripCover(tripId: string, file: File): Promise<string | null> {
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `${tripId}/cover-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { error } = await supabase.storage
    .from('place-images')
    .upload(path, file, { contentType: file.type || 'image/jpeg' });
  if (error) {
    toast('Could not upload cover photo');
    return null;
  }
  const { data } = supabase.storage.from('place-images').getPublicUrl(path);
  return data.publicUrl;
}

// Swapping or removing a cover orphans the old file in the public bucket —
// drop it (only if it was one of ours, not a pasted external URL).
export function cleanupReplacedCover(oldUrl: string | null | undefined): void {
  removeStorageUrls([oldUrl]);
}
