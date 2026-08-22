import { useState, useRef, useCallback } from 'react';
import { maxDepthAt } from '../lib/outline';

/**
 * How long the dot must be held before the drag takes the gesture.
 *
 * The bullet dot sits exactly where a thumb starts a leftward swipe, and both
 * gestures ARE leftward — de-indent and delete — so no amount of direction
 * sniffing separates them. A hold is what every mobile outliner uses.
 *
 * This was 180ms and that was far too short, in a way only a screen recording
 * showed: a swipe is not a movement, it is a touch, a beat, and THEN a
 * movement. The beat routinely runs past 180ms, so the hold fired while the
 * finger was still stationary, the drag claimed, and it cancelled the swipe
 * that was about to happen — the row slid a few pixels, snapped back, and
 * nothing was deleted or moved. The de-indent it had switched to was clamped
 * away to nothing on a bullet already at depth 0, so the gesture had no
 * outcome at all.
 *
 * 450ms is roughly what iOS itself uses to lift something, and it sits well
 * past the pause at the start of a swipe. It only costs time when picking a
 * bullet UP; the drag itself is unchanged once it has begun.
 */
const HOLD_MS = 450;
/**
 * Movement before the hold completes means a swipe, not a pick-up.
 *
 * Deliberately smaller than useSwipeToDelete's ENGAGE_PX of 12: a moving
 * finger stands this gesture down four pixels before the swipe visibly takes
 * the row, so the handover happens while nothing has been drawn yet. Raising
 * this above 12 would put a stutter in every swipe that starts on the dot.
 */
const HOLD_SLOP_PX = 8;

interface Options {
  /** The bullets as rendered — already filtered by folds. */
  items: { id: string; depth: number }[];
  /** How many rows the subtree rooted at this index occupies. */
  blockLength: (index: number) => number;
  /** Horizontal travel that counts as one level. */
  step?: number;
  /** Where the block ended up. `targetIndex` is against the list WITHOUT it. */
  onDrop: (index: number, targetIndex: number, depth: number) => void;
  enabled: boolean;
}

interface Info {
  startX: number;
  startY: number;
  index: number;
  len: number;
  startDepth: number;
  blockHeight: number;
  blockTop: number;
  /** Every row's top and height at drag start, in rendered order. */
  rows: { top: number; height: number }[];
}

/**
 * Notion-style drag for outline bullets: vertically to move, horizontally to
 * change level.
 *
 * Deliberately not useDragReorder, which the places list uses. That hook moves
 * exactly one row and reports an id order; this one moves a bullet AND
 * everything nested under it, and a drop has to answer a second question — what
 * level did it land at — that an id order cannot express. Sharing one hook
 * would mean a moving unit of "one row, unless it isn't" and a return value
 * half of each caller ignores.
 *
 * What they do share is the pointer choreography, and that is worth keeping in
 * step by hand: capture on the handle, raw deltas outside React state so the
 * block tracks the finger exactly, and one suppressed frame on release so the
 * reflow and the transform reset cancel out instead of flashing.
 */
export function useOutlineDrag({ items, blockLength, step = 28, onDrop, enabled }: Options) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [depth, setDepth] = useState(0);
  const [settling, setSettling] = useState(false);
  // The finger's raw offset. A ref because nothing renders from it directly —
  // the block is moved by writing transforms, not by re-rendering the list.
  const dy = useRef(0);
  const info = useRef<Info | null>(null);
  const blockEls = useRef<HTMLElement[]>([]);
  // A drag that actually moved has to eat the click that follows it. The
  // browser synthesises one from the pointerdown/pointerup pair, and the row
  // treats a click as "edit this bullet" — so letting go after dragging a
  // bullet out a level opened the keyboard on it, every time.
  const swallowClick = useRef(false);
  // The press that has not yet become a drag. Held here rather than in state
  // because nothing renders from it — until the hold completes, the gesture
  // may still turn out to belong to the swipe.
  const pending = useRef<{
    x: number; y: number; index: number; row: HTMLElement;
    handle: HTMLElement; pointerId: number; cancelSwipe?: () => void;
  } | null>(null);
  const holdTimer = useRef<number | null>(null);

  const clearHold = useCallback(() => {
    if (holdTimer.current !== null) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    pending.current = null;
  }, []);

  /** Actually take the gesture — only ever called by the hold timer. */
  const claim = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    // Whatever the swipe had armed on the way in is released here, not at
    // pointerdown: until this moment the gesture might still have been a swipe.
    p.cancelSwipe?.();
    try { p.handle.setPointerCapture(p.pointerId); } catch { /* pointer already gone */ }

    const row = p.row;
    const parent = row.parentElement;
    const all = Array.from(parent?.children ?? []).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.tagName === row.tagName,
    );
    const rects = all.map(el => el.getBoundingClientRect());
    const index = p.index;
    const len = blockLength(index);
    const block = all.slice(index, index + len);

    info.current = {
      startX: p.x,
      startY: p.y,
      index,
      len,
      startDepth: items[index]?.depth ?? 0,
      blockHeight: rects.slice(index, index + len).reduce((s, r) => s + r.height, 0),
      blockTop: rects[index]?.top ?? 0,
      rows: rects.map(r => ({ top: r.top, height: r.height })),
    };
    blockEls.current = block;
    // Only the indent animates. transform is left out deliberately so the
    // block tracks the finger exactly; a transition there lags the pointer.
    block.forEach(el => { el.style.transition = 'padding-left 0.12s ease-out'; });

    dy.current = 0;
    swallowClick.current = false;
    setDragId(items[index]?.id ?? null);
    setTarget(index);
    setDepth(items[index]?.depth ?? 0);
  }, [items, blockLength]);

  /**
   * Arm the hold. Deliberately does NOT capture the pointer or stop the event:
   * doing either at this moment is what broke swipe-to-delete, because the
   * swipe never saw the press that began on the dot and so could never take
   * the gesture back.
   */
  const press = useCallback((
    index: number, row: HTMLElement, e: React.PointerEvent, cancelSwipe?: () => void,
  ) => {
    if (!enabled) return;
    clearHold();
    pending.current = {
      x: e.clientX, y: e.clientY, index, row,
      handle: e.currentTarget as HTMLElement, pointerId: e.pointerId, cancelSwipe,
    };
    holdTimer.current = window.setTimeout(claim, HOLD_MS);
  }, [enabled, claim, clearHold]);

  const move = useCallback((e: React.PointerEvent) => {
    // Still deciding: movement before the hold completes means the finger is
    // swiping, not picking a bullet up. Stand down and leave it to the swipe,
    // which has been tracking the same pointer all along.
    const p = pending.current;
    if (p) {
      if (Math.abs(e.clientX - p.x) > HOLD_SLOP_PX || Math.abs(e.clientY - p.y) > HOLD_SLOP_PX) {
        clearHold();
      }
      return;
    }
    const i = info.current;
    if (!i || dragId === null) return;
    dy.current = e.clientY - i.startY;
    const dx = e.clientX - i.startX;
    // Past a few pixels this is a drag, not a tap that wobbled.
    if (Math.abs(dx) > 4 || Math.abs(dy.current) > 4) swallowClick.current = true;

    // 1:1 with the finger, written straight to the DOM.
    blockEls.current.forEach(el => {
      el.style.transform = `translateY(${dy.current}px)`;
      el.style.zIndex = '4';
    });

    // Where the block's top edge now sits, measured against the rows that are
    // NOT moving — a row inside the block would compare the block with itself.
    const top = i.blockTop + dy.current;
    const rest = i.rows.filter((_, k) => k < i.index || k >= i.index + i.len);
    let at = 0;
    for (const r of rest) {
      if (r.top + r.height / 2 < top) at += 1; else break;
    }

    const restItems = items.filter((_, k) => k < i.index || k >= i.index + i.len);
    const want = i.startDepth + Math.round(dx / step);
    const clamped = Math.max(0, Math.min(want, maxDepthAt(restItems, at)));

    setTarget(prev => (prev === at ? prev : at));
    setDepth(prev => (prev === clamped ? prev : clamped));
  }, [dragId, items, step, clearHold]);

  const end = useCallback(() => {
    // A press released before the hold fired was a tap, and taps belong to
    // whatever is under them.
    if (pending.current) { clearHold(); return; }
    const i = info.current;
    blockEls.current.forEach(el => {
      el.style.transform = '';
      el.style.transition = '';
      el.style.zIndex = '';
    });
    blockEls.current = [];
    if (i && dragId !== null && target !== null) {
      // One frame with transitions off: the array reorders and every transform
      // clears together, so the reflow and the reset cancel instead of the row
      // visibly jumping back before settling.
      setSettling(true);
      requestAnimationFrame(() => setSettling(false));
      onDrop(i.index, target, depth);
    }
    info.current = null;
    dy.current = 0;
    setDragId(null);
    setTarget(null);
  }, [dragId, target, depth, onDrop, clearHold]);

  /**
   * How far a row shifts to open the gap. Rows inside the block are moved by
   * the transform above, so they report 0 here and are not double-counted.
   */
  const offsetFor = useCallback((index: number): number => {
    const i = info.current;
    if (!i || dragId === null || target === null) return 0;
    if (index >= i.index && index < i.index + i.len) return 0;
    const slot = index < i.index ? index : index - i.len;
    if (target < i.index && slot >= target && slot < i.index) return i.blockHeight;
    if (target > i.index && slot >= i.index && slot < target) return -i.blockHeight;
    return 0;
  }, [dragId, target]);

  /**
   * Attach in the CAPTURE phase, on the row. Bubble is too late: the row's own
   * click handler is on a descendant and would already have run.
   */
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const inBlock = useCallback((index: number): boolean => {
    const i = info.current;
    return !!i && dragId !== null && index >= i.index && index < i.index + i.len;
  }, [dragId]);

  return {
    dragId, depth, settling,
    onPointerDown: press, onPointerMove: move, onPointerUp: end,
    onClickCapture, offsetFor, inBlock,
  };
}
