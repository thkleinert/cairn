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

// A non-2xx from an edge function surfaces as FunctionsHttpError whose
// message is the useless generic "Edge Function returned a non-2xx status
// code" — the real reason is in the unread response body our functions all
// answer with as `{ error }`. Dig it out.
//
// `fallback` is for callers that show this to a user directly. Two failures
// never produce an `{ error }` body and so would otherwise surface raw SDK
// wording: a network failure or an undeployed function (FunctionsFetchError —
// "Failed to send a request to the Edge Function"), and the gateway's own
// 404/401, whose body is `{ code, message }` rather than ours. Callers that
// only log, or that throw for a caller upstream to phrase, can leave it off.
export async function edgeFunctionMessage(
  fnError: { message: string },
  fallback?: string,
): Promise<string> {
  const ctx = (fnError as { context?: Response }).context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = await ctx.json();
      if (body?.error) return body.error;
    } catch { /* not our JSON shape — fall through */ }
  }
  return fallback ?? fnError.message;
}
