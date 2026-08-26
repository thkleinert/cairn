import { useCallback, useEffect, useRef } from 'react';
import type { DragPoint } from './useDragReorder';

interface Options {
  enabled: boolean;
  /** How long the press must be held before it becomes a drag. */
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
export function useLongPressDrag({ enabled, holdMs = 420, slopPx = 8, onMove, onEnd }: Options) {
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const armed = useRef(false);
  // A drag ends with a click on whatever the finger is over. Without this,
  // dropping a row opens the place that was under it.
  const swallow = useRef(false);

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
   * `begin` is handed the press's ORIGINAL coordinates, not the ones the
   * pointer has now. The drag measures every later move against where the
   * finger started, and by the time this fires the React event that carried
   * those numbers is long gone — so they are copied out at pointerdown and
   * replayed here.
   */
  const start = useCallback((e: React.PointerEvent, begin: (point: DragPoint) => void) => {
    if (!enabled) return;
    cancel();
    const { clientX, clientY, pointerId, target } = e;
    const timer = window.setTimeout(() => {
      armed.current = true;
      begin({ clientX, clientY, pointerId, target, preventDefault: () => {} });
    }, holdMs);
    press.current = { timer, x: clientX, y: clientY };
  }, [enabled, holdMs, cancel]);

  const move = useCallback((e: React.PointerEvent) => {
    if (!press.current) return;
    if (!armed.current) {
      const dx = e.clientX - press.current.x;
      const dy = e.clientY - press.current.y;
      if (Math.hypot(dx, dy) > slopPx) cancel();
      return;
    }
    onMove(e);
  }, [cancel, onMove, slopPx]);

  const end = useCallback(() => {
    if (armed.current) {
      onEnd();
      swallow.current = true;
    }
    cancel();
  }, [cancel, onEnd]);

  /** True once, immediately after a drag — the click it produced is not a tap. */
  const swallowedClick = useCallback(() => {
    if (!swallow.current) return false;
    swallow.current = false;
    return true;
  }, []);

  return { start, move, end, swallowedClick };
}
