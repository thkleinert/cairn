import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';
import type { PlaceComment } from '../types';

export function useComments(placeId: string) {
  const [comments, setComments] = useState<PlaceComment[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // The sheet can stay mounted while placeId changes (tapping another marker,
  // notification tap-through) — without a sequence guard, place A's slower
  // response could land after place B's and show A's thread on B.
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(false);
    const { data: { user } } = await supabase.auth.getUser();
    if (seq !== seqRef.current) return;
    setCurrentUserId(user?.id ?? null);
    const { data, error: rpcError } = await supabase.rpc('get_place_comments', { p_place_id: placeId });
    if (seq !== seqRef.current) return;
    if (rpcError) {
      // A failed load must not render as "no comments yet".
      setComments([]);
      setError(true);
    } else {
      setComments((data as PlaceComment[]) ?? []);
    }
    setLoading(false);
  }, [placeId]);

  useEffect(() => { load(); }, [load]);

  // Returns whether the post succeeded, so the caller can restore the draft
  // on failure instead of silently losing the text.
  const addComment = async (body: string): Promise<boolean> => {
    const trimmed = body.trim();
    if (!trimmed) return false;

    const { data, error: rpcError } = await supabase.rpc('add_place_comment', {
      p_place_id: placeId,
      p_body: trimmed,
    });
    if (rpcError) {
      toast('Could not post comment');
      return false;
    }
    const created = Array.isArray(data) ? data[0] : data;
    if (created) setComments(prev => [...prev, created as PlaceComment]);
    return true;
  };

  const deleteComment = async (id: string) => {
    const { error: deleteError } = await supabase.from('place_comments').delete().eq('id', id);
    if (deleteError) {
      toast('Could not delete comment');
      return;
    }
    setComments(prev => prev.filter(c => c.id !== id));
  };

  return { comments, currentUserId, loading, error, reload: load, addComment, deleteComment };
}
