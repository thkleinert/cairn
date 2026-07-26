import { supabase } from './supabase';
import { toast } from './toast';
import type { Trip } from '../types';

// Trip mutations as plain functions: TripView needs update/delete/upload-cover
// but no list state — previously it instantiated a second useTrips just for
// these, refetching the whole trip list on every trip open and stranding
// updates in state nobody rendered.

export async function updateTrip(id: string, updates: Partial<Trip>): Promise<Trip | null> {
  const { data, error } = await supabase
    .from('trips')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error || !data) {
    toast('Could not save trip');
    return null;
  }
  return data;
}

export async function deleteTrip(id: string): Promise<boolean> {
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
