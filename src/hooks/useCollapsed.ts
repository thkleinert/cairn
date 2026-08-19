import { useState, useCallback, useEffect } from 'react';

// Which sections of a trip's outline are folded shut.
//
// Kept in localStorage, not in the database, and that is the whole design
// decision: collapsing is how *you* are reading the page right now, not a fact
// about the trip. Storing it server-side would fold a collaborator's sections
// shut while they were looking at them, and would put a write on the network
// for what is a scroll-management gesture.
//
// The consequence is that it does not follow you to another device, which is
// the right way round — a stale collapse on a second device is invisible, a
// collapse that jumps under someone else's fingers is not.
//
// Note ids and place ids are both uuids from the same generator, so one set
// holds both without a prefix and without any chance of collision.

const KEY = (tripId: string) => `cairn:collapsed:${tripId}`;

function load(tripId: string): Set<string> {
  try {
    const raw = localStorage.getItem(KEY(tripId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    // Anything unexpected in storage is discarded rather than trusted — this
    // is a cache of a view preference, so the cost of being wrong is one
    // expanded section, and the cost of throwing is a page that won't render.
    return Array.isArray(parsed) ? new Set(parsed.filter(x => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export function useCollapsed(tripId: string | undefined) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => tripId ? load(tripId) : new Set());

  // Re-read when the trip changes: the hook outlives a trip switch.
  useEffect(() => { setCollapsed(tripId ? load(tripId) : new Set()); }, [tripId]);

  const toggle = useCallback((id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      if (tripId) {
        // Storage can be full or blocked (private mode, quota); the fold still
        // works for this session, it just won't be remembered.
        try { localStorage.setItem(KEY(tripId), JSON.stringify([...next])); } catch { /* not worth a toast */ }
      }
      return next;
    });
  }, [tripId]);

  /** Force a section open — used when something has to be visible to act on. */
  const expand = useCallback((id: string) => {
    setCollapsed(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      if (tripId) {
        try { localStorage.setItem(KEY(tripId), JSON.stringify([...next])); } catch { /* ignore */ }
      }
      return next;
    });
  }, [tripId]);

  const isCollapsed = useCallback((id: string) => collapsed.has(id), [collapsed]);

  return { isCollapsed, toggle, expand };
}
