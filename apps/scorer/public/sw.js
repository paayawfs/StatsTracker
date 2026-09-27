// Offline shell for the scorer app. Network-first for navigations (so updates land when online),
// cache-first for hashed assets. Supabase traffic is never cached.
const CACHE = 'scorer-v1';

// Pre-cache the shell and every asset index.html references. On a first visit the page's own
// JS/CSS load before the worker controls it, so runtime caching alone would miss them.
self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const html = await (await fetch('/', { cache: 'no-cache' })).text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
      await cache.addAll(['/', '/manifest.webmanifest', '/icon.svg', ...assets]);
    })(),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/', { ignoreVary: true })),
    );
    return;
  }

  e.respondWith(
    // ignoreVary: Vite adds crossorigin (Origin header), servers answer Vary: Origin, and the
    // pre-cached copies were fetched without Origin. Same-origin hashed files: safe to ignore.
    caches.match(req, { ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
