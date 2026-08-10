# CLAUDE.md

Working agreements for this repository. These apply to Claude and to any other
agent or contributor working here.

## Branches and pull requests

`main` is protected by convention: **never commit to it directly.** Every
change — features, fixes, docs, chores — goes on a branch and lands through a
pull request.

- Branch naming: `feat/…`, `fix/…`, `chore/…`, `docs/…`
- One concern per branch. If a change is unrelated to the branch you're on,
  open a second branch (a worktree is a convenient way to do both at once
  without disturbing a checkout something else is reading).
- CI (`npm run lint` + `npm run build`) must pass before merge. A Cloudflare
  Pages preview deploy is attached to every PR — use it to check UI changes on
  a real device rather than asserting they work.

## Review before merge

Every PR gets a code review before it is merged. No self-merging unreviewed.

Reviews produced by Claude are posted to GitHub under a reviewer persona name,
**on behalf of @thkleinert** — whose account is the one GitHub will show as the
comment author, since that is the only account available and authorship is not
forgeable.

The persona is a readability convenience, not a disguise. Because this
repository is public, an AI-generated review must never be allowed to read as
an independent human sign-off. Therefore:

- Sign the review with the persona name **and** state plainly in the same
  sign-off that it is an AI review posted on behalf of @thkleinert.
- Never imply the reviewer independently ran, tested, or manually verified
  anything they did not.
- Report findings honestly, including "found nothing significant". A review
  that invents issues to look thorough is worse than no review.

Example sign-off:

> — Marlowe Quinn · _automated review by Claude, posted on behalf of
> @thkleinert_

## Verification

Prefer evidence over assertion. `tsc`, `eslint` and `npm run build` are the
floor, not the ceiling — for anything involving map gestures, sheets, or Google
/ Mapbox responses, drive the real app and say what was actually observed.

Notes that make this easier:

- Serve the **production build** on **port 5173** when testing against Google
  Places: the API key is origin-restricted and rejects other ports, and a
  StrictMode double-mount bug renders zero map markers under `npm run dev`.
- Never commit secrets. `.env.local` is gitignored; scan a diff before pushing
  to this public repo.

## Cost awareness

Google Maps calls are billed per SKU with monthly free caps. Before adding a
new lookup, check which tier it lands on — Nearby Search is Pro tier (5,000
free calls/month), while the search field's Autocomplete session is free. Never
fire a billed lookup speculatively on pan, zoom, or hover; memoise by rounded
coordinate so the same spot cannot bill twice.
