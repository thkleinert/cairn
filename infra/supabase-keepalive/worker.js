// Supabase keep-alive — a Cloudflare Worker on a cron trigger.
//
// Supabase pauses Free Plan projects after ~7 days of low *database* activity.
// Their docs: "a few user requests to the database each day over the previous
// week is enough to keep the project from being paused." A personal Cairn
// instance can easily go a week without anyone opening it, so this makes the
// handful of requests on a schedule.
//
// What it calls matters. The request has to reach Postgres — hitting an auth
// or storage endpoint proves nothing about database activity. It uses the
// get_shared_trip RPC with an all-zero UUID: that's an existing anon-callable
// entry point, so this adds no new public surface, and it executes a real
// query that matches no trip and returns null. Nothing is read or written.
//
// Only needs the publishable anon key. Never give this worker a service-role
// key — it has no reason to bypass RLS.

const PING_PATH = '/rest/v1/rpc/get_shared_trip';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

async function ping(env) {
  const started = Date.now();
  try {
    const res = await fetch(env.SUPABASE_URL + PING_PATH, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_token: NIL_UUID }),
    });
    // Read the body so the request is genuinely completed, not just headers.
    await res.text();
    const result = { ok: res.ok, status: res.status, ms: Date.now() - started };
    // A paused project answers 5xx; surface it in the Worker log rather than
    // failing silently, since a silent keep-alive is worse than none.
    if (!res.ok) console.error('keepalive: unexpected status', result);
    else console.log('keepalive: ok', result);
    return result;
  } catch (err) {
    const result = { ok: false, error: String(err), ms: Date.now() - started };
    console.error('keepalive: request failed', result);
    return result;
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(ping(env));
  },

  // Manual trigger, for verifying the thing actually works without waiting
  // for the next cron tick. Gated by a secret: an open endpoint that fires
  // requests at someone's database on demand is not something to publish.
  async fetch(request, env) {
    const key = new URL(request.url).searchParams.get('key');
    if (!env.PING_SECRET || key !== env.PING_SECRET) {
      return new Response('Not found', { status: 404 });
    }
    return Response.json(await ping(env));
  },
};
