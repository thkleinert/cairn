import { useEffect, useRef } from 'react';

/**
 * How long the app has to have been away before returning to it is worth a
 * round trip. Thirty seconds.
 *
 * The cost being bounded here is a burst, not a request: five hooks use this,
 * so every foregrounding is five queries. Flicking out to Maps to copy an
 * address and straight back — which on iOS is a couple of taps and happens
 * several times while planning a single stop — would otherwise fire that burst
 * each way.
 *
 * Thirty rather than a number derived from when iOS actually suspends a
 * backgrounded PWA, because that is undocumented and varies with memory
 * pressure; there is no threshold that reliably means "the socket survived".
 * What it is chosen against instead is the other side: an absence long enough
 * for a co-planner to have added a place is minutes, not seconds, so nothing
 * this rejects was going to find anything.
 */
const STALE_AFTER_MS = 30_000;

/**
 * Refetch when the app comes back to the foreground.
 *
 * iOS suspends a backgrounded standalone PWA and takes its WebSocket with it.
 * The socket comes back — see below — but postgres_changes are not replayed on
 * reconnect, so every insert, update and delete that happened while we were
 * away is simply gone. Symptom, and the reason this exists: a trip edited on
 * the desktop, or by a co-planner, still showed the old list on the phone
 * until the app was force-quit and relaunched.
 *
 * The socket itself needs no help, and deliberately gets none. @supabase/phoenix
 * (0.4.4, vendored under realtime-js) installs its own page-lifecycle handlers
 * when the Socket is constructed: `pagehide` disconnects and records the
 * connect clock, `pageshow` reconnects if nothing else did first, and
 * `visibilitychange` back to visible tears down and reconnects whenever the
 * socket is closed and the close was not clean — which is exactly the shape of
 * a connection iOS killed. Each RealtimeChannel then rejoins itself off the
 * socket's `open` callback, because the preceding close marked it errored.
 *
 * So this hook does not touch the channel, and unsubscribing to re-subscribe
 * would be worse than doing nothing: a phoenix Channel throws on a second
 * `join`, so "re-subscribing" really means dropping the channel and building a
 * new one, which opens a fresh window of missed events and races the library's
 * own reconnect for the same topic.
 *
 * What the library cannot do is tell us what we missed. That is this refetch.
 *
 * `enabled` is how a caller says it has something to fetch for — usually
 * `!!tripId`. The fetchers all no-op without one, but they also flip `loading`
 * on the way out, so calling them for a trip that isn't there is not free.
 */
export function useRefetchOnResume(
  refetch: () => void | Promise<void>,
  enabled = true,
) {
  // The latest-ref idiom the Escape stack uses, for the same reason: the
  // listener is registered once and reads the current fetcher, rather than
  // re-registering whenever one is re-created. It also keeps an unstable
  // caller — a fetcher not wrapped in useCallback — from resetting the clock
  // below on every render and quietly disabling the threshold entirely.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  // Zero, not Date.now(): the effect seeds it, so a hook that only becomes
  // enabled later starts its clock when it actually starts fetching.
  const lastRefetchRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    // The caller fetches on mount. Backgrounding and resuming right after
    // opening a trip has nothing to catch up on, so the clock starts here.
    lastRefetchRef.current = Date.now();

    const onVisibilityChange = () => {
      // Also fires on the way out; only the return matters.
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRefetchRef.current < STALE_AFTER_MS) return;
      lastRefetchRef.current = Date.now();
      refetchRef.current();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    // Removing the listener is the unmount guard — the handler is synchronous,
    // so once it is gone nothing can start a fetch. A fetch already in flight
    // is left to the caller: every fetcher here either carries a sequence
    // guard or only calls setState, which React 19 ignores after unmount.
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [enabled]);
}
