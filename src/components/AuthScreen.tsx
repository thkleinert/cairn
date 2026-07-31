import { useState, useEffect } from 'react';
import { CairnIcon } from './CairnIcon';
import { useAuth } from '../hooks/useAuth';
import { signupsEnabled } from '../lib/supabase';

type Mode = 'signin' | 'signup' | 'reset';

function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'Wrong email or password.';
  if (m.includes('already registered')) return 'An account with this email already exists. Try signing in.';
  if (m.includes('rate limit')) return 'Too many attempts — please wait a moment and try again.';
  if (m.includes('at least 6 characters') || m.includes('password should')) return 'Password must be at least 6 characters.';
  if (m.includes('email not confirmed')) return 'Please confirm your email first — check your inbox.';
  return message;
}

interface Props {
  // When arriving via an invite link, show what's being joined and default to
  // sign-up (most invitees won't have an account yet).
  invite?: { tripName: string; role: string; inviter: string } | null;
}

export function AuthScreen({ invite }: Props = {}) {
  const { signIn, signUp, resetPassword } = useAuth();
  const [mode, setMode] = useState<Mode>(invite ? 'signup' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  // On an invite-only instance there is no self-service sign-up to offer;
  // invitees arrive already provisioned via their invite link.
  const [canSignUp, setCanSignUp] = useState(true);

  useEffect(() => {
    let cancelled = false;
    signupsEnabled().then(enabled => {
      if (cancelled || enabled) return;
      setCanSignUp(false);
      setMode(m => (m === 'signup' ? 'signin' : m));
    });
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    try {
      if (mode === 'signin') {
        const { error } = await signIn(email, password);
        if (error) setError(friendlyAuthError(error.message));
      } else if (mode === 'signup') {
        const { error } = await signUp(email, password);
        if (error) setError(friendlyAuthError(error.message));
        else setMessage('Check your email to confirm your account.');
      } else {
        const { error } = await resetPassword(email);
        if (error) setError(friendlyAuthError(error.message));
        else setMessage('Check your email for a password reset link.');
      }
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
    setMessage('');
  };

  const submitLabel =
    mode === 'signin' ? 'Sign in'
    : mode === 'signup' ? 'Create account'
    : 'Send reset link';

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">
          <CairnIcon size={32} color="var(--color-primary)" />
          <h1>Cairn</h1>
        </div>
        <p className="auth-subtitle">
          {mode === 'reset' ? 'Reset your password' : 'Plan your adventures together'}
        </p>

        {invite && mode !== 'reset' && (
          <div className="auth-invite-banner">
            <strong>{invite.inviter}</strong> invited you to join{' '}
            <strong>{invite.tripName}</strong> as {invite.role}.{' '}
            {canSignUp ? 'Sign in or create an account to join.' : 'Sign in to join.'}
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="input"
          />
          {mode !== 'reset' && (
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              className="input"
            />
          )}
          {error && <p className="error-text">{error}</p>}
          {message && <p className="success-text">{message}</p>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Loading…' : submitLabel}
          </button>
        </form>

        {mode === 'signin' && (
          <button className="auth-toggle auth-forgot" onClick={() => switchMode('reset')}>
            Forgot password?
          </button>
        )}

        {(canSignUp || mode === 'reset') && (
          <button
            className="auth-toggle"
            onClick={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}
          >
            {mode === 'signin' ? "Don't have an account? Sign up."
              : mode === 'signup' ? 'Already have an account? Sign in'
              : 'Back to sign in'}
          </button>
        )}
      </div>
    </div>
  );
}
