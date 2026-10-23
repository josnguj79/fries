// sw.js - Service Worker for PWA Caching & Failsafe Push Handling
const CACHE_NAME = 'kimana-fries-v4';
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

// Fetch Event (Bypasses cross-origin API calls like Render)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) {
    return; 
  }
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});

// ==========================================
// FAILSAFE PUSH LISTENER (Catches BodaSwift OTPs)
// ==========================================
self.addEventListener('push', (event) => {
  try {
    const payload = event.data ? event.data.json() : {};
    console.log('[sw.js Failsafe Push Received]:', payload);

    // Extract data payload sent from server.js
    const data = payload.data || {};
    const title = data.title || '🔐 BodaSwift Access Passcode';
    
    let body = data.body;
    if (data.otpCode) {
      body = `Your BodaSwift verification code is: ${data.otpCode}`;
    } else if (!body) {
      body = 'Your verification code is ready.';
    }

    const options = {
      body: body,
      icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🍟</text></svg>',
      badge: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🍟</text></svg>',
      tag: 'bodaswift-otp-passcode',
      renotify: true,
      requireInteraction: true,
      data: {
        url: data.url || './rider-dashboard.html',
        otpCode: data.otpCode || ''
      }
    };

    event.waitUntil(
      self.registration.showNotification(title, options)
    );
  } catch (err) {
    console.error('[sw.js Push Error Failsafe]:', err);
  }
});

// Handle notification click (focuses portal page or opens new window)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './rider-dashboard.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
