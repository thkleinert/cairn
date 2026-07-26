// Bump CACHE whenever you need every client to drop its old bundle. The
// activate handler deletes any cache whose name isn't the current one, so
// changing this value purges the previous build on the next launch — the
// escape hatch for "deployed but users still see the old version". (main.tsx
// checks for a new worker on foreground and auto-reloads once it takes over.)
const CACHE = 'cairn-v2';

// Only the app shell is pre-cached; hashed build assets are cached on demand.
const SHELL = ['/', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // Navigation: always network-first so a fresh deploy's index.html — and the
  // new hashed asset URLs it points at — is picked up immediately. Refresh the
  // cached shell on every success; fall back to it only when offline.
  // cache:'no-store' bypasses the browser's own HTTP cache too, so index.html
  // can't be served stale even when this fetch technically "succeeds".
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(res => {
          // Only a healthy response may become the offline shell — caching a
          // transient 500 here would replace the app with an error page for
          // every offline launch until the next successful visit.
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put('/', clone));
          }
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Vite emits content-hashed files under /assets (index-<hash>.js/.css): the
  // URL changes whenever the content does, so they're immutable and safe to
  // serve cache-first. A new build just requests new URLs — which miss the
  // cache and fetch fresh — while the old entries are dropped when CACHE bumps.
  // (The previous worker cached ALL scripts/styles cache-first, which is how a
  // client could get stranded on an old, non-hashed asset.)
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin && url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(request).then(cached =>
        cached || fetch(request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(request, clone));
          }
          return res;
        })
      )
    );
    return;
  }

  // Same-origin images (icons, cached cover photos): cache-first for offline
  // use and speed.
  if (sameOrigin && request.destination === 'image') {
    e.respondWith(
      caches.match(request).then(cached =>
        cached || fetch(request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(request, clone));
          }
          return res;
        })
      )
    );
    return;
  }

  // Everything else (Supabase API, map tiles, cross-origin assets): network,
  // so live data is never served stale from cache.
  e.respondWith(fetch(request));
});
