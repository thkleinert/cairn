import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export type ActivityType = 'place_added' | 'comment_added';

export interface Notification {
  id: string;
  type: ActivityType;
  actor_email: string;
  trip_id: string;
  trip_name: string;
  place_name: string;
  snippet?: string;   // comment body, for comment_added
  created_at: string;
  read: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// PROTOTYPE FLAG. While true, the activity feed is local placeholder data and
// "mark all read" only mutates local state — nothing hits Supabase. Flip to
// false once the `activity` table + trigger + get_activity RPC in
// supabase/schema.sql are applied; the live implementation below takes over.
const USE_MOCK = true;
// ─────────────────────────────────────────────────────────────────────────

function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

function buildMock(): Notification[] {
  return [
    {
      id: 'n1',
      type: 'place_added',
      actor_email: 'jamie@example.com',
      trip_id: 'mock-trip',
      trip_name: 'Thailand 2026',
      place_name: 'Railay Beach',
      created_at: minutesAgo(4),
      read: false,
    },
    {
      id: 'n2',
      type: 'comment_added',
      actor_email: 'jamie@example.com',
      trip_id: 'mock-trip',
      trip_name: 'Thailand 2026',
      place_name: 'Khao Sok National Park',
      snippet: 'Heard the sunrise canoe tour is the move for wildlife — gibbons + hornbills.',
      created_at: minutesAgo(58),
      read: false,
    },
    {
      id: 'n3',
      type: 'place_added',
      actor_email: 'jamie@example.com',
      trip_id: 'mock-trip',
      trip_name: 'Thailand 2026',
      place_name: 'Wat Arun',
      created_at: minutesAgo(60 * 5),
      read: true,
    },
  ];
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    if (USE_MOCK) {
      setNotifications(buildMock());
      setLoading(false);
      return;
    }
    // Live: activity across every trip the user belongs to, newest first,
    // excluding the user's own actions, with a per-user read cursor.
    const { data } = await supabase.rpc('get_activity');
    setNotifications((data as Notification[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const unreadCount = notifications.filter(n => !n.read).length;

  const markAllRead = async () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    if (USE_MOCK) return;
    await supabase.rpc('mark_activity_seen');
  };

  return { notifications, unreadCount, loading, markAllRead, reload: load };
}
