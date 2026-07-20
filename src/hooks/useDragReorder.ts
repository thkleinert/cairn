import { useState, useRef, useCallback, useEffect } from 'react';

interface Options<T> {
  items: T[];
  getId: (item: T) => string;
  onReorder: (orderedIds: string[]) => void;
  enabled: boolean;
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
  const dragInfo = useRef<{ startY: number; startIndex: number; height: number } | null>(null);
  const draggedElRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (dragId === null) setOrder(items);
  }, [items, dragId]);

  useEffect(() => {
    if (!suppressTransition) return;
    const raf = requestAnimationFrame(() => setSuppressTransition(false));
    return () => cancelAnimationFrame(raf);
  }, [suppressTransition]);

  const handlePointerDown = useCallback((id: string, index: number, row: HTMLElement, e: React.PointerEvent) => {
    if (!enabled) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    draggedElRef.current = row;
    dragInfo.current = { startY: e.clientY, startIndex: index, height: row.getBoundingClientRect().height };
    row.style.transition = 'none';
    setDragId(id);
    setOverIndex(index);
  }, [enabled]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const info = dragInfo.current;
    if (!info || !draggedElRef.current) return;
    const deltaY = e.clientY - info.startY;
    draggedElRef.current.style.transform = `translateY(${deltaY}px) scale(1.02)`;
    const steps = Math.round(deltaY / info.height);
    const newIndex = Math.min(Math.max(info.startIndex + steps, 0), order.length - 1);
    setOverIndex(prev => (prev === newIndex ? prev : newIndex));
  }, [order.length]);

  const handlePointerUp = useCallback(() => {
    const info = dragInfo.current;
    const el = draggedElRef.current;
    if (!info || dragId === null || !el) return;
    const finalIndex = overIndex ?? info.startIndex;
    const settledOffset = (finalIndex - info.startIndex) * info.height;

    const commit = () => {
      el.style.transition = 'none';
      el.style.transform = '';
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
      window.setTimeout(commit, 250);
    }
  }, [dragId, order, overIndex, getId, onReorder]);

  // Pixel offset applied to a non-dragged row so it slides out of the
  // dragged row's way — 0 for everything outside the affected range
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
