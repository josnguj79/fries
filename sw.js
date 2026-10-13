const CACHE_NAME = 'kimana-fries-v2';
const assetsToCache = [
  './',
  './index.html',
  './manifest.json'
];

// Install Event (Resilient Caching)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use add instead of addAll so one missing file won't abort everything
      return Promise.allSettled(
        assetsToCache.map(path => cache.add(path).catch(err => console.warn('Failed to cache:', path, err)))
      );
    })
  );
  self.skipWaiting();
});

// Activate Event
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});
