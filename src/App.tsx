import { useState, useEffect } from 'react';
import { useAuth } from './hooks/useAuth';
import { AuthScreen } from './components/AuthScreen';
import { UpdatePasswordScreen } from './components/UpdatePasswordScreen';
import { TripList } from './components/TripList';
import { TripView } from './components/TripView';
import { SharedTripView } from './components/SharedTripView';
import { SetupScreen } from './components/SetupScreen';
import { Toasts } from './components/Toasts';
import { OfflineBanner } from './components/OfflineBanner';
import { isConfigured, supabase } from './lib/supabase';
import type { Trip } from './types';

function getShareToken(): string | null {
  const match = window.location.pathname.match(/^\/shared\/([^/]+)$/);
  return match ? match[1] : null;
}

function getTripIdFromPath(): string | null {
  const match = window.location.pathname.match(/^\/trip\/([^/]+)$/);
  return match ? match[1] : null;
}

// Only rendered when Supabase is configured — safe to call hooks
function AuthedApp() {
  const { user, loading, passwordRecovery, updatePassword } = useAuth();
  const [activeTrip, setActiveTrip] = useState<Trip | null>(null);
  // A place to auto-open once a trip is entered (e.g. jumping in from an
  // activity notification). Bumped nonce so re-selecting the same place from
  // the feed re-triggers the open even if the id hasn't changed.
  const [pendingPlace, setPendingPlace] = useState<{ id: string; openComments: boolean; nonce: number } | null>(null);
  const [restoringTrip, setRestoringTrip] = useState(() => getTripIdFromPath() !== null);
  const shareToken = getShareToken();

  useEffect(() => {
    const handler = () => setActiveTrip(null);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  // Restore /trip/:id after a refresh
  useEffect(() => {
    if (loading) return;
    const tripId = getTripIdFromPath();
    if (!user || !tripId) { setRestoringTrip(false); return; }
    let cancelled = false;
    supabase.from('trips').select('*').eq('id', tripId).single().then(({ data }) => {
      if (cancelled) return;
      if (data) setActiveTrip(data);
      else window.history.replaceState(null, '', '/');
      setRestoringTrip(false);
    });
    return () => { cancelled = true; };
  }, [user, loading]);

  if (shareToken) return <SharedTripView shareToken={shareToken} />;
  if (loading || restoringTrip) return <div className="loading-spinner fullscreen" />;
  if (!user) return <AuthScreen />;
  if (passwordRecovery) return <UpdatePasswordScreen onUpdatePassword={updatePassword} />;

  if (activeTrip) {
    return (
      <TripView
        trip={activeTrip}
        userId={user.id}
        initialPlaceId={pendingPlace?.id}
        initialOpenComments={pendingPlace?.openComments}
        openNonce={pendingPlace?.nonce}
        onBack={() => {
          setActiveTrip(null);
          setPendingPlace(null);
          window.history.pushState(null, '', '/');
        }}
      />
    );
  }

  return (
    <TripList
      userId={user.id}
      onSelectTrip={(trip, target) => {
        setActiveTrip(trip);
        setPendingPlace(
          target?.placeId
            ? { id: target.placeId, openComments: !!target.openComments, nonce: Date.now() }
            : null
        );
        window.history.pushState(null, '', `/trip/${trip.id}`);
      }}
    />
  );
}

export default function App() {
  useEffect(() => {
    const el = document.getElementById('splash');
    if (!el) return;
    el.classList.add('fade');
    const t = setTimeout(() => el.remove(), 380);
    return () => clearTimeout(t);
  }, []);

  if (!isConfigured) return <SetupScreen />;
  return (
    <>
      <OfflineBanner />
      <AuthedApp />
      <Toasts />
    </>
  );
}
