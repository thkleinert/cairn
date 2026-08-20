// Minimal pub/sub toast store — usable from hooks and non-React modules
export type ToastType = 'error' | 'success' | 'info';

// An optional single action on a toast — the undo affordance for anything
// destructive that happens without a confirmation step. A swipe that deletes a
// bullet has no dialog to say no in, so the toast is where "no" lives.
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

type Listener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach(l => l(toasts));
}

export function toast(message: string, type: ToastType = 'error', action?: ToastAction) {
  const item: ToastItem = { id: nextId++, message, type, action };
  toasts = [...toasts, item];
  emit();
  // An actionable toast lingers: 3.5s is enough to read a failure, not enough
  // to notice a mistake and reach for Undo on a phone.
  setTimeout(() => dismissToast(item.id), action ? 7000 : 3500);
}

export function dismissToast(id: number) {
  toasts = toasts.filter(t => t.id !== id);
  emit();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getToasts() {
  return toasts;
}
