'use strict';
// Self-removing worker: prevent old demo assets from being served from cache.
self.addEventListener('install', event => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.toLowerCase().includes('dabernaz')).map(key => caches.delete(key)));
    await self.registration.unregister();
    await self.clients.claim();
  })());
});
