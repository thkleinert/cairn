// invite-collaborator — creates a trip invite and, when the invitee has no
// account yet, provisions one via the Auth admin API and returns a link that
// signs them in.
//
//   POST /functions/v1/invite-collaborator   { tripId, email, role, origin }
//
// Why this exists: Cairn's invite links used to be ordinary sign-up links
// with a nicer banner, so the instance had to leave self-service sign-up
// open to anyone who found it. This function creates the account itself
// (service role), which means `disable_signup` can be turned on and the only
// way to get an account is to be invited to a trip.
//
// The owner still just copies a link and sends it however they like — no
// SMTP configuration and no dependency on email delivery.
//
// Two links are possible:
//   status 'invited'  — a brand-new account; the link is a one-time Supabase
//                       action link that signs them in, then lands on
//                       /invite/<token>?setup=1 so the app can ask them to
//                       choose a password (admin-provisioned users have none).
//   status 'existing' — the email already has an account; the link is the
//                       plain /invite/<token>, which they open while signed in.
//
// verify_jwt is on (../../config.toml): only signed-in users can call this,
// and the trip-owner check is enforced by create_trip_invite itself, which
// runs under the *caller's* JWT — no authorization logic is duplicated here.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// The redirect target is baked into a link that carries a real session, so it
// must never be attacker-chosen: an unvalidated origin would let anyone mint
// an "invite" that hands a logged-in session to their own domain. The client
// may only *select* among origins the deployment already declared.
//
//   supabase secrets set APP_ORIGINS="https://cairn.example.com,http://localhost:5173"
//
function resolveOrigin(requested: string | undefined): string | null {
  const allowed = (Deno.env.get('APP_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (allowed.length === 0) return null;
  const want = (requested ?? '').trim().replace(/\/$/, '');
  return allowed.includes(want) ? want : allowed[0];
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing authorization' }, 401);

  let tripId: string, email: string, role: string, origin: string | undefined;
  try {
    const body = await req.json();
    tripId = String(body.tripId ?? '');
    email = String(body.email ?? '').trim();
    role = String(body.role ?? 'editor');
    origin = body.origin ? String(body.origin) : undefined;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'Enter a valid email address' }, 400);
  }
  if (role !== 'editor' && role !== 'viewer') {
    return json({ error: 'Role must be editor or viewer' }, 400);
  }

  // Authorization first, server config second: a caller who isn't the trip
  // owner must be rejected the same way whether or not this deployment has
  // been configured yet.
  //
  // Create (or reuse) the invite row as the caller. create_trip_invite raises
  // if they aren't the trip's owner, so that check lives in exactly one place.
  const asCaller = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: invite, error: inviteErr } = await asCaller.rpc('create_trip_invite', {
    p_trip_id: tripId,
    p_email: email,
    p_role: role,
  });
  if (inviteErr) return json({ error: inviteErr.message }, 403);

  const token = (invite as { token?: string })?.token;
  if (!token) return json({ error: 'invite creation failed' }, 500);

  const appOrigin = resolveOrigin(origin);
  if (!appOrigin) {
    return json(
      { error: 'Server is missing the APP_ORIGINS secret — see supabase/functions/invite-collaborator' },
      500,
    );
  }

  const inviteUrl = `${appOrigin}/invite/${token}`;

  // Provision the account. `?setup=1` tells the app to ask for a password
  // once the invite is redeemed — an admin-created user doesn't have one, so
  // without it they could never sign in again on another device.
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo: `${inviteUrl}?setup=1` },
  });

  if (linkErr) {
    // Already registered: nothing to provision — they open the plain invite
    // link while signed in and redeem it there.
    const msg = (linkErr.message ?? '').toLowerCase();
    if (msg.includes('already') || (linkErr as { status?: number }).status === 422) {
      return json({ status: 'existing', email, role, link: inviteUrl });
    }
    return json({ error: linkErr.message }, 500);
  }

  const actionLink = link?.properties?.action_link;
  if (!actionLink) return json({ status: 'existing', email, role, link: inviteUrl });

  return json({ status: 'invited', email, role, link: actionLink });
});
