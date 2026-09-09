import { useEffect, useRef } from 'react';

/**
 * Thirty seconds, doing two jobs.
 *
 * It is how long the app has to have been AWAY before coming back is worth a
 * round trip, and — since a network that just came back has no absence to
 * measure — it is also the minimum spacing between two of those recoveries.
 * The same number for both because both bound the same cost: an open trip has
 * four of these mounted at once (places, tags, notes, visits), so every
 * trigger is four queries. Flicking out to Maps to copy an address and
 * straight back — a couple of taps, several times while planning one stop —
 * must not pay that, and neither must a phone whose signal is dropping in and
 * out of a tunnel.
 *
 * Thirty rather than a number derived from when iOS actually suspends a
 * backgrounded PWA, because that is undocumented and varies with memory
 * pressure; there is no threshold that reliably means "the socket survived".
 * What it is chosen against instead is the other side: an absence long enough
 * for a co-planner to have added a place is minutes, not seconds, so nothing
 * this rejects was going to find anything.
 */
const MIN_REFETCH_GAP_MS = 30_000;

/**
 * Refetch when the app comes back from the background, or from a dead network.
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
 * It runs slightly BEFORE the rejoin it complements — phoenix reconnects off
 * the same visibilitychange event and the channels rejoin a few hundred
 * milliseconds later — so a write committed inside that window is caught by
 * neither. Accepted rather than chased: the mount path has exactly the same
 * sub-second gap (every hook here fetches, then subscribes) and has never been
 * a problem, and closing it means driving the refetch off each channel's
 * SUBSCRIBED callback, which useTrips has no channel to hang off at all.
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
  // listeners are registered once and read the current fetcher, rather than
  // being torn down and rebuilt whenever one is re-created.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  // When the app went away, and when it last actually refetched. Two clocks
  // because they answer different questions — "was it gone long enough to have
  // missed anything?" and "have we already done this recently?" — and a single
  // one answering both measures the wrong interval: seeded at mount, it reads
  // a three-second app-switch two minutes into a session as a two-minute
  // absence and fires the full burst for a gap in which nothing can have
  // changed.
  const hiddenAtRef = useRef(0);
  const lastRefetchRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const run = () => {
      hiddenAtRef.current = 0;
      lastRefetchRef.current = Date.now();
      refetchRef.current();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // The EARLIEST unserviced departure, not the latest. A stamp survives
        // a foregrounding only when that foregrounding owed a refetch and
        // could not do it (no radio, below), and overwriting it there is how
        // a long absence gets forgotten: away ten minutes, foregrounded with
        // no signal, pocketed again for eight seconds — the ten minutes would
        // become eight seconds and the next return would decide it had
        // nothing to catch up on.
        if (!hiddenAtRef.current) hiddenAtRef.current = Date.now();
        return;
      }
      // No recorded departure: this is the tab being revealed rather than the
      // app coming back, and there is nothing to catch up on.
      if (!hiddenAtRef.current) return;
      if (Date.now() - hiddenAtRef.current < MIN_REFETCH_GAP_MS) {
        hiddenAtRef.current = 0;
        return;
      }
      // Foregrounded before the radio is back — the iOS PWA reliably wins that
      // race — or opened somewhere with no data at all. Every fetcher here
      // toasts its own failure and postgrest resolves rather than throws, so
      // going ahead means four stacked red toasts and no retry. The departure
      // stamp is deliberately left standing: the `online` handler below, or
      // the next foregrounding, still owes this refetch.
      //
      // Only the false answer is trusted. navigator.onLine says true for a
      // captive portal with no route out, which is why this is a bail-out and
      // not a precondition.
      if (!navigator.onLine) return;
      run();
    };

    // The other half of the same bug, and the one visibilitychange cannot see:
    // a tunnel, a lift, a hotel dead zone with the screen still on. The socket
    // drops and reconnects, the changes in between are not replayed, and
    // without this the list stays silently stale until the app happens to be
    // backgrounded for half a minute. Rate-limited like everything else — a
    // weak signal flapping on a train fires this repeatedly.
    const onOnline = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRefetchRef.current < MIN_REFETCH_GAP_MS) return;
      run();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    // Removing the listeners is the unmount guard — both handlers are
    // synchronous, so once they are gone nothing can start a fetch. A fetch
    // already in flight is left to the caller: every fetcher here carries a
    // sequence guard.
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
    };
  }, [enabled]);
}
