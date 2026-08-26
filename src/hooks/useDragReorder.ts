import { useState, useRef, useCallback, useEffect, useMemo } from 'react';

/** Move one element, returning a new array. Shared so a previewed drop and the
 *  real one cannot drift apart. */
function moveWithin<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

interface Options<T> {
  items: T[];
  getId: (item: T) => string;
  /**
   * `sidewaysPx` is how far the row was dragged horizontally when it was let
   * go — only ever non-zero when `trackSideways` is on. Callers that nest use
   * it to decide whether the drop also changed what the row belongs to; the
   * flat lists ignore it entirely.
   */
  onReorder: (orderedIds: string[], sidewaysPx?: number) => void;
  enabled: boolean;
  /**
   * Follow horizontal movement as well as vertical, Notion-style: drag a row
   * right to tuck it under the one above, left to pull it back out. Off by
   * default so a list with no hierarchy can't be nudged into one by a shaky
   * thumb, and so those lists keep ignoring horizontal movement completely.
   */
  trackSideways?: boolean;
  /**
   * How far sideways counts as one level, so the hook can report the LEVEL a
   * drop would land at rather than a pixel count.
   *
   * The distinction is the whole point: a pixel count changes on every
   * pointermove and re-renders every row in the list — thumbnails and tag
   * pills included — for a preview that only ever has three states.
   */
  sidewaysStep?: number;
}

/**
 * The minimum a drag needs to know about where it began.
 *
 * A React.PointerEvent satisfies this, so every existing caller is unchanged —
 * but a drag that starts on a TIMER rather than on the event itself has no
 * live event left to hand over, only the numbers copied out of it. See
 * useLongPressDrag.
 */
export interface DragPoint {
  clientX: number;
  clientY: number;
  pointerId: number;
  target: EventTarget | null;
  preventDefault: () => void;
}

interface DragInfo {
  startX: number;
  startY: number;
  startIndex: number;
  height: number;     // dragged row's height == the gap siblings open
  heights: number[];  // every row's height at drag start (rows vary: thumbs,
                      // address lines, tag pills — quantizing by the dragged
                      // row's height alone drops rows at the wrong index)
}

// Manual pointer-based reorder — no library. The dragged row's transform
// is driven by raw pointer deltas outside React state for 1:1 tracking;
// siblings shift by the dragged row's own height to open a gap, animated
// via a plain CSS transition. On drop, the dragged row first glides into
// the open gap, then — once settled — the array reorders and every
// transform clears in the same frame with transitions suppressed, so the
// DOM reflow and the transform reset exactly cancel out with no jump.
export function useDragReorder<T>({ items, getId, onReorder, enabled, trackSideways = false, sidewaysStep = 36 }: Options<T>) {
  const [order, setOrder] = useState(items);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [suppressTransition, setSuppressTransition] = useState(false);
  // Which way a drop would move the row: -1 out, 0 nowhere, 1 in. State,
  // because the preview has to render — but only three values, so it settles
  // instead of changing every frame.
  const [dragLevel, setDragLevel] = useState<-1 | 0 | 1>(0);
  // The raw offset, which the drop itself needs. A ref: nothing renders from
  // it, so writing it per move costs nothing.
  const dragDxRef = useRef(0);
  const dragInfo = useRef<DragInfo | null>(null);
  const draggedElRef = useRef<HTMLElement | null>(null);
  const pendingCommitRef = useRef<{ timer: number; run: () => void } | null>(null);

  useEffect(() => {
    if (dragId === null) setOrder(items);
  }, [items, dragId]);

  useEffect(() => {
    if (!suppressTransition) return;
    const raf = requestAnimationFrame(() => setSuppressTransition(false));
    return () => cancelAnimationFrame(raf);
  }, [suppressTransition]);

  // Sum of the row heights the dragged row travels past between two indices —
  // the correct glide distance when rows have different heights.
  const travelPx = useCallback((from: number, to: number, heights: number[]): number => {
    if (to === from) return 0;
    let px = 0;
    if (to > from) {
      for (let i = from + 1; i <= to; i++) px += heights[i] ?? 0;
    } else {
      for (let i = to; i < from; i++) px -= heights[i] ?? 0;
    }
    return px;
  }, []);

  const handlePointerDown = useCallback((id: string, index: number, row: HTMLElement, e: DragPoint) => {
    if (!enabled) return;
    // A drag begun inside a previous drop's glide window must not be wiped
    // by that drop's deferred commit — flush it now instead.
    if (pendingCommitRef.current) {
      clearTimeout(pendingCommitRef.current.timer);
      pendingCommitRef.current.run();
      pendingCommitRef.current = null;
    }
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    draggedElRef.current = row;
    const siblings = Array.from(row.parentElement?.children ?? []).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.tagName === row.tagName
    );
    dragInfo.current = {
      startX: e.clientX,
      startY: e.clientY,
      startIndex: index,
      height: row.getBoundingClientRect().height,
      heights: siblings.map(el => el.getBoundingClientRect().height),
    };
    row.style.transition = 'none';
    setDragId(id);
    setOverIndex(index);
    setDragLevel(0);
    dragDxRef.current = 0;
  }, [enabled]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const info = dragInfo.current;
    if (!info || !draggedElRef.current) return;
    const deltaY = e.clientY - info.startY;
    // Horizontal travel is carried on the transform only when the caller asked
    // for it; otherwise the row tracks vertically exactly as it always has.
    const deltaX = trackSideways ? e.clientX - info.startX : 0;
    if (trackSideways) {
      dragDxRef.current = deltaX;
      const level = deltaX >= sidewaysStep ? 1 : deltaX <= -sidewaysStep ? -1 : 0;
      setDragLevel(prev => (prev === level ? prev : level));
    }
    draggedElRef.current.style.transform =
      `translate(${deltaX}px, ${deltaY}px) scale(1.02)`;
    // Walk row by row using each passed row's own height: crossing more than
    // half of a neighbour claims its slot.
    let newIndex = info.startIndex;
    if (deltaY > 0) {
      let acc = 0;
      for (let i = info.startIndex + 1; i < order.length; i++) {
        const h = info.heights[i] ?? info.height;
        if (deltaY > acc + h / 2) { acc += h; newIndex = i; } else break;
      }
    } else if (deltaY < 0) {
      let acc = 0;
      for (let i = info.startIndex - 1; i >= 0; i--) {
        const h = info.heights[i] ?? info.height;
        if (-deltaY > acc + h / 2) { acc += h; newIndex = i; } else break;
      }
    }
    setOverIndex(prev => (prev === newIndex ? prev : newIndex));
  }, [order.length, trackSideways, sidewaysStep]);

  const handlePointerUp = useCallback(() => {
    const info = dragInfo.current;
    const el = draggedElRef.current;
    if (!info || dragId === null || !el) return;
    // Re-derived rather than read from `info`. A commit is deferred while the
    // row glides home, and grabbing a second row inside that window flushes
    // the pending one — which reorders `order` AFTER handlePointerDown
    // recorded this row's index against the pre-flush list. The stale index
    // then moved whichever row had landed in that slot, while the row under
    // the finger sat still.
    const liveStart = order.findIndex(i => getId(i) === dragId);
    const startIndex = liveStart === -1 ? info.startIndex : liveStart;
    const finalIndex = overIndex ?? startIndex;
    const droppedDx = trackSideways ? dragDxRef.current : 0;
    const settledOffset = travelPx(info.startIndex, finalIndex, info.heights);

    const commit = () => {
      el.style.transition = 'none';
      el.style.transform = '';
      setDragLevel(0);
      dragDxRef.current = 0;
      // Restore the stylesheet transition next frame — leaving 'none' behind
      // permanently made every later drag of this row snap instead of slide.
      requestAnimationFrame(() => { el.style.transition = ''; });
      setSuppressTransition(true);
      // A sideways drag is a real change even when the row did not move up or
      // down, so the commit can't be skipped on index alone any more.
      const movedSideways = trackSideways && Math.abs(droppedDx) > 0;
      if (finalIndex !== startIndex || movedSideways) {
        const next = moveWithin(order, startIndex, finalIndex);
        setOrder(next);
        onReorder(next.map(getId), droppedDx);
      }
      dragInfo.current = null;
      draggedElRef.current = null;
      setDragId(null);
      setOverIndex(null);
    };

    if (settledOffset === 0) {
      el.style.transition = 'transform 0.25s var(--spring-bounce)';
      el.style.transform = '';
      commit();
    } else {
      // Glide into the open gap first, then swap the DOM order
      el.style.transition = 'transform 0.25s var(--spring-bounce)';
      el.style.transform = `translateY(${settledOffset}px)`;
      const timer = window.setTimeout(() => {
        pendingCommitRef.current = null;
        commit();
      }, 250);
      pendingCommitRef.current = { timer, run: commit };
    }
  }, [dragId, order, overIndex, getId, onReorder, travelPx, trackSideways]);

  // Pixel offset applied to a non-dragged row so it slides out of the
  // dragged row's way — 0 for everything outside the affected range.
  // The gap siblings open is the dragged row's height (that's the space it
  // vacates/needs), regardless of their own heights.
  const getRowOffsetPx = useCallback((index: number, id: string): number => {
    if (dragId === null || overIndex === null || !dragInfo.current || id === dragId) return 0;
    const startIndex = order.findIndex(i => getId(i) === dragId);
    if (startIndex === -1) return 0;
    const h = dragInfo.current.height;
    if (startIndex < overIndex && index > startIndex && index <= overIndex) return -h;
    if (startIndex > overIndex && index < startIndex && index >= overIndex) return h;
    return 0;
  }, [dragId, overIndex, order, getId]);

  // The order a drop RIGHT NOW would produce. commit builds its array with the
  // same helper from the same two indices, so a caller previewing the drop is
  // reading exactly what the drop will act on.
  //
  // Without this a preview had to guess from `order`, which does not move
  // during a drag — only `overIndex` does. Any drag with both a vertical and a
  // sideways component then previewed against the row's ORIGINAL neighbours:
  // dragging the top row down and right showed no nest and then nested, and
  // dragging the bottom row up and right showed a nest and then did nothing.
  const projectedOrder = useMemo(() => {
    if (dragId === null || overIndex === null) return order;
    // Same re-derivation as commit, for the same reason.
    const start = order.findIndex(i => getId(i) === dragId);
    if (start === -1) return order;
    return moveWithin(order, start, overIndex);
  }, [dragId, overIndex, order, getId]);

  return { order, projectedOrder, dragId, dragLevel, suppressTransition, handlePointerDown, handlePointerMove, handlePointerUp, getRowOffsetPx };
}
