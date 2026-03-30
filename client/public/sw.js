const CACHE_NAME = 'gcap-v3';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(['/', '/index.html'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Only handle GET requests
  if (e.request.method !== 'GET') {
    e.respondWith(fetch(e.request));
    return;
  }
  
  e.respondWith(
    fetch(e.request).then((res) => {
      // Clone response and cache it (network first strategy)
      let resClone = res.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone));
      return res;
    }).catch(() => {
      // If network fails (offline), fall back to cache! This offline support is REQUIRED by Chrome for PWA install popups.
      return caches.match(e.request);
    })
  );
});
