import { useRef, useState } from 'react';
import { MapPin, MessageCircle, Bell, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import type { Notification } from '../hooks/useNotifications';
import { authorName } from '../lib/people';

interface Props {
  notifications: Notification[];
  unreadCount: number;
  onSelect: (n: Notification) => void;
  onDismiss: (id: string) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
}

const THRESHOLD = 80; // px of horizontal travel to commit a swipe action

// A single notification row that can be swiped left past the threshold to
// dismiss it — the item just leaves the inbox, same as tapping through to its
// place. A short drag that doesn't cross the threshold snaps back; a rightward
// drag is ignored; a plain tap (no real drag) falls through to onSelect. Behind
// the row sits the dismiss lane it slides over.
function SwipeableNotification({
  n, onSelect, onDismiss,
}: {
  n: Notification;
  onSelect: (n: Notification) => void;
  onDismiss: (id: string) => void;
}) {
  const [dx, setDx] = useState(0);
  const [exiting, setExiting] = useState(false);
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
    // Left-only: clamp rightward drag to 0 so the row never reveals empty space.
    const delta = Math.min(0, e.clientX - startX.current);
    if (Math.abs(delta) > 6) swiped.current = true;
    dxRef.current = delta;
    setDx(delta);
  };

  const finish = () => {
    setExiting(true);
    // let the row slide off, then hand off to the parent to actually remove it
    setTimeout(() => onDismiss(n.id), 180);
  };

  const onPointerUp = () => {
    dragging.current = false;
    const delta = dxRef.current;
    dxRef.current = 0;
    if (delta <= -THRESHOLD) finish();
    else setDx(0);
  };

  // The row has touch-action: pan-y, so a drag that drifts vertical hands the
  // gesture to the scroller and fires pointercancel instead of pointerup.
  // Without this reset the row froze mid-swipe and — because dxRef kept its
  // last value — the NEXT plain tap on the row could read as a completed
  // swipe and dismiss the notification instead of opening it.
  const onPointerCancel = () => {
    dragging.current = false;
    dxRef.current = 0;
    setDx(0);
  };

  const translate = exiting ? -600 : dx;
  const revealing = translate < 0;

  return (
    <li className="notif-swipe">
      <div className={`notif-lane notif-lane--delete ${revealing ? 'is-active' : ''}`}>
        Dismiss <Trash2 size={18} />
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
        onPointerCancel={onPointerCancel}
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
  notifications, unreadCount, onSelect, onDismiss, onMarkAllRead, onClose,
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
                  onDismiss={onDismiss}
                />
              ))}
            </ul>
            <p className="notif-swipe-hint">Swipe left to dismiss</p>
          </>
        )}
      </div>
    </div>
  );
}
