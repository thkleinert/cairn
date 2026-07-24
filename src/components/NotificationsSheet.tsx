import { MapPin, MessageCircle, Bell } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import type { Notification } from '../hooks/useNotifications';

interface Props {
  notifications: Notification[];
  unreadCount: number;
  onSelect: (n: Notification) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
}

function authorName(email: string): string {
  return email.split('@')[0];
}

export function NotificationsSheet({ notifications, unreadCount, onSelect, onMarkAllRead, onClose }: Props) {
  const { sheetRef, handleProps } = useSwipeToClose(onClose);
  useEscapeClose(onClose);

  return (
    <div className="bottom-sheet-overlay" onClick={onClose}>
      <div
        className="bottom-sheet"
        ref={sheetRef}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Activity"
      >
        <div className="bottom-sheet-handle" {...handleProps} />
        <div className="sheet-header-row">
          <h2 className="bottom-sheet-title">Activity</h2>
          {unreadCount > 0 && (
            <button className="notif-mark-all" onClick={onMarkAllRead}>
              Mark all read
            </button>
          )}
        </div>

        {notifications.length === 0 ? (
          <div className="notif-empty">
            <Bell size={40} color="var(--color-muted)" />
            <p>You're all caught up</p>
            <p className="notif-empty-hint">Updates from your trips show up here.</p>
          </div>
        ) : (
          <ul className="notif-list">
            {notifications.map(n => (
              <li key={n.id}>
                <button
                  className={`notif-row ${n.read ? '' : 'notif-row--unread'}`}
                  onClick={() => onSelect(n)}
                >
                  <span className={`notif-icon notif-icon--${n.type}`}>
                    {n.type === 'place_added' ? <MapPin size={16} /> : <MessageCircle size={16} />}
                  </span>
                  <div className="notif-body">
                    <p className="notif-text">
                      <strong>{authorName(n.actor_email)}</strong>
                      {n.type === 'place_added' ? ' added ' : ' commented on '}
                      <strong>{n.place_name}</strong>
                      {' in '}
                      {n.trip_name}
                    </p>
                    {n.snippet && <p className="notif-snippet">“{n.snippet}”</p>}
                    <p className="notif-time">
                      {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                    </p>
                  </div>
                  {!n.read && <span className="notif-dot" aria-label="Unread" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
