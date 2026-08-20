import { useState, useCallback, useEffect, useRef } from 'react';

// A set of ids remembered per trip in localStorage.
//
// Backs state that is about how *you* are looking at a trip rather than about
// the trip itself — which sections and bullets you have folded. That does not
// belong in the database: stored there it would fold a collaborator's sections
// shut while they were reading them.
//
// The consequence is that neither follows you to another device, which is the
// right way round: stale view state on a second device is invisible, whereas
// state that jumps under someone else's fingers is not.

function load(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    // Anything unexpected is discarded rather than trusted: this is a cache of
    // a preference, so being wrong costs one expanded section, while throwing
    // costs a page that will not render.
    return Array.isArray(parsed) ? new Set(parsed.filter(x => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function save(key: string, value: Set<string>) {
  // Storage can be full or blocked (private mode, quota). The change still
  // holds for this session, it just is not remembered.
  try { localStorage.setItem(key, JSON.stringify([...value])); } catch { /* not worth a toast */ }
}

export function usePersistentSet(storageKey: string | null) {
  const [ids, setIds] = useState<Set<string>>(() => storageKey ? load(storageKey) : new Set());
  // Suppresses the write that would otherwise follow loading, so switching
  // trips doesn't immediately persist what was just read back.
  const loadedKey = useRef<string | null>(null);

  // Re-read when the key changes: these hooks outlive a trip switch.
  useEffect(() => {
    loadedKey.current = storageKey;
    setIds(storageKey ? load(storageKey) : new Set());
  }, [storageKey]);

  // Persisted from an effect, not from inside the updaters below. React may
  // invoke an updater more than once — StrictMode does, and so does concurrent
  // rebasing — and a write in there can persist an intermediate value computed
  // against a base that was then thrown away. useTripNotes.setNoteDepths
  // carries a comment warning about exactly this; this hook was doing it.
  useEffect(() => {
    if (!storageKey || loadedKey.current !== storageKey) return;
    save(storageKey, ids);
  }, [ids, storageKey]);

  const has = useCallback((id: string) => ids.has(id), [ids]);

  const toggle = useCallback((id: string) => {
    setIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const add = useCallback((id: string) => {
    setIds(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  return { has, toggle, add, remove };
}
