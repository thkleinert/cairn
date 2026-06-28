import { useState, useEffect } from 'react';
import { useAuth } from './hooks/useAuth';
import { AuthScreen } from './components/AuthScreen';
import { TripList } from './components/TripList';
import { TripView } from './components/TripView';
import { SharedTripView } from './components/SharedTripView';
import { SetupScreen } from './components/SetupScreen';
import { isConfigured } from './lib/supabase';
import type { Trip } from './types';

function getShareToken(): string | null {
  const match = window.location.pathname.match(/^\/shared\/([^/]+)$/);
  return match ? match[1] : null;
}

// Only rendered when Supabase is configured — safe to call hooks
function AuthedApp() {
  const { user, loading } = useAuth();
  const [activeTrip, setActiveTrip] = useState<Trip | null>(null);
  const shareToken = getShareToken();

  useEffect(() => {
    const handler = () => setActiveTrip(null);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  if (shareToken) return <SharedTripView shareToken={shareToken} />;
  if (loading) return <div className="loading-spinner fullscreen" />;
  if (!user) return <AuthScreen />;

  if (activeTrip) {
    return (
      <TripView
        trip={activeTrip}
        userId={user.id}
        onBack={() => {
          setActiveTrip(null);
          window.history.pushState(null, '', '/');
        }}
      />
    );
  }

  return (
    <TripList
      userId={user.id}
      onSelectTrip={(trip) => {
        setActiveTrip(trip);
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
  return <AuthedApp />;
}
