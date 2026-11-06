'use strict';

// The service worker must not pin old app.js/styles.css after a Pages deployment.
// Core code is network-first; cached copies are used only when the device is offline.
const CACHE_NAME = 'dabernaz-shell-v3';
const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css?v=4.2.0',
  './app.js?v=4.2.0',
  './icon.svg',
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
    // Bypass the browser HTTP cache as well as the service-worker cache.
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

  // HTML, JavaScript and CSS must reflect the most recent Cloudflare deployment.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, './index.html'));
    return;
  }
  if (request.destination === 'script' || request.destination === 'style') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Images and fonts may remain cache-first for faster repeat visits.
  if (request.destination === 'image' || request.destination === 'font') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      const network = fetch(request).then(async response => {
        if (response && response.ok) await cache.put(request, response.clone());
        return response;
      });
      return cached || network;
    })());
  }
});
