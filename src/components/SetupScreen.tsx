import { CairnIcon } from './CairnIcon';

export function SetupScreen() {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">
          <CairnIcon size={32} color="var(--color-primary)" />
          <h1>Cairn</h1>
        </div>
        <p className="auth-subtitle">Setup required</p>
        <div style={{ fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
          <p style={{ marginBottom: 12 }}>Add your credentials to <code>.env.local</code>:</p>
          <pre style={{
            background: 'var(--color-bg)', borderRadius: 8, padding: 12,
            fontSize: 12, overflowX: 'auto', lineHeight: 1.8,
            border: '1px solid var(--color-border)'
          }}>{`VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
VITE_MAPBOX_TOKEN=pk.eyJ...
VITE_GOOGLE_PLACES_KEY=AIza...`}</pre>
          <p style={{ marginTop: 12 }}>Then restart the dev server.</p>
        </div>
      </div>
    </div>
  );
}
