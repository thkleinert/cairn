import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Tag } from '../types';

export function useTags(tripId: string | undefined) {
  const [tags, setTags] = useState<Tag[]>([]);

  const fetchTags = useCallback(async () => {
    if (!tripId) return;
    const { data } = await supabase.from('tags').select('*').eq('trip_id', tripId);
    setTags(data ?? []);
  }, [tripId]);

  useEffect(() => { fetchTags(); }, [fetchTags]);

  const createTag = async (name: string, color: string, icon?: string) => {
    if (!tripId) return null;
    const { data, error } = await supabase
      .from('tags')
      .insert({ trip_id: tripId, name, color, icon: icon || null })
      .select()
      .single();
    if (!error && data) setTags(prev => [...prev, data]);
    return data;
  };

  const deleteTag = async (id: string) => {
    await supabase.from('tags').delete().eq('id', id);
    setTags(prev => prev.filter(t => t.id !== id));
  };

  return { tags, createTag, deleteTag, refetch: fetchTags };
}
