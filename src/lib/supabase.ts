import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const isConfigured =
  !!supabaseUrl &&
  !!supabaseAnonKey &&
  supabaseUrl.startsWith('http');

export const supabase = isConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null!;

// Whether this instance still accepts self-service sign-up. Deployments that
// hand out accounts only through trip invites turn it off in Supabase Auth,
// and the sign-in screen shouldn't offer a "create account" path that the
// server will just reject. Read from GoTrue's public settings endpoint so the
// app adapts to whatever the self-hoster configured, with no build-time flag.
// Cached: the answer can't change within a session.
let signupsPromise: Promise<boolean> | null = null;

export function signupsEnabled(): Promise<boolean> {
  if (!isConfigured) return Promise.resolve(true);
  if (!signupsPromise) {
    signupsPromise = fetch(`${supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: supabaseAnonKey },
    })
      .then(res => (res.ok ? res.json() : null))
      // Assume open on failure: showing the sign-up option when it's actually
      // disabled is a confusing error message; hiding it when it works would
      // lock out every legitimate new user.
      .then(cfg => (cfg ? !cfg.disable_signup : true))
      .catch(() => true);
  }
  return signupsPromise;
}
