# Supabase keep-alive worker

Supabase pauses Free Plan projects after ~7 days of low **database** activity.
A personal Cairn instance can easily go a week without anyone opening it, and
a paused project means the app is simply down until someone restores it from
the dashboard.

[`worker.js`](worker.js) is a Cloudflare Worker that makes a few database
requests a day on a cron trigger, which is the remedy Supabase
[documents](https://supabase.com/docs/guides/platform/free-project-pausing):

> Generate a sufficient amount of activity by making API calls to your
> project… Typically a few user requests to the database each day over the
> previous week is enough to keep the project from being paused.

Not needed on a paid plan — those projects are never paused for inactivity.

## What it pings, and why that matters

It calls the `get_shared_trip` RPC with an all-zero UUID.

The request has to reach **Postgres**. Hitting an auth or storage endpoint
proves nothing about database activity, and the metric Supabase measures is
database usage. This RPC executes a real query, matches no trip, and returns
`null`.

Using an existing anon-callable RPC is deliberate: it adds no new public
surface. A plain table read would work too, but `trips` is not readable by
`anon` (the share token is a bearer credential — see the schema), so that
would log a permission error every few hours instead of a clean `200`.

Only the **publishable anon key** is needed. Never give this worker a
service-role key; it has no reason to bypass RLS.

## Deploy

With [wrangler](https://developers.cloudflare.com/workers/wrangler/):

```bash
cd infra/supabase-keepalive
wrangler deploy
wrangler secret put PING_SECRET        # any random string; see below
```

Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` as plain-text vars (they are
publishable) and `PING_SECRET` as a secret. The cron trigger is
`*/15 * * * *` — see below for why it fires so often.

## The schedule is randomised

Cloudflare cron expressions are fixed, so the variation lives in the worker.
The cron fires every 15 minutes and each invocation decides whether *this*
slot is one of today's; the rest return immediately without touching the
network. Both the number of requests (2-5) and their times vary from day to
day, so it doesn't hammer the same four timestamps forever.

The choice is a pure function of the UTC date — no storage needed, and every
invocation that day agrees. The day is split into as many equal blocks as
there are requests, one slot drawn per block, which keeps them spread out; a
purely uniform draw can cluster every request into one hour and leave a very
long gap.

The floor of two a day is deliberate. Supabase wants activity on each day of
the window, and a day scheduled for a single request has no margin if that
request fails.

Simulated over 1000 days: 2-5 requests every day, never zero, 988 distinct
daily patterns, and a largest-ever gap of 23.5 hours.

Add `&plan=1` to the manual trigger to see the times chosen for today without
sending a ping.

## The manual trigger

The worker also exposes a `fetch` handler that performs one ping on demand,
gated by `?key=<PING_SECRET>`. It exists to verify the thing works without
waiting for the next cron tick; without the correct key it returns `404`.

Leave the `workers.dev` subdomain **disabled** in normal operation — the cron
does not need a public URL, and an open endpoint that fires requests at your
database is not worth exposing. Enable it only while testing.

To check it is alive without the HTTP trigger: the Cloudflare dashboard shows
cron invocations, and Supabase's API logs show the requests arriving as
`POST | 200 | /rest/v1/rpc/get_shared_trip` with an empty user-agent.
