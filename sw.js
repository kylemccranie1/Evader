const SHELL = 'evader-shell-v1', TILES = 'evader-tiles-v1', MAX_TILES = 600;
const ASSETS = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'js/app.js', 'js/geo.js', 'js/guardrails.js', 'js/police.js',
  'icons/icon.svg', 'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.allSettled(ASSETS.map((a) => c.add(a)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![SHELL, TILES].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trim(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_TILES)).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  // Live data (Overpass, police feed) is never served stale from here; the app caches zones itself.
  if (url.hostname.includes('overpass')) return;
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok) { c.put(req, r.clone()); trim(c); } return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  const known = url.origin === location.origin;
  if (!known) return;
  // Network-first so deploys show up; fall back to cache offline.
  e.respondWith(fetch(req).then((r) => {
    if (r.ok) caches.open(SHELL).then((c) => c.put(req, r.clone()));
    return r;
  }).catch(() => caches.match(req).then((m) => m || caches.match('index.html'))));
});
