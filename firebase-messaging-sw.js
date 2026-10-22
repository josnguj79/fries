// firebase-messaging-sw.js
importScripts('https://www.gstatic.com/firebasejs/10.9.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.9.0/firebase-messaging-compat.js');

// Initialize Firebase synchronously on initial script evaluation
firebase.initializeApp({
  apiKey: "AIzaSyByYP8HHxy1LSV6nrG7kBAwMjFh6IuYMC4",
  authDomain: "bodaswift-auth.firebaseapp.com",
  projectId: "bodaswift-auth",
  storageBucket: "bodaswift-auth.firebasestorage.app",
  messagingSenderId: "973632392043",
  appId: "1:973632392043:web:3d7439b12e522e04a31a2e",
});

const messaging = firebase.messaging();

// Handle background push messages synchronously on initial evaluation
messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message: ', payload);

  const notificationTitle = 
    payload?.notification?.title || 
    payload?.data?.title || 
    '🔐 BodaSwift Access Passcode';

  const notificationBody = 
    payload?.notification?.body || 
    payload?.data?.body || 
    payload?.data?.message || 
    'Your verification code is ready.';

  const notificationOptions = {
    body: notificationBody,
    icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🍟</text></svg>',
    data: {
      url: payload?.data?.url || './index.html'
    }
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification click event synchronously on initial evaluation
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './customer-dashboard.html';

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
