'use strict';
// Older builds cached the demo UI. Remove those caches so the live app is fetched.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(registration => registration.unregister()));
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter(key => key.toLowerCase().includes('dabernaz')).map(key => caches.delete(key)));
      }
    } catch (_) { /* The app itself works without the cleanup API. */ }
  });
}
