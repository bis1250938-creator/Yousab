import { getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { firebaseConfig, mediaStorageProvider } from './firebase-config.js';

if (['authDomain', 'projectId'].some((key) => firebaseConfig[key].startsWith('REPLACE_'))) {
  throw new Error('Add the exact authDomain and projectId from Firebase Console to firebase-config.js.');
}

export const app = getApps().find((entry) => entry.name === '[DEFAULT]') || initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storageBucket = firebaseConfig.storageBucket;
export { mediaStorageProvider };
