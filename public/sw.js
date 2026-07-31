// __BUILD_VERSION__ is replaced at build time by scripts/stamp-sw.mjs so every deploy
// gets its own cache name automatically. The activate handler deletes any
// cache whose name isn't the current one, so each deploy purges the previous
// build's assets once the new worker takes over — without this, long-lived
// clients accumulated every deploy's hashed chunks until someone remembered
// to bump a manual version string. (In dev the literal placeholder serves as
// the version; nothing breaks.)
const CACHE = 'cairn-__BUILD_VERSION__';

// Only the app shell is pre-cached; hashed build assets are cached on demand.
const SHELL = ['/', '/manifest.json'];

// Deliberately NO skipWaiting/clients.claim: a new worker installs quietly and
// takes over on the next full app launch. Seizing control of a live page and
// reloading it mid-session wedged the iOS standalone PWA on the splash screen
// (WebKit hung the reload before React mounted). Freshness doesn't need the
// takeover anyway — navigations are network-first no-store and assets are
// content-hashed, so a new deploy's content arrives on next launch no matter
// which worker version is still active.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Cross-origin (trip/place photos, map tiles, the Supabase API, Google):
  // don't intercept at all — return without calling respondWith and the
  // browser performs the request itself.
  //
  // This is not just an optimisation. A service worker inherits the CSP of
  // the response that served its script, and fetches *it* makes are checked
  // against that policy — not the page's. Proxying a third-party image
  // through `fetch()` here therefore subjected it to the worker's
  // connect-src, which lists only our own APIs, so every cover photo and
  // pasted image URL failed with ERR_FAILED once the worker took control.
  // Letting these pass through keeps them under the page's img-src, where
  // they belong. We never cached them anyway.
  if (!sameOrigin) return;

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
  if (url.pathname.startsWith('/assets/')) {
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

  // The manifest is in the precache but needs a fetch branch to actually be
  // served from it — without this, installed-app launches while offline fail
  // the manifest request even though the bytes are sitting in the cache.
  if (url.pathname === '/manifest.json') {
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match('/manifest.json'))
    );
    return;
  }

  // Same-origin images — the app icons. (Cover and place photos are all
  // cross-origin and returned above, so they never reach this branch.)
  if (request.destination === 'image') {
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

  // Any other same-origin request: leave it to the browser.
});
