# Cairn

**A collaborative trip planner for people who plan trips together.**

Cairn turns a scattered pile of "we should go here" links, screenshots, and notes into one shared trip: a map of every place you're considering, a reorderable list, tags, photos, and a note-and-source trail for each stop — all shared live with whoever you're traveling with.

This is a self-hostable app built on [Supabase](https://supabase.com) (Postgres, Auth, Storage) and [Mapbox](https://www.mapbox.com/). This README is written for people who want to run their own instance.

<p align="center">
  <img src="docs/screenshots/auth.png" width="260" alt="Sign-in screen" />
</p>

## Contents

- [What it does](#what-it-does)
- [Tech stack](#tech-stack)
- [Self-hosting guide](#self-hosting-guide)
  - [1. Prerequisites](#1-prerequisites)
  - [2. Clone and install](#2-clone-and-install)
  - [3. Create a Supabase project](#3-create-a-supabase-project)
  - [4. Set up Storage](#4-set-up-storage)
  - [5. Get a Mapbox token](#5-get-a-mapbox-token)
  - [6. Get a Google Places API key](#6-get-a-google-places-api-key)
  - [7. Configure environment variables](#7-configure-environment-variables)
  - [8. Run it locally](#8-run-it-locally)
  - [9. Build and deploy](#9-build-and-deploy)
- [Installing as an app (PWA)](#installing-as-an-app-pwa)
- [Inviting collaborators](#inviting-collaborators)
- [Project structure](#project-structure)
- [Optional: photo persistence edge function](#optional-photo-persistence-edge-function)

## What it does

A **trip** is a shared space with a name, dates, a cover photo, and a list of collaborators. Inside a trip:

- **Map & list views** — every place plotted on a Mapbox map with emoji-tagged markers, or as a reorderable (drag-and-drop) list.
- **Search & quick-add** — find places via Google Places autocomplete, or paste a link/photo straight in.
- **Per-place detail** — notes, source links (the article/reel/map link that convinced you to add it), a tag-coded photo gallery, and a visited/planned toggle.
- **Tags** — color- and emoji-coded, filterable, trip-scoped.
- **Collaborators** — invite people by email with `editor` or `viewer` roles; everything updates for the whole group.
- **Visited routing** — draws the real road route (via Mapbox Directions) between places you've marked visited, in order, falling back to a straight dashed line where no road route exists (e.g. between islands).
- **Installable PWA** — add it to your home screen for an app-like, offline-tolerant experience.

|                                                     |                                                       |
| --------------------------------------------------- | ----------------------------------------------------- |
| ![Trip list](docs/screenshots/trip-list.png)        | ![Map view](docs/screenshots/trip-map.png)             |
| ![Places list](docs/screenshots/trip-places-list.png) | ![Place detail](docs/screenshots/place-detail.png)   |

<p align="center">
  <img src="docs/screenshots/trip-settings.png" width="260" alt="Trip settings" />
</p>

## Tech stack

- **Frontend**: React 19 + TypeScript, built with Vite
- **Backend**: [Supabase](https://supabase.com) — Postgres with Row Level Security, Auth (email/password), and Storage
- **Maps**: [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/) for rendering, Mapbox Directions API for routing
- **Place search & photos**: Google Maps JavaScript API (Places library)
- **No custom backend server** — the client talks to Supabase and the map/places APIs directly; the only server-side logic lives in Postgres functions (RLS policies and a handful of `SECURITY DEFINER` RPCs for things like inviting collaborators) plus one optional edge function (see [below](#optional-photo-persistence-edge-function))

## Self-hosting guide

### 1. Prerequisites

You'll need accounts (all have generous free tiers) for:

- [Supabase](https://supabase.com) — database, auth, storage
- [Mapbox](https://www.mapbox.com) — map rendering & routing
- [Google Cloud](https://console.cloud.google.com) — Places API for place search & photos
- Node.js **20+** and npm
- A static hosting provider for the production build — Cloudflare Pages, Netlify, Vercel, or anything that can serve a Vite SPA (a `public/_redirects` file for Netlify-style SPA fallback routing is already included)

### 2. Clone and install

```bash
git clone <your-fork-url>
cd travel-planner
npm install
```

### 3. Create a Supabase project

1. Create a new project at [supabase.com](https://supabase.com/dashboard).
2. Open the **SQL Editor** and run the entire contents of [`supabase/schema.sql`](supabase/schema.sql). This creates all tables (`trips`, `trip_members`, `places`, `tags`, `place_tags`, `place_images`), the Row Level Security policies that scope every row to trip membership, and the RPCs the app calls (`create_trip`, `invite_collaborator`, `remove_collaborator`, `get_trip_members`).
3. Go to **Authentication → Providers** and make sure **Email** sign-up is enabled (it is by default). Cairn uses plain email/password auth — no OAuth setup required.
4. From **Project Settings → API**, note down the **Project URL** and the **`anon` public key** — you'll need both shortly.

### 4. Set up Storage

Trip cover photos and place photos that you upload directly (as opposed to pasting a URL) are stored in Supabase Storage.

1. Go to **Storage** and create a new bucket named exactly **`place-images`**.
2. Make it a **public** bucket (uploaded photos are served directly via their public URL; access to the trip data itself is still governed by RLS).

### 5. Get a Mapbox token

1. Sign up at [mapbox.com](https://account.mapbox.com/) and grab your **default public token** (starts with `pk.`) from the [Access Tokens](https://account.mapbox.com/access-tokens/) page.
2. No special scopes are needed — the default public token covers map rendering and the Directions API used for visited-place routing.

### 6. Get a Google Places API key

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project (or reuse one) and enable the **Maps JavaScript API** and **Places API**.
2. Create an API key under **APIs & Services → Credentials**.
3. Restrict the key to those two APIs and to your app's domain(s) for production use.

This key powers the place search/autocomplete when adding a place, and pulling in a place's photo.

### 7. Configure environment variables

Create a `.env.local` file in the project root:

```bash
VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
VITE_MAPBOX_TOKEN=pk.eyJ...
VITE_GOOGLE_PLACES_KEY=AIza...
```

If these aren't set, the app shows a setup screen with this same checklist instead of crashing.

### 8. Run it locally

```bash
npm run dev
```

Open the printed local URL, sign up for an account (this creates a real row in Supabase `auth.users` — there's no seed data), and create your first trip.

Other scripts:

```bash
npm run build    # type-checks (tsc -b) then builds to dist/
npm run preview  # serves the production build locally
npm run lint      # eslint
```

### 9. Build and deploy

```bash
npm run build
```

This produces a static `dist/` folder — deploy it to any static host.

- **Cloudflare Pages / Netlify**: point the build command at `npm run build` and the output directory at `dist`. Make sure the same four `VITE_*` environment variables are set in the hosting provider's dashboard (they're baked in at build time, not read at runtime).
- **SPA routing**: the app uses real paths like `/trip/:id` and `/shared/:token` for deep-linking, so your host needs to fall back to `index.html` for unknown paths. `public/_redirects` (Netlify/Cloudflare Pages syntax: `/* /index.html 200`) is already set up for that; translate it to your host's equivalent if you're using something else (e.g. a Vercel `rewrites` rule).

## Installing as an app (PWA)

Cairn is an installable PWA — on a phone, open it in the browser and use "Add to Home Screen" (iOS Safari) or the install prompt (Android Chrome) for a full-screen, app-like experience with an offline banner when connectivity drops.

## Inviting collaborators

Trip settings lets the trip owner invite people by email as an `editor` (can add/edit places) or `viewer` (read-only). One important self-hosting detail: **invited users must already have an account** — `invite_collaborator` looks up an existing row in `auth.users` by email and fails with "No account found" otherwise. There's no invite-by-email-signup flow, so ask people to sign up first.

## Project structure

```
src/
  components/   UI screens & sheets (TripView, PlaceDetailSheet, MapView, ...)
  hooks/        Data hooks wrapping Supabase queries (useTrips, usePlaces, useAuth, ...)
  lib/          Supabase client, toast store, Mapbox routing, Google Photos helpers
  types/        Shared TypeScript types
supabase/
  schema.sql    Full database schema, RLS policies, and RPCs — run this once on a fresh project
public/         Static assets, PWA manifest, service worker
```

## Optional: photo persistence edge function

When you add a place via Google Places search, its photo is served from a temporary Google-hosted URL that expires. The app tries to call a Supabase Edge Function named `persist-photo` to download that photo server-side and re-upload it into your own `place-images` bucket for a stable, permanent URL (this has to happen server-side because Google's photo CDN doesn't send CORS headers, so the browser can't fetch it directly).

This function isn't included in this repo yet. Without it, the app degrades gracefully — it just keeps using the temporary Google URL, which will eventually stop loading for older places. If you want permanent photos, you'll need to write and deploy your own `persist-photo` edge function that:

1. Accepts `{ photoUrl, path }` in the request body, authenticated with the caller's JWT.
2. Fetches `photoUrl` server-side and uploads the bytes to the `place-images` bucket at `path`.
3. Returns `{ url: <public URL> }`.
