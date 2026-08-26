import { useState, useRef, useEffect } from 'react';
import { Plus, MapPin, LogOut, Calendar, Bell, Users } from 'lucide-react';
import type { Trip } from '../types';
import { useTrips } from '../hooks/useTrips';
import { useAuth } from '../hooks/useAuth';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { useNotifications, type Notification } from '../hooks/useNotifications';
import { NotificationsSheet } from './NotificationsSheet';
import { toast } from '../lib/toast';
import { DateRangeField } from './DateRangeField';
import { format, parseISO } from 'date-fns';

interface Props {
  userId: string;
  onSelectTrip: (trip: Trip, target?: { placeId?: string; openComments?: boolean }) => void;
}

// Deterministic per-trip seed so each card's route motif is stable across renders
function routeSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

// Abstract route line standing in for a cover photo — echoes the map
// without needing trip data we don't have on this screen
function RouteMotif({ seed }: { seed: number }) {
  const y1 = 20 + (seed % 30);
  const y2 = 10 + ((seed >>> 3) % 40);
  const y3 = 14 + ((seed >>> 6) % 36);
  const d = `M10 ${y1} Q 100 ${y2}, 150 ${(y1 + y3) / 2} T 290 ${y3}`;
  return (
    <svg viewBox="0 0 300 72" preserveAspectRatio="none" className="trip-route-svg" aria-hidden="true">
      <path className="trip-route-path" d={d} />
      <circle className="trip-route-dot" cx="10" cy={y1} r="3" style={{ animationDelay: '650ms' }} />
      <circle className="trip-route-dot" cx="290" cy={y3} r="3" style={{ animationDelay: '780ms' }} />
    </svg>
  );
}

export function TripList({ userId, onSelectTrip }: Props) {
  const { trips, loading, createTrip } = useTrips(userId);
  const { signOut } = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [compact, setCompact] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const scrollRef = useRef<HTMLUListElement>(null);

  const { notifications, unreadCount, dismissNotification, markAllRead } = useNotifications();

  // Tapping a notification dismisses just that one and jumps to its place;
  // opening/closing the panel no longer dismisses anything on its own — that's
  // what the explicit "Mark all read" button is for. Resolve the trip BEFORE
  // dismissing: if it isn't navigable (list still loading, or you've since
  // left the trip), destroying the notification without going anywhere would
  // make the tap silently eat it.
  const handleActivityClick = (n: Notification) => {
    const trip = trips.find(t => t.id === n.trip_id);
    if (!trip) {
      toast('That trip is unavailable');
      return;
    }
    dismissNotification(n.id);
    setShowNotifications(false);
    onSelectTrip(trip, {
      placeId: n.place_id,
      openComments: n.type === 'comment_added',
    });
  };

  useEscapeClose(() => setShowCreate(false));

  // Large title collapses once the list actually scrolls — motion tied
  // to real state, not a decorative timer
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setCompact(el.scrollTop > 8);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [loading, trips.length]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setCreateError('');
    try {
      const trip = await createTrip(name.trim(), undefined, startDate || undefined, endDate || undefined);
      setShowCreate(false);
      setName('');
      setStartDate('');
      setEndDate('');
      if (trip) onSelectTrip(trip);
    } catch (err: unknown) {
      const msg = err instanceof Error && err.message
        ? err.message
        : 'Could not create trip. Please try again.';
      setCreateError(msg);
    } finally {
      setCreating(false);
    }
  };

  const handleSignOut = () => {
    if (!confirmSignOut) {
      setConfirmSignOut(true);
      setTimeout(() => setConfirmSignOut(false), 3000);
      return;
    }
    signOut();
  };

  return (
    <div className="trip-list-screen">
      <header className={`trip-list-header ${compact ? 'trip-list-header--compact' : ''}`}>
        <div className="trip-list-heading">
          <h1 className="trip-list-title">My Trips</h1>
          <span className="trip-list-rule" aria-hidden="true" />
        </div>
        <div className="trip-list-actions">
          <button
            className="btn-icon notif-bell"
            onClick={() => setShowNotifications(true)}
            aria-label={unreadCount > 0 ? 'Activity, unread' : 'Activity'}
          >
            <Bell size={20} />
            {unreadCount > 0 && <span className="notif-dot-badge" aria-hidden="true" />}
          </button>
          <button
            className={`btn-icon ${confirmSignOut ? 'btn-icon--danger' : ''}`}
            onClick={handleSignOut}
            aria-label={confirmSignOut ? 'Tap again to sign out' : 'Sign out'}
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>
      {confirmSignOut && <p className="signout-hint">Tap again to sign out</p>}

      {loading ? (
        <div className="trip-cards">
          {[0, 1, 2].map(i => (
            <div key={i} className="skeleton-card" style={{ animationDelay: `${i * 0.12}s` }} />
          ))}
        </div>
      ) : trips.length === 0 ? (
        <div className="empty-state">
          <MapPin size={48} color="var(--color-muted)" />
          <p>No trips yet</p>
          <p className="empty-state-hint">Tap the + button to create one</p>
        </div>
      ) : (
        <ul className="trip-cards" ref={scrollRef}>
          {trips.map(trip => (
            <li key={trip.id}>
              <button className="trip-card" onClick={() => onSelectTrip(trip)}>
                {trip.cover_image_url ? (
                  <img src={trip.cover_image_url} alt="" className="trip-card-image" />
                ) : (
                  <div className="trip-card-route">
                    <RouteMotif seed={routeSeed(trip.id)} />
                  </div>
                )}
                <div className="trip-card-body">
                  <div className="trip-card-title-row">
                    <h2 className="trip-card-name">{trip.name}</h2>
                    {trip.is_shared && (
                      <span className="trip-card-shared">
                        <Users size={12} /> Shared
                      </span>
                    )}
                  </div>
                  {(trip.start_date || trip.end_date) && (
                    <div className="trip-card-meta">
                      <Calendar size={12} />
                      <span>
                        {trip.start_date && format(parseISO(trip.start_date), 'MMM d, yyyy')}
                        {trip.start_date && trip.end_date && ' – '}
                        {trip.end_date && format(parseISO(trip.end_date), 'MMM d, yyyy')}
                      </span>
                    </div>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="trip-list-fab-wrap">
        <button className="trip-list-fab" onClick={() => setShowCreate(true)} aria-label="New trip">
          <Plus size={26} />
        </button>
      </div>

      {showNotifications && (
        <NotificationsSheet
          notifications={notifications}
          unreadCount={unreadCount}
          onSelect={handleActivityClick}
          onDismiss={dismissNotification}
          onMarkAllRead={markAllRead}
          onClose={() => setShowNotifications(false)}
        />
      )}

      {showCreate && (
        <div className="bottom-sheet-overlay" onClick={() => setShowCreate(false)}>
          <div
            className="bottom-sheet"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="New trip"
          >
            <div className="bottom-sheet-handle" />
            <h2 className="bottom-sheet-title">New Trip</h2>
            <form onSubmit={handleCreate} className="create-trip-form">
              <input
                className="input"
                placeholder="Trip name"
                value={name}
                onChange={e => setName(e.target.value)}
                autoFocus
                required
              />
              <DateRangeField
                label="Dates"
                title="When is this trip?"
                value={startDate ? { start: startDate, end: endDate || null } : null}
                onChange={range => { setStartDate(range?.start ?? ''); setEndDate(range?.end ?? ''); }}
                year={new Date().getFullYear()}
                clearable
              />
              {createError && <p className="error-text">{createError}</p>}
              <div className="form-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={creating}>
                  {creating ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
