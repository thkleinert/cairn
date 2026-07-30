import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';
import type { Tag } from '../types';

export function useTags(tripId: string | undefined) {
  const [tags, setTags] = useState<Tag[]>([]);
  // Same stale-response guard as usePlaces: bursty realtime events spawn
  // concurrent refetches, and the last to *resolve* must not win.
  const fetchSeqRef = useRef(0);

  const fetchTags = useCallback(async () => {
    if (!tripId) return;
    const seq = ++fetchSeqRef.current;
    const { data, error } = await supabase.from('tags').select('*').eq('trip_id', tripId);
    if (seq !== fetchSeqRef.current) return;
    if (error) { toast('Could not load tags'); return; }
    setTags(data ?? []);
  }, [tripId]);

  useEffect(() => {
    if (!tripId) return;
    fetchTags();

    const channel = supabase
      .channel(`tags:${tripId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'tags',
        filter: `trip_id=eq.${tripId}`,
      }, () => { fetchTags(); })
      .subscribe();

    return () => { channel.unsubscribe(); };
  }, [tripId, fetchTags]);

  const createTag = async (name: string, color: string, icon?: string) => {
    if (!tripId) return null;
    const { data, error } = await supabase
      .from('tags')
      .insert({ trip_id: tripId, name, color, icon: icon || null })
      .select()
      .single();
    if (error || !data) {
      toast('Could not create tag');
      return null;
    }
    setTags(prev => [...prev, data]);
    return data;
  };

  const deleteTag = async (id: string) => {
    const { error } = await supabase.from('tags').delete().eq('id', id);
    if (error) {
      toast('Could not delete tag');
      return;
    }
    setTags(prev => prev.filter(t => t.id !== id));
  };

  const updateTag = async (id: string, updates: { name?: string; color?: string; icon?: string | null }) => {
    const { data, error } = await supabase
      .from('tags')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error || !data) {
      toast('Could not update tag');
      return null;
    }
    setTags(prev => prev.map(t => t.id === id ? data : t));
    return data;
  };

  return { tags, createTag, deleteTag, updateTag };
}
