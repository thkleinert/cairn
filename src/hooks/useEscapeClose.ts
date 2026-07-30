import { useEffect, useRef } from 'react';

// Close overlays with the Escape key (desktop / keyboard users).
//
// One window listener over a module-level stack of open layers: each mounted
// overlay registers itself, and Escape closes only the TOPMOST one. With
// independent listeners (the old shape), a single Escape fired them all —
// place sheet + tag picker + lightbox all dismissed at once.
type Entry = { close: () => void };
const stack: Entry[] = [];
let listening = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || stack.length === 0) return;
  stack[stack.length - 1].close();
}

export function useEscapeClose(onClose: () => void) {
  // Latest-callback ref: the stack entry is registered once per mount (mount
  // order == stacking order); re-registering on every onClose identity change
  // would reshuffle the stack under a parent re-render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const entry: Entry = { close: () => closeRef.current() };
    stack.push(entry);
    if (!listening) {
      window.addEventListener('keydown', onKeyDown);
      listening = true;
    }
    return () => {
      const i = stack.indexOf(entry);
      if (i !== -1) stack.splice(i, 1);
      if (stack.length === 0 && listening) {
        window.removeEventListener('keydown', onKeyDown);
        listening = false;
      }
    };
  }, []);
}
