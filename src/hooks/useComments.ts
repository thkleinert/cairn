import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';
import type { PlaceComment } from '../types';

export function useComments(placeId: string) {
  const [comments, setComments] = useState<PlaceComment[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    setCurrentUserId(user?.id ?? null);
    const { data } = await supabase.rpc('get_place_comments', { p_place_id: placeId });
    setComments((data as PlaceComment[]) ?? []);
    setLoading(false);
  }, [placeId]);

  useEffect(() => { load(); }, [load]);

  // Returns whether the post succeeded, so the caller can restore the draft
  // on failure instead of silently losing the text.
  const addComment = async (body: string): Promise<boolean> => {
    const trimmed = body.trim();
    if (!trimmed) return false;

    const { data, error } = await supabase.rpc('add_place_comment', {
      p_place_id: placeId,
      p_body: trimmed,
    });
    if (error) {
      toast('Could not post comment');
      return false;
    }
    const created = Array.isArray(data) ? data[0] : data;
    if (created) setComments(prev => [...prev, created as PlaceComment]);
    return true;
  };

  const deleteComment = async (id: string) => {
    const { error } = await supabase.from('place_comments').delete().eq('id', id);
    if (error) {
      toast('Could not delete comment');
      return;
    }
    setComments(prev => prev.filter(c => c.id !== id));
  };

  return { comments, currentUserId, loading, addComment, deleteComment };
}
