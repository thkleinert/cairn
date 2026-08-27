import { useCallback, useEffect, useRef } from 'react';
import type { DragPoint } from './useDragReorder';

interface Options {
  enabled: boolean;
  /**
   * How long the press must be held before it becomes a drag.
   *
   * Short, because the hold is not what makes this safe — the slop is. Any
   * travel cancels, so a gesture that is going to scroll has already
   * disqualified itself long before a slower timer would have expired, and
   * the only thing a longer wait buys is a list that feels stuck.
   */
  holdMs?: number;
  /** Travel before the hold lands that means this was a scroll after all. */
  slopPx?: number;
  onMove: (e: React.PointerEvent) => void;
  onEnd: () => void;
}

/**
 * Turning a press-and-hold into a drag, for a list that has no grab handle.
 *
 * A handle can simply declare `touch-action: none` and own every gesture that
 * starts on it — that is what the notes outline's bullet dot does. A whole row
 * cannot: the same finger has to be able to tap it open and scroll the list
 * past it, so the row must stay scrollable until the moment it isn't.
 *
 * The hold is what separates them. Any travel before the timer lands cancels
 * it, so a press that becomes a drag is one that has not moved — which is
 * exactly the condition under which the browser has not yet committed to
 * scrolling, and therefore the only condition under which it can still be
 * told not to.
 */
export function useLongPressDrag({ enabled, holdMs = 200, slopPx = 8, onMove, onEnd }: Options) {
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const armed = useRef(false);
  // Whether an armed press actually went anywhere. Arming is not the same as
  // dragging: hold a row for a quarter of a second and let go without moving
  // and you have TAPPED it. Swallowing the click on arming alone meant that
  // tap opened nothing — rare at a 420ms hold, ordinary at 200ms, which is
  // exactly the change that made it matter.
  const moved = useRef(false);
  // A drag ends with a click on whatever the finger is over. Without this,
  // dropping a row opens the place that was under it.
  //
  // It has to expire on its own, not just when something consumes it: a drag
  // that actually TRAVELLED emits no compatibility click at all, so a flag
  // waiting to be read would sit set until the next genuine tap and eat that
  // instead — the place sheet silently refusing to open, one tap after a
  // reorder. Short enough that no real second tap falls inside it.
  const swallow = useRef(false);
  const swallowTimer = useRef<number | null>(null);

  /**
   * The only thing that can stop the list scrolling once a press has become a
   * drag.
   *
   * It has to be a manual listener: React registers touchmove passively at the
   * root, so preventDefault from an onTouchMove prop is ignored with a console
   * warning and nothing else. And it can only work because of the slop rule
   * above — a scroll already under way cannot be called back, so this relies
   * on there being no movement before it arms.
   */
  useEffect(() => {
    const hold = (e: TouchEvent) => { if (armed.current) e.preventDefault(); };
    document.addEventListener('touchmove', hold, { passive: false });
    return () => document.removeEventListener('touchmove', hold);
  }, []);

  const cancel = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
    armed.current = false;
  }, []);

  /**
   * Let go of whatever is held, telling the drag about it if one was running.
   *
   * Both the release AND a new press come through here. A bare cancel on a new
   * press abandoned a drag already in flight without ever calling onEnd — the
   * second finger of a two-finger scroll was enough — and useDragReorder went
   * on holding the row, which keeps its lifted transform in inline styles that
   * no re-render clears. The row stayed picked up until the view was left.
   */
  const release = useCallback(() => {
    if (armed.current) {
      onEnd();
      // Only a drag that TRAVELLED leaves a click worth discarding. A
      // stationary one is a slow tap, and its click is what opens the place.
      if (moved.current) {
        swallow.current = true;
        if (swallowTimer.current) clearTimeout(swallowTimer.current);
        swallowTimer.current = window.setTimeout(() => { swallow.current = false; }, 150);
      }
    }
    cancel();
  }, [cancel, onEnd]);

  // A row can go while its press is still pending — a collaborator's delete,
  // or the view changing. The timer would then fire against a detached
  // element, and setPointerCapture on one throws.
  useEffect(() => () => {
    if (press.current) clearTimeout(press.current.timer);
    if (swallowTimer.current) clearTimeout(swallowTimer.current);
  }, []);

  /**
   * `begin` is handed the press's ORIGINAL coordinates, not the ones the
   * pointer has now. The drag measures every later move against where the
   * finger started, and by the time this fires the React event that carried
   * those numbers is long gone — so they are copied out at pointerdown and
   * replayed here.
   */
  const start = useCallback((e: React.PointerEvent, begin: (point: DragPoint) => void) => {
    if (!enabled) return;
    release();
    const { clientX, clientY, pointerId, target } = e;
    const timer = window.setTimeout(() => {
      armed.current = true;
      begin({ clientX, clientY, pointerId, target, preventDefault: () => {} });
    }, holdMs);
    press.current = { timer, x: clientX, y: clientY };
    moved.current = false;
  }, [enabled, holdMs, release]);

  const move = useCallback((e: React.PointerEvent) => {
    if (!press.current) return;
    const dx = e.clientX - press.current.x;
    const dy = e.clientY - press.current.y;
    if (!armed.current) {
      if (Math.hypot(dx, dy) > slopPx) cancel();
      return;
    }
    // Same threshold as the slop, so a thumb's jitter is not mistaken for
    // travel and does not turn a slow tap into a swallowed one.
    if (!moved.current && Math.hypot(dx, dy) > slopPx) moved.current = true;
    onMove(e);
  }, [cancel, onMove, slopPx]);

  const end = release;

  /** True once, immediately after a drag — the click it produced is not a tap. */
  const swallowedClick = useCallback(() => {
    if (!swallow.current) return false;
    swallow.current = false;
    return true;
  }, []);

  return { start, move, end, swallowedClick };
}
