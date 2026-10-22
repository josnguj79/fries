// firebase-messaging-sw.js
importScripts('https://www.gstatic.com/firebasejs/10.9.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.9.0/firebase-messaging-compat.js');

const BACKEND_API = 'https://fries-v0l8.onrender.com';

// Fetch Firebase Configuration dynamically from Render backend on SW startup
fetch(`${BACKEND_API}/api/config/firebase`)
  .then((response) => response.json())
  .then((config) => {
    if (!config.apiKey) {
      console.error('[firebase-messaging-sw.js] Missing apiKey in fetched config!');
      return;
    }

    firebase.initializeApp({
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: config.projectId,
      storageBucket: config.storageBucket,
      messagingSenderId: config.messagingSenderId,
      appId: config.appId
    });

    const messaging = firebase.messaging();

    // Handle background push messages
    messaging.onBackgroundMessage((payload) => {
      console.log('[firebase-messaging-sw.js] Received background message: ', payload);

      const notificationTitle = payload?.notification?.title || '🔐 BodaSwift Access Passcode';
      const notificationOptions = {
        body: payload?.notification?.body || 'Your verification code is ready.',
        icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🍟</text></svg>',
        data: {
          url: payload?.data?.url || './index.html'
        }
      };

      self.registration.showNotification(notificationTitle, notificationOptions);
    });
  })
  .catch((err) => {
    console.error('[firebase-messaging-sw.js] Failed to initialize Firebase from server config:', err);
  });

// Handle notification click event (opens dashboard)
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
