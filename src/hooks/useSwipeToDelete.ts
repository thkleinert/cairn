import { useRef, useState, useCallback } from 'react';

// Swipe a row left to delete it.
//
// Pointer events rather than touch events, so the same code covers a mouse
// drag on desktop; the row keeps `touch-action: pan-y` so the browser still
// owns vertical scrolling and never waits on us to decide.
//
// The gesture only commits to being a swipe once horizontal movement clearly
// beats vertical — until then every move is let through untouched. Claiming
// the pointer earlier is what makes a list feel like it fights you when you
// are only trying to scroll past it.

/** Horizontal travel before we decide this is a swipe and not a scroll. */
const ENGAGE_PX = 12;
/**
 * Fraction of the row that must be crossed for release to delete.
 *
 * Was 0.35 with a 140px cap, which on a 358px bullet meant travelling 125px —
 * more than a third of the row — before letting go did anything. A screen
 * recording showed swipe after swipe of 30 to 80px springing back, and the
 * gesture reading as broken rather than as unfinished. A bullet is a small
 * thing to throw away and does not need a heroic swipe to do it; the undo
 * toast is what makes a short threshold safe.
 *
 * A fifth of the row — about 72px on a phone — is comfortably inside an
 * ordinary thumb flick, and still far enough past ENGAGE_PX that a hesitant
 * scroll cannot reach it by accident.
 */
const COMMIT_FRACTION = 0.2;
/** …but never more than this, so a wide tablet row doesn't need a long haul. */
const COMMIT_MAX_PX = 80;

interface Options {
  /**
   * Resolve false when the row did not actually go, and the swipe is undone.
   * Without that answer the gesture has to assume it worked: it latches so a
   * second swipe can't double-delete, and leaves the row translated off the
   * edge on its way out — which on a failed delete is a row that is invisible
   * and can never be swiped again.
   */
  onDelete: () => void | boolean | Promise<void | boolean>;
  enabled?: boolean;
}

export function useSwipeToDelete({ onDelete, enabled = true }: Options) {
  const [offset, setOffset] = useState(0);
  const [settling, setSettling] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  // The row's width, captured when the gesture starts, so "far enough to
  // delete" can be answered while the finger is still down. Without it the
  // indicator had to guess with a fixed number, and guessed less than half the
  // real distance.
  const [threshold, setThreshold] = useState(COMMIT_MAX_PX);
  const engaged = useRef(false);
  // Raised when a gesture actually became a swipe, so the click the browser
  // synthesises afterwards can be swallowed. Without it, dragging a row left
  // and releasing short of the threshold sprang the row back AND opened its
  // editor — the two things the user was choosing between. Touch usually
  // cancels that click via tap-slop; a mouse drag, which this hook explicitly
  // supports, does not.
  const swallowNextClick = useRef(false);
  // Set once the row is on its way out, so a second swipe during the collapse
  // animation can't fire onDelete twice for the same row.
  const committed = useRef(false);

  const reset = useCallback(() => {
    start.current = null;
    engaged.current = false;
  }, []);

  /**
   * Give up this gesture — the bullet drag won it.
   *
   * Both gestures start leftward on the same row, and the bullet dot sits
   * exactly where a thumb begins a left swipe, so direction cannot tell them
   * apart. The drag claims after a short hold; when it does, whatever this had
   * armed has to be let go of, or the row would slide and re-nest at once.
   */
  const cancel = useCallback(() => {
    reset();
    setOffset(0);
    setSettling(false);
  }, [reset]);

  const commitThreshold = useCallback((el: HTMLElement | null) => {
    const width = el?.getBoundingClientRect().width ?? 0;
    return Math.min(width * COMMIT_FRACTION, COMMIT_MAX_PX);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!enabled || committed.current) return;
    // Only primary input: a right-click or a second finger mid-scroll would
    // otherwise re-arm the gesture from wherever that pointer landed.
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    start.current = { x: e.clientX, y: e.clientY };
    engaged.current = false;
    setSettling(false);
    setThreshold(commitThreshold(e.currentTarget as HTMLElement));
  }, [enabled, commitThreshold]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const from = start.current;
    if (!from || committed.current) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;

    if (!engaged.current) {
      // A vertical intent wins outright and disarms us for the rest of the
      // gesture — otherwise a diagonal scroll would snag the row halfway down.
      if (Math.abs(dy) > Math.abs(dx)) { reset(); return; }
      if (-dx < ENGAGE_PX) return;
      engaged.current = true;
      swallowNextClick.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }

    // Left only. Rightward travel rubber-bands to nothing rather than sliding
    // the row off the other edge, where there is no action to reveal.
    setOffset(Math.min(0, dx + ENGAGE_PX));
  }, [reset]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!engaged.current || committed.current) { reset(); return; }
    const el = e.currentTarget as HTMLElement;
    const past = -offset >= commitThreshold(el);
    reset();
    setSettling(true);

    if (past) {
      committed.current = true;
      // Send it the rest of the way out before the row leaves the DOM, so the
      // deletion reads as the swipe completing rather than as a row blinking
      // out from under the finger.
      setOffset(-(el.getBoundingClientRect().width || 400));
      window.setTimeout(async () => {
        const removed = await onDelete();
        if (removed === false) {
          // It is still here. Unlatch and slide it back, rather than leaving a
          // row parked off-screen that no further swipe can reach.
          committed.current = false;
          setSettling(true);
          setOffset(0);
        }
      }, 160);
    } else {
      setOffset(0);
    }
  }, [offset, commitThreshold, onDelete, reset]);

  const onPointerCancel = useCallback(() => {
    if (committed.current) return;
    reset();
    setSettling(true);
    setOffset(0);
  }, [reset]);

  return {
    cancel,
    offset,
    /**
     * True once the swipe is far enough that releasing really would delete.
     * Derived from the same threshold the release uses — it was a flat 60px
     * against a commit distance of min(width * 0.35, 140), so on a phone the
     * trail turned red at roughly half the distance that actually deletes and
     * the row sprang back anyway.
     */
    armed: -offset >= threshold,
    swiping: offset !== 0,
    handlers: {
      onPointerDown, onPointerMove, onPointerUp, onPointerCancel,
      // Capture phase, so it runs before the row's own click handler.
      onClickCapture: (e: React.MouseEvent) => {
        if (!swallowNextClick.current) return;
        swallowNextClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
    },
    /** Transitions are off during the drag so the row tracks the finger 1:1. */
    style: {
      transform: offset ? `translateX(${offset}px)` : undefined,
      transition: settling ? 'transform 0.18s ease-out' : 'none',
    } as React.CSSProperties,
  };
}
