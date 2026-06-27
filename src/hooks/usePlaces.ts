import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import type { Place } from '../types';

export function usePlaces(tripId: string | undefined) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const fetchPlaces = useCallback(async () => {
    if (!tripId) { setLoading(false); return; }
    const { data } = await supabase
      .from('places')
      .select('*, place_tags(tag_id, tags(*))')
      .eq('trip_id', tripId)
      .order('created_at', { ascending: true });

    const normalized = (data ?? []).map((p: Place & { place_tags?: Array<{ tags: unknown }> }) => ({
      ...p,
      tags: (p.place_tags ?? []).map((pt) => pt.tags),
    }));
    setPlaces(normalized as Place[]);
    setLoading(false);
  }, [tripId]);

  // Realtime subscription
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
    if (!error && data) {
      setPlaces(prev => [...prev, { ...data, tags: [] }]);
    }
    return data;
  };

  const updatePlace = async (id: string, updates: Partial<Place>) => {
    const { data, error } = await supabase
      .from('places')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (!error && data) {
      setPlaces(prev => prev.map(p => p.id === id ? { ...p, ...data } : p));
    }
    return data;
  };

  const deletePlace = async (id: string) => {
    await supabase.from('places').delete().eq('id', id);
    setPlaces(prev => prev.filter(p => p.id !== id));
  };

  const toggleVisited = async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'planned' ? 'visited' : 'planned';
    const updates: Partial<Place> = {
      status: newStatus as Place['status'],
      visited_at: newStatus === 'visited' ? new Date().toISOString() : undefined,
    };
    return updatePlace(id, updates);
  };

  const setPlaceTags = async (placeId: string, tagIds: string[]) => {
    await supabase.from('place_tags').delete().eq('place_id', placeId);
    if (tagIds.length > 0) {
      await supabase.from('place_tags').insert(tagIds.map(tag_id => ({ place_id: placeId, tag_id })));
    }
    fetchPlaces();
  };

  return { places, loading, addPlace, updatePlace, deletePlace, toggleVisited, setPlaceTags };
}
