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

// This is an inbox, not a feed: dismissing an item (whether by tapping through
// to its place or swiping it away) removes it from the list, so everything
// shown is always active. Dismissals persist per-user in activity_dismissed /
// activity_seen.
export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // Unread, non-dismissed activity across every trip the user belongs to,
    // newest first, excluding the user's own actions.
    const { data } = await supabase.rpc('get_activity');
    setNotifications((data as Notification[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Everything in the list is active — dismissing removes it.
  const unreadCount = notifications.length;

  // Dismiss one item — whether tapped through to its place or swiped away,
  // it's the same thing: the item leaves this user's inbox. (Per-user; the
  // underlying activity row stays for other trip members.)
  const dismissNotification = async (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
    await supabase.rpc('dismiss_activity', { p_activity_id: id });
  };

  // Clear the whole list at once — the "Mark all read" button.
  const markAllRead = async () => {
    setNotifications([]);
    await supabase.rpc('mark_activity_seen');
  };

  return { notifications, unreadCount, loading, dismissNotification, markAllRead };
}
