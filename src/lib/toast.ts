// Minimal pub/sub toast store — usable from hooks and non-React modules
export type ToastType = 'error' | 'success' | 'info';

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

type Listener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach(l => l(toasts));
}

export function toast(message: string, type: ToastType = 'error') {
  const item: ToastItem = { id: nextId++, message, type };
  toasts = [...toasts, item];
  emit();
  setTimeout(() => {
    toasts = toasts.filter(t => t.id !== item.id);
    emit();
  }, 3500);
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getToasts() {
  return toasts;
}
