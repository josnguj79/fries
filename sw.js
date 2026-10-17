const CACHE_NAME = 'kimana-fries-v3';
const assetsToCache = [
  './',
  './index.html',
  './rider.html',
  './claim.html',
  './rider-dashboard.html',
  './manifest.json'
];

// Install Event
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        assetsToCache.map(path => cache.add(path).catch(err => console.warn('Cache skip:', path)))
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
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event (CRITICAL: Bypass cross-origin API calls like Render)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // If the request is going to an external API (Render), do not intercept!
  if (url.origin !== location.origin) {
    return; // Let the browser handle cross-origin API requests normally
  }

  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});
