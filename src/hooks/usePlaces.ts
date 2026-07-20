import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';
import type { Place, PlaceImage } from '../types';

export function usePlaces(tripId: string | undefined) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const fetchPlaces = useCallback(async () => {
    if (!tripId) { setLoading(false); return; }
    const { data, error } = await supabase
      .from('places')
      .select('*, place_tags(tag_id, tags(*)), place_images(*)')
      .eq('trip_id', tripId)
      .order('position', { ascending: true });

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
    setPlaces(normalized as Place[]);
    setLoading(false);
  }, [tripId]);

  useEffect(() => {
    if (!tripId) return;
    fetchPlaces();

    channelRef.current = supabase
      .channel(`places:${tripId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'places',
        filter: `trip_id=eq.${tripId}`,
      }, () => { fetchPlaces(); })
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
    source_url?: string;
  }) => {
    if (!tripId) return null;
    const { data, error } = await supabase
      .from('places')
      .insert({ ...place, trip_id: tripId, position: places.length })
      .select()
      .single();
    if (error || !data) {
      toast('Could not add place');
      return null;
    }
    setPlaces(prev => [...prev, { ...data, tags: [], images: [] }]);
    return data;
  };

  const updatePlace = async (id: string, updates: Partial<Place>) => {
    // Optimistic: apply immediately, revert on failure
    const before = places.find(p => p.id === id);
    setPlaces(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));

    const { data, error } = await supabase
      .from('places')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error || !data) {
      if (before) setPlaces(prev => prev.map(p => p.id === id ? before : p));
      toast('Could not save changes');
      return null;
    }
    setPlaces(prev => prev.map(p => p.id === id ? { ...p, ...data } : p));
    return data;
  };

  const deletePlace = async (id: string) => {
    const { error } = await supabase.from('places').delete().eq('id', id);
    if (error) {
      toast('Could not delete place');
      return;
    }
    setPlaces(prev => prev.filter(p => p.id !== id));
  };

  // Drag-to-reorder: apply the new order immediately, revert everything
  // on failure (any partial write would otherwise leave positions mixed)
  const reorderPlaces = async (orderedIds: string[]) => {
    const before = places;
    const reordered = orderedIds
      .map((id, index) => {
        const place = places.find(p => p.id === id);
        return place ? { ...place, position: index } : null;
      })
      .filter((p): p is Place => p !== null);
    setPlaces(reordered);

    const results = await Promise.all(
      orderedIds.map((id, index) =>
        supabase.from('places').update({ position: index }).eq('id', id)
      )
    );
    if (results.some(r => r.error)) {
      setPlaces(before);
      toast('Could not save the new order');
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
      if (error) { toast('Could not update tags'); return; }
    }
    if (toAdd.length > 0) {
      const { error } = await supabase
        .from('place_tags')
        .insert(toAdd.map(tag_id => ({ place_id: placeId, tag_id })));
      if (error) { toast('Could not update tags'); return; }
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
    const { error } = await supabase.from('place_images').delete().eq('id', imageId);
    if (error) {
      toast('Could not remove photo');
      return;
    }
    setPlaces(prev => prev.map(p =>
      p.id === placeId ? { ...p, images: (p.images ?? []).filter(i => i.id !== imageId) } : p
    ));
  };

  return { places, loading, addPlace, updatePlace, deletePlace, toggleVisited, setPlaceTags, addPlaceImage, uploadPlaceImage, removePlaceImage, reorderPlaces };
}
