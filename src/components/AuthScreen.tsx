import { useState } from 'react';
import { MapPin } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

export function AuthScreen() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    try {
      if (mode === 'signin') {
        const { error } = await signIn(email, password);
        if (error) setError(error.message);
      } else {
        const { error } = await signUp(email, password);
        if (error) setError(error.message);
        else setMessage('Check your email to confirm your account.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">
          <MapPin size={32} color="var(--color-primary)" />
          <h1>TripMap</h1>
        </div>
        <p className="auth-subtitle">Plan your adventures together</p>

        <form onSubmit={handleSubmit} className="auth-form">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="input"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="input"
          />
          {error && <p className="error-text">{error}</p>}
          {message && <p className="success-text">{message}</p>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Loading…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <button
          className="auth-toggle"
          onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); }}
        >
          {mode === 'signin' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}
