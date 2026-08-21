import { useEffect, useRef } from 'react';

/**
 * Makes the system Back gesture close the topmost overlay instead of leaving
 * the screen underneath it.
 *
 * The problem this solves is not that the gesture exists — on iOS it cannot be
 * disabled from a web page at all, because the edge swipe is handled before any
 * touch event reaches us. It is that the gesture used to skip layers: five
 * overlays (the place sheet, the outliner, the tag filter, settings, the search
 * field) were pure component state while only ONE history entry was ever pushed
 * (list → trip). So a back-swipe from inside the outliner did not close the
 * outliner; it dropped you all the way to the trip list, discarding the sheet,
 * the outliner and the trip in one motion. The in-app back arrow closed one
 * layer at a time; the gesture closed everything.
 *
 * The rule here is deliberately simpler than a stack: there is one history
 * entry while ANY overlay is open, and back closes the topmost one. If another
 * layer is still open underneath, the effect immediately pushes a fresh entry,
 * so the invariant "an entry exists iff something is open" holds through any
 * sequence of opens and closes. Modelling every layer as its own entry would
 * have to survive layers that open over each other out of order — a place sheet
 * opens over the outliner, and closing the outliner underneath it is reachable
 * — and a stack that desynchronises from the DOM strands the user pressing back
 * against entries for things that are no longer on screen.
 *
 * @param topLayer  Identifier of the frontmost open overlay, or null when the
 *                  screen is bare. Only its null-ness and its identity matter.
 * @param closeTop  Closes exactly that overlay. Called on a back gesture.
 */
export function useHistoryLayer(topLayer: string | null, closeTop: () => void) {
  const pushed = useRef(false);
  // How many backs WE issued and are still waiting to see, to consume our own
  // entries after the UI closed a layer. Without it, closing by button would
  // fire popstate and run closeTop again on whatever layer is now frontmost —
  // one tap closing two things.
  //
  // A count rather than a flag: history.back() does not take effect until the
  // browser dispatches popstate, so closing one layer and opening another
  // before that lands leaves a back in flight. A boolean would be overwritten
  // and the in-flight pop would then be read as a user gesture, closing the
  // layer that had just been opened.
  const selfIssued = useRef(0);
  // Kept in a ref so the popstate listener never goes stale, and so the effect
  // below does not re-register a listener on every render of a screen that
  // rebuilds this callback.
  const closeRef = useRef(closeTop);
  closeRef.current = closeTop;

  useEffect(() => {
    if (topLayer && !pushed.current) {
      pushed.current = true;
      // Same URL as the entry underneath: the overlay is not a location, it is
      // a thing covering one. Only the entry's existence matters.
      window.history.pushState({ cairnLayer: true }, '');
    } else if (!topLayer && pushed.current) {
      pushed.current = false;
      selfIssued.current += 1;
      window.history.back();
    }
  }, [topLayer]);

  useEffect(() => {
    const onPop = () => {
      if (selfIssued.current > 0) {
        selfIssued.current -= 1;
        return;
      }
      if (!pushed.current) return;
      pushed.current = false;
      closeRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
}
