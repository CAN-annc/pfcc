/**
 * PFCC Service Worker — Offline-First (ADR-002)
 *
 * Cache strategy:
 *   App shell (HTML/JS/CSS) → Cache First, network fallback
 *   /api/* (market data)    → Network Only, never cached
 *   Fonts / CDN assets      → Stale While Revalidate
 *
 * User financial data lives in IndexedDB only — SW never touches it.
 */

const CACHE_NAME  = 'pfcc-shell-v1';
const SHELL_URLS  = ['/', '/index.html', '/db.js', '/market.js', '/calc.js', '/manifest.json'];

// ── Install: pre-cache app shell ──────────────────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: route by resource type ─────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // API calls (market data / FX) → Network Only, never cache
  // User data never flows through here — IndexedDB is accessed directly by the page.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(request));
    return;
  }

  // External fonts / CDN → Stale While Revalidate
  if (!url.origin.includes(self.location.origin)) {
    e.respondWith(staleWhileRevalidate(request));
    return;
  }

  // App shell → Cache First, fallback to network then offline page
  e.respondWith(
    caches.match(request)
      .then(cached => {
        if (cached) {
          // Kick off background refresh
          fetch(request).then(res => {
            if (res.ok) caches.open(CACHE_NAME).then(c => c.put(request, res));
          }).catch(() => {});
          return cached;
        }
        return fetch(request).then(res => {
          if (res.ok && request.method === 'GET') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, clone));
          }
          return res;
        }).catch(() => caches.match('/index.html')); // offline fallback
      })
  );
});

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const fetchPromise = fetch(request).then(res => {
    if (res.ok) caches.open(CACHE_NAME).then(c => c.put(request, res.clone()));
    return res;
  }).catch(() => cached);
  return cached ?? fetchPromise;
}
