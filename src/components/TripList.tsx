import { useState } from 'react';
import { Plus, MapPin, LogOut } from 'lucide-react';
import type { Trip } from '../types';
import { useTrips } from '../hooks/useTrips';
import { useAuth } from '../hooks/useAuth';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { format, parseISO } from 'date-fns';

interface Props {
  userId: string;
  onSelectTrip: (trip: Trip) => void;
}

const STATUS_LABELS = {
  planning: 'Planning',
  ongoing: 'Ongoing',
  completed: 'Completed',
};

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

  useEscapeClose(() => setShowCreate(false));

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
      <header className="trip-list-header">
        <div>
          <h1 className="trip-list-title">My Trips</h1>
          {!loading && trips.length > 0 && (
            <p className="trip-list-count">{trips.length} trip{trips.length === 1 ? '' : 's'}</p>
          )}
        </div>
        <div className="trip-list-actions">
          <button
            className={`btn-icon ${confirmSignOut ? 'btn-icon--danger' : ''}`}
            onClick={handleSignOut}
            aria-label={confirmSignOut ? 'Tap again to sign out' : 'Sign out'}
          >
            <LogOut size={20} />
          </button>
          <button className="btn-icon" onClick={() => setShowCreate(true)} aria-label="New trip">
            <Plus size={24} />
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
          <button className="btn-primary" onClick={() => setShowCreate(true)}>Create your first trip</button>
        </div>
      ) : (
        <ul className="trip-cards">
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
                  <h2 className="trip-card-name">{trip.name}</h2>
                  <div className="trip-card-meta">
                    <span className={`status-dot status-dot--${trip.status}`} />
                    <span>{STATUS_LABELS[trip.status]}</span>
                    {trip.start_date && (
                      <>
                        <span className="meta-sep">·</span>
                        <span>
                          {format(parseISO(trip.start_date), 'MMM d, yyyy')}
                          {trip.end_date && ` – ${format(parseISO(trip.end_date), 'MMM d, yyyy')}`}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
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
              <div className="date-row">
                <label className="date-label">
                  <span>Start</span>
                  <input type="date" className="input" value={startDate} onChange={e => setStartDate(e.target.value)} />
                </label>
                <label className="date-label">
                  <span>End</span>
                  <input type="date" className="input" value={endDate} onChange={e => setEndDate(e.target.value)} />
                </label>
              </div>
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
