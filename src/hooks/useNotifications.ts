import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';
import { useRefetchOnResume } from './useRefetchOnResume';

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

// This is an inbox, not a feed: dismissing an item (whether by tapping through
// to its place or swiping it away) removes it from the list, so everything
// shown is always active. Dismissals persist per-user in activity_dismissed /
// activity_seen.
export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  // The stale-response guard every other data hook carries, needed here for
  // the same reason useTrips needed one: a mount fetch and a resume fetch can
  // now overlap on a slow connection, and the last to RESOLVE must not win.
  //
  // Dismissing bumps it too, and here that is not theoretical the way it is on
  // the trip list. The inbox stays on screen and is fully tappable while a
  // resume fetch is in flight — foregrounding the app BECAUSE of the bell and
  // tapping an item a moment later is the ordinary way this list gets used —
  // and get_activity answers from before the dismissal committed. Without the
  // bump the item reappears, which is exactly the "dismiss doesn't work"
  // resurrection the note on dismissNotification is about.
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    // Unread, non-dismissed activity across every trip the user belongs to,
    // newest first, excluding the user's own actions.
    const { data, error } = await supabase.rpc('get_activity');
    if (seq !== seqRef.current) return;
    // On failure keep whatever was already shown — an error must not render
    // as an empty ("all caught up") inbox.
    if (!error) setNotifications((data as Notification[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // No realtime channel here either, and this sits on the same screen as the
  // trip list: without it, an invite or a comment that arrived while the app
  // was backgrounded leaves the bell showing its launch-time count for the
  // rest of the session, next to a list that has just refreshed itself.
  useRefetchOnResume(load);

  // Everything in the list is active — dismissing removes it.
  const unreadCount = notifications.length;

  // Dismiss one item — whether tapped through to its place or swiped away,
  // it's the same thing: the item leaves this user's inbox. (Per-user; the
  // underlying activity row stays for other trip members.)
  const dismissNotification = async (id: string) => {
    const item = notifications.find(n => n.id === id);
    seqRef.current++;
    setNotifications(prev => prev.filter(n => n.id !== id));
    const { error } = await supabase.rpc('dismiss_activity', { p_activity_id: id });
    if (error && item) {
      // Silent failure reads as "dismiss doesn't work" when the item
      // resurrects on the next open — put it back and say so.
      toast('Could not dismiss notification');
      setNotifications(prev =>
        [...prev, item].sort((a, b) => b.created_at.localeCompare(a.created_at)));
    }
  };

  // Clear the whole list at once — the "Mark all read" button.
  const markAllRead = async () => {
    const before = notifications;
    seqRef.current++;
    setNotifications([]);
    const { error } = await supabase.rpc('mark_activity_seen');
    if (error) {
      toast('Could not mark all read');
      setNotifications(before);
    }
  };

  return { notifications, unreadCount, loading, dismissNotification, markAllRead };
}
