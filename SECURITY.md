# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

Use [GitHub's private vulnerability reporting](https://github.com/thkleinert/cairn/security/advisories/new)
on this repository. I'll acknowledge within a few days. This is a personal
project, not a commercial product — there's no bounty, and fixes land on a
best-effort basis.

## Scope

Cairn is self-hosted: every deployment is a separate Supabase project and
frontend owned by whoever runs it. There is no central service to attack, and
a report about someone's individual instance should go to that operator.

What's in scope for this repository is the shipped code and schema:

- Row Level Security policies and `SECURITY DEFINER` RPCs in
  [`supabase/schema.sql`](supabase/schema.sql) — anything letting a user read
  or write trip data they aren't a member of, or escalate their role.
- The edge functions in [`supabase/functions/`](supabase/functions) —
  especially authorization checks, the invite-link redirect allowlist, and the
  storage-path validation in `persist-photo`.
- Bearer-token handling for share links and invite links.
- Client-side issues with real consequences: XSS, token leakage, open
  redirects.

## Known and accepted by design

These are documented in the [Security Model](README.md#security-model) and are
not vulnerabilities:

- **Client API keys are public.** The Supabase anon key, the Google key and
  the browser Mapbox token ship in the JavaScript bundle by design. Safety
  comes from Row Level Security and from key restrictions, not secrecy.
- **Share links are bearer tokens.** Anyone holding a trip's share link can
  read that trip without an account — that's the feature. Owners can reset a
  link to revoke it.
- **Invite links join whoever opens them.** Acceptance is by token, not by
  email. Links expire after 30 days and can be revoked while pending.
- **Uploaded photos live in a public bucket.** Writes require trip
  editorship, but a file's URL is readable by anyone who has it.

## For self-hosters

Most real-world risk is configuration, not code. Worth getting right:

- Keep URL restrictions on the browser Mapbox token and API/domain
  restrictions on the Google key.
- Never put a Supabase **service-role** key in `.env.local` or any `VITE_*`
  variable — it belongs only in Edge Function secrets.
- Deploy the security headers in [`public/_headers`](public/_headers), or the
  equivalent for your host.
- Consider [invite-only mode](README.md#invite-only-mode) so strangers can't
  create accounts on your instance.
