import { useRef, useState } from 'react';
import { MapPin, MessageCircle, Bell, Check, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import type { Notification } from '../hooks/useNotifications';

interface Props {
  notifications: Notification[];
  unreadCount: number;
  onSelect: (n: Notification) => void;
  onRead: (id: string) => void;
  onDelete: (id: string) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
}

function authorName(email: string): string {
  return email.split('@')[0];
}

const THRESHOLD = 80; // px of horizontal travel to commit a swipe action

// A single notification row that can be swiped: right past the threshold marks
// it read, left past the threshold deletes it. A short drag that doesn't cross
// the threshold snaps back; a plain tap (no real drag) falls through to
// onSelect. Behind the row sit the two coloured action lanes it slides over.
function SwipeableNotification({
  n, onSelect, onRead, onDelete,
}: {
  n: Notification;
  onSelect: (n: Notification) => void;
  onRead: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [dx, setDx] = useState(0);
  const [exiting, setExiting] = useState<null | 'read' | 'delete'>(null);
  const startX = useRef(0);
  const dragging = useRef(false);
  const swiped = useRef(false);
  // Mirror the live offset in a ref so onPointerUp reads the committed value
  // regardless of React's async state flushing between move and up.
  const dxRef = useRef(0);

  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    swiped.current = false;
    startX.current = e.clientX;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const delta = e.clientX - startX.current;
    if (Math.abs(delta) > 6) swiped.current = true;
    dxRef.current = delta;
    setDx(delta);
  };

  const finish = (dir: 'read' | 'delete') => {
    setExiting(dir);
    // let the row slide off, then hand off to the parent to actually remove it
    setTimeout(() => (dir === 'read' ? onRead(n.id) : onDelete(n.id)), 180);
  };

  const onPointerUp = () => {
    dragging.current = false;
    const delta = dxRef.current;
    dxRef.current = 0;
    if (delta >= THRESHOLD) finish('read');
    else if (delta <= -THRESHOLD) finish('delete');
    else setDx(0);
  };

  const translate = exiting === 'read' ? 600 : exiting === 'delete' ? -600 : dx;
  const revealing = translate > 0 ? 'read' : translate < 0 ? 'delete' : null;

  return (
    <li className="notif-swipe">
      <div className={`notif-lane notif-lane--read ${revealing === 'read' ? 'is-active' : ''}`}>
        <Check size={18} /> Read
      </div>
      <div className={`notif-lane notif-lane--delete ${revealing === 'delete' ? 'is-active' : ''}`}>
        Delete <Trash2 size={18} />
      </div>
      <button
        className="notif-row"
        style={{
          transform: `translateX(${translate}px)`,
          transition: dragging.current ? 'none' : 'transform 0.18s ease',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={() => { if (!swiped.current) onSelect(n); }}
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
      </button>
    </li>
  );
}

export function NotificationsSheet({
  notifications, unreadCount, onSelect, onRead, onDelete, onMarkAllRead, onClose,
}: Props) {
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
          <>
            <ul className="notif-list">
              {notifications.map(n => (
                <SwipeableNotification
                  key={n.id}
                  n={n}
                  onSelect={onSelect}
                  onRead={onRead}
                  onDelete={onDelete}
                />
              ))}
            </ul>
            <p className="notif-swipe-hint">Swipe right to mark read · left to delete</p>
          </>
        )}
      </div>
    </div>
  );
}
