import { useState, useEffect, useRef } from 'react';
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
import { toast } from './lib/toast';
import type { Trip } from './types';

// Survives the sign-up → email-confirm → return round-trip, so the invite is
// still redeemable when the invitee lands back in the app logged in.
const INVITE_KEY = 'cairn.pendingInvite';

function getShareToken(): string | null {
  const match = window.location.pathname.match(/^\/shared\/([^/]+)$/);
  return match ? match[1] : null;
}

function getTripIdFromPath(): string | null {
  const match = window.location.pathname.match(/^\/trip\/([^/]+)$/);
  return match ? match[1] : null;
}

function getInviteToken(): string | null {
  const match = window.location.pathname.match(/^\/invite\/([^/]+)$/);
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
  const inviteToken = getInviteToken();
  const [invitePrompt, setInvitePrompt] =
    useState<{ tripName: string; role: string; inviter: string } | null>(null);
  const [acceptingInvite, setAcceptingInvite] = useState(() => getInviteToken() !== null);

  useEffect(() => {
    const handler = () => setActiveTrip(null);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  // Landing on /invite/:token — stash it and fetch details for the sign-in
  // banner. If the visitor isn't logged in they'll authenticate first; the
  // redeem effect below runs once they are.
  useEffect(() => {
    if (!inviteToken) return;
    localStorage.setItem(INVITE_KEY, inviteToken);
    supabase.rpc('get_trip_invite', { p_token: inviteToken }).then(({ data, error }) => {
      const inv = Array.isArray(data) ? data[0] : data;
      if (inv) {
        setInvitePrompt({ tripName: inv.trip_name, role: inv.role, inviter: inv.inviter_email });
      } else if (!error) {
        // The lookup worked and found nothing: a revoked or malformed token.
        // Drop the stash now — left in place it would "detonate" on a later,
        // unrelated sign-in with a confusing failure toast. (On a transient
        // error we keep it; reopening the link retries.)
        localStorage.removeItem(INVITE_KEY);
      }
    });
  }, [inviteToken]);

  // Once authenticated, redeem any pending invite and jump into the trip.
  // The ref guards against the effect double-firing (StrictMode, or the user
  // object changing identity mid-redeem) and calling accept twice — the
  // second call would race the first and surface a spurious error.
  const redeemingRef = useRef(false);
  useEffect(() => {
    if (loading || !user) return;
    const token = localStorage.getItem(INVITE_KEY);
    if (!token) { setAcceptingInvite(false); return; }
    if (redeemingRef.current) return;
    redeemingRef.current = true;
    setAcceptingInvite(true);
    supabase.rpc('accept_trip_invite', { p_token: token }).then(async ({ data, error }) => {
      localStorage.removeItem(INVITE_KEY);
      redeemingRef.current = false;
      setInvitePrompt(null);
      if (error) {
        toast(error.message || 'Could not accept the invite');
        window.history.replaceState(null, '', '/');
      } else {
        const { data: trip } = await supabase.from('trips').select('*').eq('id', data as string).single();
        if (trip) {
          setActiveTrip(trip);
          window.history.replaceState(null, '', `/trip/${trip.id}`);
        } else {
          window.history.replaceState(null, '', '/');
        }
      }
      setAcceptingInvite(false);
    });
  }, [user, loading]);

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
  if (!user) return <AuthScreen invite={invitePrompt} />;
  if (acceptingInvite) return <div className="loading-spinner fullscreen" />;
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
