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
// sw.js - Service Worker for BodaSwift Push Notifications

// Listen for incoming Web Push notifications from FCM
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  
  const title = data.title || '🍔 Kimana Fries Update';
  const options = {
    body: data.body || 'You have a new delivery update!',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: data.url || './index.html' }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Handle notification click (opens target portal page)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data.url;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus existing tab if open, otherwise open new window
      for (let client of windowClients) {
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
