'use strict';

// App shell assets are cached for first-load/offline recovery. Live app code remains network-first.
const CACHE_NAME = 'dabernaz-shell-v34';
const CORE_ASSETS = [
  './',
  './index.html',
  './install.html',
  './styles.css?v=4.8.0',
  './pwa-install.css?v=1',
  './app.js?v=4.30.0',
  './install.js?v=1',
  './pwa-entry.js?v=1',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './manifest.webmanifest'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CORE_ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith('dabernaz-') && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function networkFirst(request, cacheKey = request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response && response.ok) await cache.put(cacheKey, response.clone());
    return response;
  } catch (_) {
    return (await cache.match(cacheKey)) || Response.error();
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname.startsWith('/admin/')) return;

  if (request.mode === 'navigate') {
    const offlineFallback = url.pathname.endsWith('/install.html') ? './install.html' : './index.html';
    event.respondWith(networkFirst(request, offlineFallback));
    return;
  }
  if (request.destination === 'script' || request.destination === 'style') {
    event.respondWith(networkFirst(request));
    return;
  }
  if (request.destination === 'image' || request.destination === 'font') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      const network = fetch(request).then(async response => {
        if (response && response.ok) await cache.put(request, response.clone());
        return response;
      }).catch(() => cached || Response.error());
      // Keep the refresh promise handled even when a cached asset is returned immediately.
      return cached || network;
    })());
  }
});
