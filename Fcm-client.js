// fcm-client.js - BodaSwift Web Push Client Module
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-messaging.js";

// REPLACE THESE WITH YOUR EXACT FIREBASE CONSOLE WEB APP CONFIG
const firebaseConfig = {
  apiKey: "AIzaSyByYP8HHxy1LSV6nrG7kBAwMjFh6IuYMC4",
  authDomain: "bodaswift-auth.firebaseapp.com",
  projectId: "bodaswift-auth",
  storageBucket: "bodaswift-auth.firebasestorage.app",
  messagingSenderId: "973632392043",
  appId: "1:973632392043:web:3d7439b12e522e04a31a2e",
};

// REPLACE THIS WITH YOUR PAIR KEY FROM FIREBASE CONSOLE > PROJECT SETTINGS > CLOUD MESSAGING > WEB PUSH CERTIFICATES
const VAPID_KEY = "BFgaCO0LeZ3n8HL3083u_VgflsH3ib6F5f4OEBQoF3LetnY_fWVVcPtlBrjHW-ioycw1TV2i8VIFNIXuHg1-thY";

const app = initializeApp(firebaseConfig);
const messaging = getMessaging(app);

const BACKEND_API = 'https://fries-v0l8.onrender.com';

/**
 * Requests notification permission, obtains the FCM token,
 * and persists it to the Turso backend linked with the user's phone number.
 * 
 * @param {string} userPhone - Phone number in E.164 / local format
 * @param {string} role - 'customer' or 'rider'
 * @returns {Promise<string|null>} FCM token if granted, or null if denied/failed
 */
export async function registerPushNotifications(userPhone, role = 'customer') {
  if (!userPhone) {
    console.warn('[FCM Client] Phone number is required to register push token.');
    return null;
  }

  const cleanPhone = String(userPhone).trim();

  try {
    // 1. Prompt browser for notification permissions
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('[FCM Client] Notification permission denied by user.');
      return null;
    }

    // 2. Fetch unique FCM device token from Firebase
    const currentToken = await getToken(messaging, { vapidKey: VAPID_KEY });

    if (currentToken) {
      console.log('✅ FCM Device Token Generated:', currentToken);

      // 3. Register token on backend linked to the user's phone number
      const res = await fetch(`${BACKEND_API}/api/notifications/register-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: cleanPhone, token: currentToken, role })
      });

      const data = await res.json();
      if (res.ok) {
        console.log('✅ Push token successfully registered on server!');
        return currentToken;
      } else {
        console.error('❌ Server failed to register push token:', data.message);
      }
    } else {
      console.warn('[FCM Client] No registration token available.');
    }
  } catch (err) {
    console.error('[FCM Client Exception]:', err);
  }

  return null;
}

// 4. Handle incoming push alerts when the app / tab is actively open in the foreground
onMessage(messaging, (payload) => {
  console.log('[FCM Foreground Alert]:', payload);
  
  const title = payload?.notification?.title || '🍔 Kimana Fries Alert';
  const body = payload?.notification?.body || 'You have a new update!';

  // Show standard in-app alert or custom banner
  alert(`🔔 ${title}\n\n${body}`);
});

// Expose globally so inline non-module scripts can call it directly
if (typeof window !== 'undefined') {
  window.registerPushNotifications = registerPushNotifications;
}
