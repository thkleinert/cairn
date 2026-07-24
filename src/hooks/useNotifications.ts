import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export type ActivityType = 'place_added' | 'comment_added';

export interface Notification {
  id: string;
  type: ActivityType;
  actor_email: string;
  trip_id: string;
  trip_name: string;
  place_id: string;
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

// Module-level so read state survives the TripList remounting (e.g. after you
// navigate into a trip and back). In the live path this is persisted per-user
// in activity_reads / activity_seen instead; this Set is mock-only.
const mockReadIds = new Set<string>();

function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

// For the prototype, resolve the mock activity against the user's REAL first
// trip and its REAL places, so tapping a notification actually jumps to a
// place that exists. Falls back to placeholder ids if there's no data yet.
async function buildMock(): Promise<Notification[]> {
  const { data: trips } = await supabase
    .from('trips')
    .select('id, name')
    .order('created_at', { ascending: false })
    .limit(1);
  const trip = trips?.[0];
  if (!trip) return [];

  const { data: places } = await supabase
    .from('places')
    .select('id, name')
    .eq('trip_id', trip.id)
    .order('position')
    .limit(3);
  if (!places || places.length === 0) return [];

  // Prefer a place with "comment-worthy" character for the comment item;
  // otherwise just use whatever's there.
  const commentPlace = places.find(p => /khao sok/i.test(p.name)) ?? places[0];
  const others = places.filter(p => p.id !== commentPlace.id);

  const out: Notification[] = [
    {
      id: 'n-comment',
      type: 'comment_added',
      actor_email: 'jamie@example.com',
      trip_id: trip.id,
      trip_name: trip.name,
      place_id: commentPlace.id,
      place_name: commentPlace.name,
      snippet: 'Heard the sunrise canoe tour is the move for wildlife — gibbons + hornbills.',
      created_at: minutesAgo(6),
      read: false,
    },
  ];
  if (others[0]) {
    out.push({
      id: 'n-place-1',
      type: 'place_added',
      actor_email: 'jamie@example.com',
      trip_id: trip.id,
      trip_name: trip.name,
      place_id: others[0].id,
      place_name: others[0].name,
      created_at: minutesAgo(52),
      read: false,
    });
  }
  if (others[1]) {
    out.push({
      id: 'n-place-2',
      type: 'place_added',
      actor_email: 'jamie@example.com',
      trip_id: trip.id,
      trip_name: trip.name,
      place_id: others[1].id,
      place_name: others[1].name,
      created_at: minutesAgo(60 * 5),
      read: true,
    });
  }
  return out;
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    if (USE_MOCK) {
      const built = await buildMock();
      setNotifications(built.map(n => (mockReadIds.has(n.id) ? { ...n, read: true } : n)));
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

  // Mark a single item read — used when you tap through to its place.
  const markRead = async (id: string) => {
    setNotifications(prev => prev.map(n => (n.id === id ? { ...n, read: true } : n)));
    if (USE_MOCK) { mockReadIds.add(id); return; }
    await supabase.rpc('mark_activity_read', { p_activity_id: id });
  };

  // Clear everything at once — the dedicated "Mark all read" affordance,
  // no navigation involved.
  const markAllRead = async () => {
    setNotifications(prev => {
      if (USE_MOCK) prev.forEach(n => mockReadIds.add(n.id));
      return prev.map(n => ({ ...n, read: true }));
    });
    if (USE_MOCK) return;
    await supabase.rpc('mark_activity_seen');
  };

  return { notifications, unreadCount, loading, markRead, markAllRead, reload: load };
}
