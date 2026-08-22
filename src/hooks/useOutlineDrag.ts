import { useState, useRef, useCallback } from 'react';
import { maxDepthAt } from '../lib/outline';

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

  const start = useCallback((index: number, row: HTMLElement, e: React.PointerEvent) => {
    if (!enabled) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const parent = row.parentElement;
    const all = Array.from(parent?.children ?? []).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.tagName === row.tagName,
    );
    const rects = all.map(el => el.getBoundingClientRect());
    const len = blockLength(index);
    const block = all.slice(index, index + len);

    info.current = {
      startX: e.clientX,
      startY: e.clientY,
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
    setDragId(items[index]?.id ?? null);
    setTarget(index);
    setDepth(items[index]?.depth ?? 0);
  }, [enabled, items, blockLength]);

  const move = useCallback((e: React.PointerEvent) => {
    const i = info.current;
    if (!i || dragId === null) return;
    dy.current = e.clientY - i.startY;
    const dx = e.clientX - i.startX;

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
  }, [dragId, items, step]);

  const end = useCallback(() => {
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
  }, [dragId, target, depth, onDrop]);

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

  const inBlock = useCallback((index: number): boolean => {
    const i = info.current;
    return !!i && dragId !== null && index >= i.index && index < i.index + i.len;
  }, [dragId]);

  return {
    dragId, depth, settling,
    onPointerDown: start, onPointerMove: move, onPointerUp: end,
    offsetFor, inBlock,
  };
}
