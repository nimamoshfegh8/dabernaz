'use strict';
const CACHE_NAME = 'dabernaz-static-v9-auth-auto-game';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon.svg', './assets/room-lobby-art.png', './assets/bingocoin.svg', './assets/daberna-icon.jpg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  // Never cache API responses: authentication, queue state and live draws must stay fresh.
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin || requestUrl.pathname.startsWith('/api/')) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)); }
    return response;
  }).catch(() => caches.match('./index.html'))));
});
