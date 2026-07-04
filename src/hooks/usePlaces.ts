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
      .order('created_at', { ascending: true });

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
      .insert({ ...place, trip_id: tripId })
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

  return { places, loading, addPlace, updatePlace, deletePlace, toggleVisited, setPlaceTags, addPlaceImage, removePlaceImage };
}
