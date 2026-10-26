/* Lekh service worker — lets the app open offline after the first visit. */
const CACHE = 'lekh-v10';
const CORE = ['./', './index.html', './styles.css', './app.js', './templates.js', './docx-import.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'api.github.com' || url.hostname.endsWith('githubusercontent.com')) return; // never cache sync traffic
  const isCode = url.origin === location.origin;
  // App files: network first so updates show up, cache as fallback. Libraries & fonts: cache first.
  e.respondWith(isCode
    ? fetch(req, { cache: 'no-cache' }).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; }).catch(() => caches.match(req, { ignoreSearch: true }))
    : caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })));
});
