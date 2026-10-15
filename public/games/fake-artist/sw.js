/* Fake Artist service worker: installable PWA + offline app shell. */
const CACHE = 'fake-artist-v2';
const BASE = '/games/fake-artist';
const ASSETS = [
  BASE + '/', BASE + '/index.html', BASE + '/style.css', BASE + '/app.js',
  BASE + '/manifest.webmanifest', BASE + '/icon-192.png', BASE + '/icon-512.png',
  BASE + '/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Network-first so deploys land immediately, falling back to the cache offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match(BASE + '/')))
  );
});
