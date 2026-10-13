import { getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore, initializeFirestore, memoryLocalCache,
  persistentLocalCache, persistentMultipleTabManager
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { persistentCacheWasChosen } from './offline-policy.mjs';

if (['authDomain', 'projectId'].some((key) => firebaseConfig[key].startsWith('REPLACE_'))) {
  throw new Error('Add the exact authDomain and projectId from Firebase Console to firebase-config.js.');
}

export const app = getApps().find((entry) => entry.name === '[DEFAULT]') || initializeApp(firebaseConfig);
export const auth = getAuth(app);

let wantsPersistentCache = false;
try { wantsPersistentCache = persistentCacheWasChosen(globalThis.localStorage); } catch { /* Use memory cache if site storage is blocked. */ }
let firestore;
let firestoreCacheMode = 'memory';
if (wantsPersistentCache) {
  try {
    firestore = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
    firestoreCacheMode = 'persistent';
  } catch (error) {
    console.warn('Persistent Firestore storage is unavailable; using in-memory Firestore cache.', error);
    try { firestore = initializeFirestore(app, { localCache: memoryLocalCache() }); }
    catch { firestore = getFirestore(app); }
  }
} else {
  firestore = getFirestore(app);
}

export const db = firestore;
export const offlineCacheMode = firestoreCacheMode;
