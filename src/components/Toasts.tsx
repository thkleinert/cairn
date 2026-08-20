import { useSyncExternalStore } from 'react';
import { AlertCircle, CheckCircle, Info } from 'lucide-react';
import { subscribeToasts, getToasts, dismissToast } from '../lib/toast';

const ICONS = {
  error: <AlertCircle size={16} />,
  success: <CheckCircle size={16} />,
  info: <Info size={16} />,
};

export function Toasts() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast--${t.type}`}>
          {ICONS[t.type]}
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => { dismissToast(t.id); t.action!.run(); }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
