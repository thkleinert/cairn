import { useState } from 'react';
import { Plus, MapPin, Calendar, CheckCircle, Clock, Navigation, LogOut } from 'lucide-react';
import type { Trip } from '../types';
import { useTrips } from '../hooks/useTrips';
import { useAuth } from '../hooks/useAuth';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { format, parseISO } from 'date-fns';

interface Props {
  userId: string;
  onSelectTrip: (trip: Trip) => void;
}

const STATUS_ICONS = {
  planning: <Clock size={14} />,
  ongoing: <Navigation size={14} />,
  completed: <CheckCircle size={14} />,
};

const STATUS_LABELS = {
  planning: 'Planning',
  ongoing: 'Ongoing',
  completed: 'Completed',
};

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
        <h1 className="trip-list-title">My Trips</h1>
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
                {trip.cover_image_url && (
                  <img src={trip.cover_image_url} alt="" className="trip-card-image" />
                )}
                <div className="trip-card-body">
                  <div className="trip-card-top">
                    <h2 className="trip-card-name">{trip.name}</h2>
                    <span className={`status-badge status-${trip.status}`}>
                      {STATUS_ICONS[trip.status]}
                      {STATUS_LABELS[trip.status]}
                    </span>
                  </div>
                  {trip.start_date && (
                    <div className="trip-card-meta">
                      <span className="meta-item">
                        <Calendar size={12} />
                        {format(parseISO(trip.start_date), 'MMM d, yyyy')}
                        {trip.end_date && ` – ${format(parseISO(trip.end_date), 'MMM d, yyyy')}`}
                      </span>
                    </div>
                  )}
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
