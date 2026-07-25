import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { PlaceComment } from '../types';

// ─────────────────────────────────────────────────────────────────────────
// PROTOTYPE FLAG. While true, the thread is populated with local placeholder
// comments and add/delete only mutate local state — nothing hits Supabase, so
// this can be demoed without the `place_comments` table existing yet. Flip to
// false once the schema in supabase/schema.sql has been applied, and the live
// Supabase implementation below takes over unchanged.
const USE_MOCK = false;
// ─────────────────────────────────────────────────────────────────────────

function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

function buildMockComments(placeId: string): PlaceComment[] {
  return [
    {
      id: 'mock-1',
      place_id: placeId,
      user_id: 'user-jamie',
      email: 'jamie@example.com',
      body: 'The floating bungalows here look unreal 😍 should we book a night on the lake?',
      created_at: minutesAgo(60 * 26),
    },
    {
      id: 'mock-2',
      place_id: placeId,
      user_id: 'user-me',
      email: 'mail@thomaskleinert.com',
      body: 'Yes! But they sell out months ahead — let me lock it in this week before prices jump.',
      created_at: minutesAgo(60 * 22),
    },
    {
      id: 'mock-3',
      place_id: placeId,
      user_id: 'user-jamie',
      email: 'jamie@example.com',
      body: 'Perfect. Heard the sunrise canoe tour is the move for wildlife — gibbons + hornbills.',
      created_at: minutesAgo(45),
    },
  ];
}

export function useComments(placeId: string) {
  const [comments, setComments] = useState<PlaceComment[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);

    if (USE_MOCK) {
      // Treat the signed-in user as the author of any mock comment sharing
      // their email, so "your" comments render on the right with a delete
      // affordance exactly as they will with real data.
      const { data: { user } } = await supabase.auth.getUser();
      const mock = buildMockComments(placeId).map(c =>
        user?.email && c.email === user.email ? { ...c, user_id: user.id } : c
      );
      setCurrentUserId(user?.id ?? 'user-me');
      setComments(mock);
      setLoading(false);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    setCurrentUserId(user?.id ?? null);
    const { data } = await supabase.rpc('get_place_comments', { p_place_id: placeId });
    setComments((data as PlaceComment[]) ?? []);
    setLoading(false);
  }, [placeId]);

  useEffect(() => { load(); }, [load]);

  const addComment = async (body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;

    if (USE_MOCK) {
      const { data: { user } } = await supabase.auth.getUser();
      setComments(prev => [
        ...prev,
        {
          id: `mock-${Date.now()}`,
          place_id: placeId,
          user_id: user?.id ?? 'user-me',
          email: user?.email ?? 'mail@thomaskleinert.com',
          body: trimmed,
          created_at: new Date().toISOString(),
        },
      ]);
      return;
    }

    const { data, error } = await supabase.rpc('add_place_comment', {
      p_place_id: placeId,
      p_body: trimmed,
    });
    if (error) throw error;
    const created = Array.isArray(data) ? data[0] : data;
    if (created) setComments(prev => [...prev, created as PlaceComment]);
  };

  const deleteComment = async (id: string) => {
    if (USE_MOCK) {
      setComments(prev => prev.filter(c => c.id !== id));
      return;
    }
    const { error } = await supabase.from('place_comments').delete().eq('id', id);
    if (error) throw error;
    setComments(prev => prev.filter(c => c.id !== id));
  };

  return { comments, currentUserId, loading, addComment, deleteComment };
}
