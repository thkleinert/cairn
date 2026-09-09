import { useEffect, useRef } from 'react';

/**
 * How long the app must have been away before coming back is worth a round
 * trip, and — a network that just returned has no absence to measure — also
 * the minimum spacing between recoveries. One number because both bound the
 * same cost: an open trip has four of these mounted, so every trigger is four
 * queries, and flicking out to Maps to copy an address must not pay that.
 *
 * Not derived from when iOS actually suspends a backgrounded PWA: that is
 * undocumented and varies with memory pressure, so no threshold reliably means
 * "the socket survived". Chosen against the other side instead — an absence
 * long enough for a co-planner to have added a place is minutes, not seconds.
 */
const MIN_REFETCH_GAP_MS = 30_000;

/**
 * Refetch when the app comes back from the background, or from a dead network.
 *
 * iOS suspends a backgrounded standalone PWA and takes its WebSocket with it.
 * postgres_changes are not replayed on reconnect, so everything that happened
 * while away is gone — a trip edited on the desktop still showed the old list
 * on the phone until the app was force-quit.
 *
 * The socket itself needs no help and deliberately gets none. phoenix (vendored
 * under realtime-js) installs its own pagehide/pageshow/visibilitychange
 * handlers and reconnects an uncleanly-closed socket, and each channel rejoins
 * off the socket's `open`. Re-subscribing here would be worse than nothing: a
 * phoenix Channel throws on a second `join`, so it means dropping the channel
 * and building a new one, which opens a fresh window of missed events and races
 * the library's own reconnect for the same topic.
 *
 * What the library cannot do is tell us what we missed. That is this refetch.
 *
 * `enabled` is how a caller says it has something to fetch for — usually
 * `!!tripId`. The fetchers no-op without one, but they flip `loading` on the
 * way out, so calling them for a trip that isn't there is not free.
 */
export function useRefetchOnResume(
  refetch: () => void | Promise<void>,
  enabled = true,
) {
  // Latest-ref, so the listeners register once instead of being torn down and
  // rebuilt whenever the fetcher is re-created.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  // Two clocks, answering different questions: "was it away long enough to
  // have missed anything?" and "have we already done this recently?". One
  // clock serving both measures the wrong interval — seeded at mount, it reads
  // a three-second app-switch as however long the session has been open.
  const hiddenAtRef = useRef(0);
  const lastRefetchRef = useRef(0);
  // Learning there is a gap and being able to close it are often not the same
  // moment: a foregrounding with no radio, or the network returning while
  // hidden. Without somewhere to write that down, an outage followed by a
  // pocketing shorter than the threshold loses both signals.
  const owedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const run = () => {
      hiddenAtRef.current = 0;
      owedRef.current = false;
      lastRefetchRef.current = Date.now();
      refetchRef.current();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now();
        return;
      }
      // A departure of zero is the tab being revealed rather than the app
      // coming back, and reads as no absence at all.
      const awayLongEnough = hiddenAtRef.current !== 0
        && Date.now() - hiddenAtRef.current >= MIN_REFETCH_GAP_MS;
      hiddenAtRef.current = 0;
      if (!awayLongEnough && !owedRef.current) return;
      // Foregrounded before the radio is back — the iOS PWA reliably wins that
      // race. Every fetcher toasts its own failure, so going ahead means four
      // stacked red toasts and no retry; carried forward instead.
      //
      // Only the false answer is read: navigator.onLine says true for a captive
      // portal, so this is a bail-out, not a precondition.
      if (!navigator.onLine) { owedRef.current = true; return; }
      run();
    };

    // The half visibilitychange cannot see: a tunnel, a lift, a dead zone with
    // the screen still on. Suppressed here means deferred, never dropped —
    // fetching immediately would fire repeatedly on a flapping signal, but the
    // events were still missed, so the next foregrounding pays the debt.
    const onOnline = () => {
      if (document.visibilityState !== 'visible'
        || Date.now() - lastRefetchRef.current < MIN_REFETCH_GAP_MS) {
        owedRef.current = true;
        return;
      }
      run();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    // Removing the listeners is the unmount guard: both handlers are
    // synchronous, so once they are gone nothing can start a fetch. A fetch
    // already in flight is left to the caller's own sequence guard.
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
    };
  }, [enabled]);
}
