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
//
// ---------------------------------------------------------------------------
// Scheduling
//
// Cloudflare cron expressions are fixed, so the timing is varied here instead:
// the cron fires every 15 minutes and each invocation decides whether *this*
// slot is one of today's chosen ones. Only the chosen slots make a request —
// the rest return immediately without touching the network.
//
// The choice is a pure function of the UTC date, so it needs no storage and
// every invocation that day agrees on the answer. Both *how many* requests a
// day (2-5) and *when* they land vary. The day is split into that many equal
// blocks with one slot drawn per block, which keeps them spread out — a purely
// uniform draw can cluster every request into one hour and leave a very long
// gap — while still looking different from one day to the next.
//
// The floor of 2 is deliberate: Supabase wants activity on each day of the
// window, and a day scheduled for a single request has no margin if that one
// request fails.
// ---------------------------------------------------------------------------

const PING_PATH = '/rest/v1/rpc/get_shared_trip';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const SLOTS_PER_HOUR = 4;          // the cron fires every 15 minutes
const SLOTS_PER_DAY = 24 * SLOTS_PER_HOUR;
const MIN_PINGS = 2;               // never fewer — see the note above
const MAX_PINGS = 5;

// Deterministic PRNG (mulberry32). Math.random() would re-roll on every
// invocation, so the day's schedule has to come from a seeded generator.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The 15-minute slots (0..95) chosen for a given UTC day.
export function slotsForDay(date) {
  const seed =
    date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  const rand = mulberry32(seed);
  const count = MIN_PINGS + Math.floor(rand() * (MAX_PINGS - MIN_PINGS + 1));
  const slots = [];
  for (let block = 0; block < count; block++) {
    const blockStart = Math.floor((block * SLOTS_PER_DAY) / count);
    const blockEnd = Math.floor(((block + 1) * SLOTS_PER_DAY) / count);
    slots.push(blockStart + Math.floor(rand() * (blockEnd - blockStart)));
  }
  return slots;
}

function currentSlot(date) {
  return date.getUTCHours() * SLOTS_PER_HOUR + Math.floor(date.getUTCMinutes() / 15);
}

export function shouldPing(date) {
  return slotsForDay(date).includes(currentSlot(date));
}

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
  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime ?? Date.now());
    let due;
    try {
      due = shouldPing(now);
    } catch (err) {
      // Fail open: a bug in the slot maths must never silently stop the
      // keep-alive, which would only be noticed when the project pauses.
      console.error('keepalive: slot check failed, pinging anyway', String(err));
      due = true;
    }
    if (!due) return;
    ctx.waitUntil(ping(env));
  },

  // Manual trigger, for verifying the thing actually works without waiting
  // for the next cron tick. Gated by a secret: an open endpoint that fires
  // requests at someone's database on demand is not something to publish.
  // Ignores the schedule — it pings immediately.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.PING_SECRET || url.searchParams.get('key') !== env.PING_SECRET) {
      return new Response('Not found', { status: 404 });
    }
    if (url.searchParams.get('plan') === '1') {
      const now = new Date();
      return Response.json({
        utcDate: now.toISOString().slice(0, 10),
        todaysSlots: slotsForDay(now).map(
          (s) => `${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')}`
        ),
      });
    }
    return Response.json(await ping(env));
  },
};
