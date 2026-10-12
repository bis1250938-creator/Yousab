// Public Firebase Web app settings shared by the page and its classic service worker.
// The VAPID key is public. Never put a VAPID private key or service-account key here.
globalThis.YJ_FIREBASE_CONFIG = Object.freeze({
  apiKey: "AIzaSyAMDW3JJZ-nNnXLQveUd3gcwiBLX4F0nB4",
  authDomain: "yj-studio-50df5.firebaseapp.com",
  projectId: "yj-studio-50df5",
  storageBucket: "yj-studio-50df5.firebasestorage.app",
  messagingSenderId: "1058803606124",
  appId: "1:1058803606124:web:84a26afbad30d79433ae49",
  measurementId: "G-JJ4E1W0RDM"
});

// Firebase Console → Project settings → Cloud Messaging → Web Push certificates.
// Paste the PUBLIC key pair value here before enabling browser subscriptions.
globalThis.YJ_FCM_VAPID_KEY = '';
