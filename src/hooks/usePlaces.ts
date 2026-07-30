import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';
import { isEphemeralGoogleUrl, fetchFreshGooglePhotoUrl, persistGooglePhoto } from '../lib/googlePhotos';
import { removeStorageUrls } from '../lib/storage';
import type { Place, PlaceImage } from '../types';

export function usePlaces(tripId: string | undefined) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const healingRef = useRef<Set<string>>(new Set());
  // Realtime events arrive in bursts and each one triggers a refetch; without
  // a sequence guard the *last response to resolve* would win, even if it
  // carries an older DB snapshot than one that already rendered.
  const fetchSeqRef = useRef(0);
  // Current place ids, for deciding whether a join-table event is ours (those
  // tables carry no trip_id to filter on server-side).
  const placeIdsRef = useRef<Set<string>>(new Set());

  // Self-heal: a cover photo still pointing at Google's ephemeral session
  // URL has already expired (that URL's bytes can't be fetched anymore),
  // so re-resolve a fresh one via the place's google_place_id and persist
  // it to our own storage this time. One attempt per place per session.
  const selfHealCoverPhoto = useCallback(async (place: Place) => {
    if (!isEphemeralGoogleUrl(place.image_url) || !place.google_place_id) return;
    if (healingRef.current.has(place.id)) return;
    healingRef.current.add(place.id);

    const freshUrl = await fetchFreshGooglePhotoUrl(place.google_place_id);
    if (!freshUrl) return;
    const stableUrl = await persistGooglePhoto(place.trip_id, place.id, freshUrl);
    if (!stableUrl) return;

    const { data, error } = await supabase
      .from('places')
      .update({ image_url: stableUrl })
      .eq('id', place.id)
      .select()
      .single();
    if (!error && data) {
      setPlaces(prev => prev.map(p => p.id === place.id ? { ...p, image_url: data.image_url } : p));
    }
  }, []);

  const fetchPlaces = useCallback(async () => {
    if (!tripId) { setLoading(false); return; }
    const seq = ++fetchSeqRef.current;
    const { data, error } = await supabase
      .from('places')
      .select('*, place_tags(tag_id, tags(*)), place_images(*)')
      .eq('trip_id', tripId)
      // created_at tiebreaker: positions can collide (deletes never compact
      // them), and without it tied rows come back in unspecified order and
      // visibly swap between refetches.
      .order('position', { ascending: true })
      .order('created_at', { ascending: true });

    // A newer fetch was issued while this one was in flight — its response
    // supersedes this one no matter which resolves first.
    if (seq !== fetchSeqRef.current) return;

    if (error) {
      toast('Could not load places');
      setLoading(false);
      return;
    }

    const normalized = (data ?? []).map((p: Place & { place_tags?: Array<{ tags: unknown }>, place_images?: PlaceImage[] }) => ({
      ...p,
      tags: (p.place_tags ?? []).map((pt) => pt.tags),
      images: (p.place_images ?? []).sort((a, b) => a.position - b.position),
    }));
    placeIdsRef.current = new Set(normalized.map(p => p.id));
    setPlaces(normalized as Place[]);
    setLoading(false);
    (normalized as Place[]).forEach(p => { selfHealCoverPhoto(p); });
  }, [tripId, selfHealCoverPhoto]);

  useEffect(() => {
    if (!tripId) return;
    fetchPlaces();

    // place_tags/place_images have no trip_id column, so those events can't
    // be filtered server-side — check the payload's place_id against ours.
    // (Without these subscriptions, a collaborator's tag/photo edits never
    // showed up until some unrelated places-row change forced a refetch.)
    const onJoinTableChange = (payload: { new: unknown; old: unknown }) => {
      const rec = (payload.new ?? payload.old) as { place_id?: string } | null;
      if (rec?.place_id && placeIdsRef.current.has(rec.place_id)) fetchPlaces();
    };

    channelRef.current = supabase
      .channel(`places:${tripId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'places',
        filter: `trip_id=eq.${tripId}`,
      }, () => { fetchPlaces(); })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'place_tags',
      }, onJoinTableChange)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'place_images',
      }, onJoinTableChange)
      .subscribe();

    return () => {
      channelRef.current?.unsubscribe();
    };
  }, [tripId, fetchPlaces]);

  const addPlace = async (place: {
    name: string;
    address?: string;
    latitude: number;
    longitude: number;
    google_place_id?: string;
    image_url?: string;
    notes?: string;
  }) => {
    if (!tripId) return null;
    // max+1, not length: after any delete the positions have gaps, and
    // length would collide with an existing position.
    const nextPosition = places.reduce((max, p) => Math.max(max, p.position), -1) + 1;
    const { data, error } = await supabase
      .from('places')
      .insert({ ...place, trip_id: tripId, position: nextPosition })
      .select()
      .single();
    if (error || !data) {
      toast('Could not add place');
      return null;
    }
    placeIdsRef.current.add(data.id);
    setPlaces(prev => [...prev, { ...data, tags: [], images: [] }]);

    // The image_url passed in (if any) is a fresh but still-ephemeral
    // Google session URL — persist it to our own storage right away so
    // it doesn't just expire like the ones added before this existed.
    // Mark it as healing first: the insert's own realtime event triggers a
    // refetch whose self-heal pass would otherwise race this persist and
    // upload the photo a second time.
    if (data.image_url) {
      healingRef.current.add(data.id);
      persistGooglePhoto(tripId, data.id, data.image_url).then(async stableUrl => {
        if (!stableUrl) return;
        const { data: updated, error: updateError } = await supabase
          .from('places')
          .update({ image_url: stableUrl })
          .eq('id', data.id)
          .select()
          .single();
        if (!updateError && updated) {
          setPlaces(prev => prev.map(p => p.id === data.id ? { ...p, image_url: updated.image_url } : p));
        }
      });
    }

    return data;
  };

  const updatePlace = async (id: string, updates: Partial<Place>) => {
    // Optimistic: apply immediately; on failure refetch rather than revert —
    // a call-time snapshot could clobber fresher data a collaborator's edit
    // delivered while our write was in flight.
    setPlaces(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));

    const { data, error } = await supabase
      .from('places')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error || !data) {
      toast('Could not save changes');
      fetchPlaces();
      return null;
    }
    setPlaces(prev => prev.map(p => p.id === id ? { ...p, ...data } : p));
    return data;
  };

  const deletePlace = async (id: string) => {
    const place = places.find(p => p.id === id);
    const { error } = await supabase.from('places').delete().eq('id', id);
    if (error) {
      toast('Could not delete place');
      return;
    }
    placeIdsRef.current.delete(id);
    setPlaces(prev => prev.filter(p => p.id !== id));
    // The bucket is public — remove the actual files, not just the rows.
    if (place) {
      removeStorageUrls([place.image_url, ...(place.images ?? []).map(i => i.url)]);
    }
  };

  // Drag-to-reorder: apply the new order immediately; the whole order is
  // written atomically by an RPC (per-row updates could partially fail,
  // leaving server, client, and realtime with three different orders).
  const reorderPlaces = async (orderedIds: string[]) => {
    if (!tripId) return;
    const reordered = orderedIds
      .map((id, index) => {
        const place = places.find(p => p.id === id);
        return place ? { ...place, position: index } : null;
      })
      .filter((p): p is Place => p !== null);
    setPlaces(reordered);

    const { error } = await supabase.rpc('reorder_places', {
      p_trip_id: tripId,
      p_place_ids: orderedIds,
    });
    if (error) {
      toast('Could not save the new order');
      fetchPlaces();
    }
  };

  const toggleVisited = async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'planned' ? 'visited' : 'planned';
    const updates: Partial<Place> = {
      status: newStatus as Place['status'],
      visited_at: newStatus === 'visited' ? new Date().toISOString() : null,
    };
    return updatePlace(id, updates);
  };

  const setPlaceTags = async (placeId: string, tagIds: string[]) => {
    // Diff against current tags — avoids the destructive delete-all-then-insert
    const current = (places.find(p => p.id === placeId)?.tags ?? []).map(t => t.id);
    const toRemove = current.filter(id => !tagIds.includes(id));
    const toAdd = tagIds.filter(id => !current.includes(id));

    if (toRemove.length > 0) {
      const { error } = await supabase
        .from('place_tags')
        .delete()
        .eq('place_id', placeId)
        .in('tag_id', toRemove);
      // Refetch even on failure: the delete may have half-applied relative to
      // what the user saw, and nothing else re-syncs this session.
      if (error) { toast('Could not update tags'); fetchPlaces(); return; }
    }
    if (toAdd.length > 0) {
      const { error } = await supabase
        .from('place_tags')
        .insert(toAdd.map(tag_id => ({ place_id: placeId, tag_id })));
      if (error) { toast('Could not update tags'); fetchPlaces(); return; }
    }
    fetchPlaces();
  };

  const addPlaceImage = async (placeId: string, url: string, caption?: string) => {
    const existing = places.find(p => p.id === placeId);
    const position = (existing?.images?.length ?? 0);
    const { data, error } = await supabase
      .from('place_images')
      .insert({ place_id: placeId, url, caption: caption || null, position })
      .select()
      .single();
    if (error || !data) {
      toast('Could not add photo');
      return null;
    }
    setPlaces(prev => prev.map(p =>
      p.id === placeId ? { ...p, images: [...(p.images ?? []), data] } : p
    ));
    return data as PlaceImage;
  };

  // Uploads to the place-images bucket under {trip_id}/{place_id}/... — the
  // storage RLS policy checks trip membership from that first path segment
  const uploadPlaceImage = async (placeId: string, file: File) => {
    const place = places.find(p => p.id === placeId);
    if (!place) return null;
    const ext = file.name.split('.').pop() || 'jpg';
    const path = `${place.trip_id}/${placeId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('place-images')
      .upload(path, file, { contentType: file.type || 'image/jpeg' });
    if (uploadError) {
      toast('Could not upload photo');
      return null;
    }

    const { data } = supabase.storage.from('place-images').getPublicUrl(path);
    return addPlaceImage(placeId, data.publicUrl);
  };

  const removePlaceImage = async (placeId: string, imageId: string) => {
    const image = places.find(p => p.id === placeId)?.images?.find(i => i.id === imageId);
    const { error } = await supabase.from('place_images').delete().eq('id', imageId);
    if (error) {
      toast('Could not remove photo');
      return;
    }
    setPlaces(prev => prev.map(p =>
      p.id === placeId ? { ...p, images: (p.images ?? []).filter(i => i.id !== imageId) } : p
    ));
    // The bucket is public — a "removed" photo must stop being fetchable.
    if (image) removeStorageUrls([image.url]);
  };

  return { places, loading, addPlace, updatePlace, deletePlace, toggleVisited, setPlaceTags, addPlaceImage, uploadPlaceImage, removePlaceImage, reorderPlaces };
}
