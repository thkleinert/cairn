import { useRef } from 'react';

export function useSwipeToClose(onClose: () => void) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const dragging = useRef(false);

  function onTouchStart(e: React.TouchEvent) {
    startY.current = e.touches[0].clientY;
    dragging.current = true;
    const el = sheetRef.current;
    if (el) el.style.transition = 'none';
  }

  function onTouchMove(e: React.TouchEvent) {
    if (!dragging.current) return;
    const delta = e.touches[0].clientY - startY.current;
    if (delta <= 0) return;
    const el = sheetRef.current;
    if (el) el.style.transform = `translateY(${delta}px)`;
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (!dragging.current) return;
    dragging.current = false;
    const delta = e.changedTouches[0].clientY - startY.current;
    const el = sheetRef.current;
    if (!el) return;
    if (delta > 100) {
      el.style.transition = 'transform 0.28s cubic-bezier(0.32,0.72,0,1)';
      el.style.transform = 'translateY(120%)';
      setTimeout(onClose, 260);
    } else {
      el.style.transition = 'transform 0.22s ease';
      el.style.transform = '';
      setTimeout(() => { if (sheetRef.current) sheetRef.current.style.transition = ''; }, 220);
    }
  }

  return {
    sheetRef,
    handleProps: { onTouchStart, onTouchMove, onTouchEnd },
  };
}
