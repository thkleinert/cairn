import { useState, useEffect, useRef, useCallback } from 'react';
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
import { TRIP_COLUMNS } from './lib/trips';
import { toast } from './lib/toast';
import type { Trip } from './types';

// Survives the sign-up → email-confirm → return round-trip, so the invite is
// still redeemable when the invitee lands back in the app logged in. Expires:
// an invite token is a bearer credential, and a stale stash must not sit in
// localStorage waiting to fire on some unrelated future sign-in.
const INVITE_KEY = 'cairn.pendingInvite';
const INVITE_STASH_TTL_MS = 30 * 60 * 1000;

function stashInvite(token: string) {
  localStorage.setItem(INVITE_KEY, JSON.stringify({ token, at: Date.now() }));
}

function readStashedInvite(): string | null {
  const raw = localStorage.getItem(INVITE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { token?: string; at?: number };
    if (!parsed.token || !parsed.at || Date.now() - parsed.at > INVITE_STASH_TTL_MS) {
      localStorage.removeItem(INVITE_KEY);
      return null;
    }
    return parsed.token;
  } catch {
    // Pre-expiry format (a bare token string) — drop it rather than honour
    // a stash of unknown age.
    localStorage.removeItem(INVITE_KEY);
    return null;
  }
}

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

// invite-collaborator appends ?setup=1 when it provisioned the account: an
// admin-created user has no password yet, so without this step they could
// never sign in again on another device. Read once at module load — the
// redeem flow rewrites the URL before render settles.
const NEEDS_PASSWORD_SETUP =
  getInviteToken() !== null && new URLSearchParams(window.location.search).get('setup') === '1';

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
  // A stashed (not URL-borne) invite is redeemed only after an explicit
  // confirmation — see the redeem effect below.
  const [confirmInvite, setConfirmInvite] =
    useState<{ token: string; tripName: string; role: string; inviter: string } | null>(null);
  // Whether the current /trip/:id history entry was pushed by us (list →
  // trip): then the in-app back button can use real history.back() instead
  // of growing the stack with duplicate '/' entries.
  const pushedTripRef = useRef(false);
  // Read by the popstate handler below, which is registered once and would
  // otherwise close over the first render's value.
  const activeTripRef = useRef<Trip | null>(null);
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(NEEDS_PASSWORD_SETUP);

  // Mirrors activeTrip for the popstate handler, which is registered once.
  useEffect(() => { activeTripRef.current = activeTrip; }, [activeTrip]);

  // Keep URL and UI in sync across browser back/forward: restore whatever
  // trip the URL now points at instead of unconditionally showing the list
  // (which stranded browser-forward on a /trip URL over list content).
  useEffect(() => {
    const handler = () => {
      const tripId = getTripIdFromPath();
      if (!tripId) {
        setActiveTrip(null);
        return;
      }
      // Already here. Overlays inside a trip push a history entry at the SAME
      // url so a back gesture closes the sheet rather than the trip, which
      // means most pops within a trip do not change which trip is shown —
      // without this every one of them cost a round trip and handed TripView a
      // new object for the trip it was already displaying.
      if (activeTripRef.current?.id === tripId) return;
      supabase.from('trips').select(TRIP_COLUMNS).eq('id', tripId).single().then(({ data }) => {
        // Only apply if the URL still points at this trip by the time the
        // response lands (rapid back-forward).
        if (data && getTripIdFromPath() === (data as Trip).id) setActiveTrip(data as Trip);
      });
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  // Landing on /invite/:token — stash it and fetch details for the sign-in
  // banner. If the visitor isn't logged in they'll authenticate first; the
  // redeem effect below runs once they are.
  useEffect(() => {
    if (!inviteToken) return;
    stashInvite(inviteToken);
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

  // The ref guards against double-firing (StrictMode, or the user object
  // changing identity mid-redeem) and calling accept twice — the second call
  // would race the first and surface a spurious error.
  const redeemingRef = useRef(false);
  const redeemInvite = useCallback(async (token: string) => {
    if (redeemingRef.current) return;
    redeemingRef.current = true;
    setAcceptingInvite(true);
    const { data, error } = await supabase.rpc('accept_trip_invite', { p_token: token });
    localStorage.removeItem(INVITE_KEY);
    redeemingRef.current = false;
    setInvitePrompt(null);
    setConfirmInvite(null);
    if (error) {
      toast(error.message || 'Could not accept the invite');
      window.history.replaceState(null, '', '/');
    } else {
      const { data: trip } = await supabase
        .from('trips').select(TRIP_COLUMNS).eq('id', data as string).single();
      if (trip) {
        setActiveTrip(trip as Trip);
        window.history.replaceState(null, '', `/trip/${(trip as Trip).id}`);
      } else {
        window.history.replaceState(null, '', '/');
      }
    }
    setAcceptingInvite(false);
  }, []);

  // Once authenticated: an invite opened in THIS page load (token in the
  // URL) redeems directly — the user just clicked the link. A token that
  // only exists in the stash (returning from the sign-up round-trip, or
  // someone else's abandoned invite on a shared browser) gets an explicit
  // "join this trip?" confirmation instead of silently attaching whoever
  // signed in to a trip they may never have been invited to.
  useEffect(() => {
    if (loading || !user) return;
    if (inviteToken) {
      redeemInvite(inviteToken);
      return;
    }
    const stashed = readStashedInvite();
    if (!stashed) {
      setAcceptingInvite(false);
      return;
    }
    supabase.rpc('get_trip_invite', { p_token: stashed }).then(({ data, error }) => {
      const inv = Array.isArray(data) ? data[0] : data;
      if (inv) {
        setConfirmInvite({ token: stashed, tripName: inv.trip_name, role: inv.role, inviter: inv.inviter_email });
      } else if (!error) {
        localStorage.removeItem(INVITE_KEY);
      }
      setAcceptingInvite(false);
    });
  }, [user, loading, inviteToken, redeemInvite]);

  // Restore /trip/:id after a refresh
  useEffect(() => {
    if (loading) return;
    const tripId = getTripIdFromPath();
    if (!user || !tripId) { setRestoringTrip(false); return; }
    let cancelled = false;
    supabase.from('trips').select(TRIP_COLUMNS).eq('id', tripId).single().then(({ data, error }) => {
      if (cancelled) return;
      if (data) {
        setActiveTrip(data as Trip);
      } else if (error && error.code !== 'PGRST116') {
        // Transient failure (offline launch, flaky network) — keep the URL
        // so a retry/reconnect can still restore the deep link, and fall
        // back to the list for now. Only a definite "no such row" (PGRST116)
        // may rewrite the URL.
        toast('Could not load the trip — check your connection');
      } else {
        window.history.replaceState(null, '', '/');
      }
      setRestoringTrip(false);
    });
    return () => { cancelled = true; };
  }, [user, loading]);

  if (shareToken) return <SharedTripView shareToken={shareToken} />;
  if (loading || restoringTrip) return <div className="loading-spinner fullscreen" />;
  if (!user) return <AuthScreen invite={invitePrompt} />;
  if (acceptingInvite) return <div className="loading-spinner fullscreen" />;
  if (passwordRecovery) return <UpdatePasswordScreen onUpdatePassword={updatePassword} />;

  // Freshly provisioned invitee: they're signed in and already in the trip,
  // but have no password until they pick one here.
  if (needsPasswordSetup) {
    return (
      <UpdatePasswordScreen
        title="Choose a password"
        subtitle="Set a password so you can sign back in later"
        submitLabel="Save password"
        onUpdatePassword={async (password) => {
          const result = await updatePassword(password);
          if (!result.error) setNeedsPasswordSetup(false);
          return result;
        }}
      />
    );
  }

  if (confirmInvite) {
    return (
      <div className="invite-confirm-screen">
        <div className="invite-confirm-card">
          <h2>Join “{confirmInvite.tripName}”?</h2>
          <p>{confirmInvite.inviter} invited you to collaborate as {confirmInvite.role}.</p>
          <button className="btn-primary" onClick={() => redeemInvite(confirmInvite.token)}>
            Join trip
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              localStorage.removeItem(INVITE_KEY);
              setConfirmInvite(null);
            }}
          >
            Not now
          </button>
        </div>
      </div>
    );
  }

  if (activeTrip) {
    return (
      <TripView
        trip={activeTrip}
        userId={user.id}
        onTripUpdated={setActiveTrip}
        initialPlaceId={pendingPlace?.id}
        initialOpenComments={pendingPlace?.openComments}
        openNonce={pendingPlace?.nonce}
        onBack={() => {
          setPendingPlace(null);
          if (pushedTripRef.current) {
            // We pushed this /trip entry from the list — real back keeps the
            // history stack clean (the popstate handler clears activeTrip).
            pushedTripRef.current = false;
            window.history.back();
          } else {
            // Deep-linked entry: there's no in-app '/' behind us to pop to.
            setActiveTrip(null);
            window.history.replaceState(null, '', '/');
          }
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
        pushedTripRef.current = true;
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
