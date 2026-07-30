import { useState, useRef, useCallback, useEffect } from 'react';

interface Options<T> {
  items: T[];
  getId: (item: T) => string;
  onReorder: (orderedIds: string[]) => void;
  enabled: boolean;
}

interface DragInfo {
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
export function useDragReorder<T>({ items, getId, onReorder, enabled }: Options<T>) {
  const [order, setOrder] = useState(items);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [suppressTransition, setSuppressTransition] = useState(false);
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

  const handlePointerDown = useCallback((id: string, index: number, row: HTMLElement, e: React.PointerEvent) => {
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
      startY: e.clientY,
      startIndex: index,
      height: row.getBoundingClientRect().height,
      heights: siblings.map(el => el.getBoundingClientRect().height),
    };
    row.style.transition = 'none';
    setDragId(id);
    setOverIndex(index);
  }, [enabled]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const info = dragInfo.current;
    if (!info || !draggedElRef.current) return;
    const deltaY = e.clientY - info.startY;
    draggedElRef.current.style.transform = `translateY(${deltaY}px) scale(1.02)`;
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
  }, [order.length]);

  const handlePointerUp = useCallback(() => {
    const info = dragInfo.current;
    const el = draggedElRef.current;
    if (!info || dragId === null || !el) return;
    const finalIndex = overIndex ?? info.startIndex;
    const settledOffset = travelPx(info.startIndex, finalIndex, info.heights);

    const commit = () => {
      el.style.transition = 'none';
      el.style.transform = '';
      // Restore the stylesheet transition next frame — leaving 'none' behind
      // permanently made every later drag of this row snap instead of slide.
      requestAnimationFrame(() => { el.style.transition = ''; });
      setSuppressTransition(true);
      if (finalIndex !== info.startIndex) {
        const next = [...order];
        const [moved] = next.splice(info.startIndex, 1);
        next.splice(finalIndex, 0, moved);
        setOrder(next);
        onReorder(next.map(getId));
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
  }, [dragId, order, overIndex, getId, onReorder, travelPx]);

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

  return { order, dragId, suppressTransition, handlePointerDown, handlePointerMove, handlePointerUp, getRowOffsetPx };
}
