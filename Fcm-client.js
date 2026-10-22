// fcm-client.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-messaging.js";

const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig);
const messaging = getMessaging(app);

/**
 * Request browser notification permission and get FCM token
 */
export async function registerPushNotifications(userPhone, role = 'customer') {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.log('Push notification permission denied.');
      return;
    }

    // Register web push token with VAPID key from Firebase Console
    const currentToken = await getToken(messaging, { 
      vapidKey: 'YOUR_FIREBASE_VAPID_KEY_FROM_PROJECT_SETTINGS' 
    });

    if (currentToken) {
      console.log('FCM Device Token captured:', currentToken);
      
      // Send token to backend to link with user phone
      await fetch('https://fries-v0l8.onrender.com/api/notifications/register-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: userPhone, token: currentToken, role })
      });
    } else {
      console.log('No registration token available. Request permission to generate one.');
    }
  } catch (err) {
    console.error('An error occurred while retrieving token. ', err);
  }
}

// Handle foreground messages when app is open
onMessage(messaging, (payload) => {
  console.log('Message received in foreground: ', payload);
  alert(`🔔 ${payload.notification.title}\n\n${payload.notification.body}`);
});
