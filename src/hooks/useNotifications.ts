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
}

// ─────────────────────────────────────────────────────────────────────────
// PROTOTYPE FLAG. While true, the activity feed is local placeholder data and
// dismissals only mutate local state — nothing hits Supabase. Flip to false
// once the activity tables + RPCs in supabase/schema.sql are applied; the
// live implementation below takes over.
const USE_MOCK = false;
// ─────────────────────────────────────────────────────────────────────────

// This is an inbox, not a feed: dismissing an item (whether by tapping through
// to its place or swiping it away) removes it from the list, so everything
// shown is always active. A module-level set keeps those decisions across
// TripList remounts (e.g. after you navigate into a trip and back). The live
// path persists them per-user in activity_dismissed / activity_seen instead.
const mockDismissedIds = new Set<string>();

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
    });
  }
  // Anything already dismissed this session stays gone.
  return out.filter(n => !mockDismissedIds.has(n.id));
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    if (USE_MOCK) {
      setNotifications(await buildMock());
      setLoading(false);
      return;
    }
    // Live: unread, non-dismissed activity across every trip the user belongs
    // to, newest first, excluding the user's own actions.
    const { data } = await supabase.rpc('get_activity');
    setNotifications((data as Notification[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Everything in the list is active — dismissing removes it.
  const unreadCount = notifications.length;

  const drop = (id: string) => setNotifications(prev => prev.filter(n => n.id !== id));

  // Dismiss one item — whether tapped through to its place or swiped away, it's
  // the same thing: the item leaves this user's inbox. (Per-user; the
  // underlying activity row stays for other trip members.)
  const dismissNotification = async (id: string) => {
    drop(id);
    if (USE_MOCK) { mockDismissedIds.add(id); return; }
    await supabase.rpc('dismiss_activity', { p_activity_id: id });
  };

  // Clear the whole list at once — the "Mark all read" button.
  const markAllRead = async () => {
    setNotifications(prev => {
      if (USE_MOCK) prev.forEach(n => mockDismissedIds.add(n.id));
      return [];
    });
    if (USE_MOCK) return;
    await supabase.rpc('mark_activity_seen');
  };

  return { notifications, unreadCount, loading, dismissNotification, markAllRead, reload: load };
}
