self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  return self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // A minimal fetch handler is required by Chrome to show the PWA install prompt.
  // We just let the request pass through.
  e.respondWith(fetch(e.request).catch(err => {
    return new Response("App is running offline", { status: 503, statusText: "Service Unavailable" });
  }));
});
