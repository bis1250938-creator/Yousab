// Keep the same public configuration available to the page and classic worker.
import './firebase-public-config.js';
export const firebaseConfig = globalThis.YJ_FIREBASE_CONFIG;
export const fcmVapidKey = globalThis.YJ_FCM_VAPID_KEY;

// Set this to the deployed public HTTPS endpoint; R2 credentials remain in the Worker.
export const r2WorkerUrl = '';
