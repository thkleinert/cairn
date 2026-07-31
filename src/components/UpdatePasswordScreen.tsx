import { useState } from 'react';
import { KeyRound } from 'lucide-react';

interface Props {
  onUpdatePassword: (password: string) => Promise<{ error: { message: string } | null }>;
  // Same form serves password *recovery* and first-time setup for an
  // invited account, which differ only in wording.
  title?: string;
  subtitle?: string;
  submitLabel?: string;
}

export function UpdatePasswordScreen({
  onUpdatePassword,
  title = 'New password',
  subtitle = 'Choose a new password for your account',
  submitLabel = 'Set new password',
}: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setLoading(true);
    const { error } = await onUpdatePassword(password);
    setLoading(false);
    if (error) setError(error.message);
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">
          <KeyRound size={32} color="var(--color-primary)" />
          <h1>{title}</h1>
        </div>
        <p className="auth-subtitle">{subtitle}</p>

        <form onSubmit={handleSubmit} className="auth-form">
          <input
            type="password"
            placeholder="New password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="input"
            autoFocus
          />
          <input
            type="password"
            placeholder="Repeat new password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            required
            className="input"
          />
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Saving…' : submitLabel}
          </button>
        </form>
      </div>
    </div>
  );
}
