import { firebaseConfig } from './firebase-config.js';
import { persistentCacheWasChosen } from './offline-policy.mjs';

const FIREBASE_VERSION = '12.19.0';
const FIREBASE_CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
let appPromise;
let authPromise;
let firestorePromise;
const functionsPromises = new Map();

if (['authDomain', 'projectId'].some((key) => String(firebaseConfig?.[key] || '').startsWith('REPLACE_') || !firebaseConfig?.[key])) {
  throw new Error('Add the exact authDomain and projectId from Firebase Console to firebase-config.js.');
}

async function withRetryablePromise(current, create, save) {
  if (current) return current;
  const pending = Promise.resolve().then(create);
  save(pending);
  try { return await pending; }
  catch (error) {
    save(null);
    throw error;
  }
}

export function getFirebaseApp() {
  return withRetryablePromise(appPromise, async () => {
    const { getApps, initializeApp } = await import(`${FIREBASE_CDN}firebase-app.js`);
    return getApps().find((entry) => entry.name === '[DEFAULT]') || initializeApp(firebaseConfig);
  }, (value) => { appPromise = value; });
}

export function getFirebaseAuth() {
  return withRetryablePromise(authPromise, async () => {
    const [app, api] = await Promise.all([
      getFirebaseApp(),
      import(`${FIREBASE_CDN}firebase-auth.js`)
    ]);
    return { app, auth: api.getAuth(app), api };
  }, (value) => { authPromise = value; });
}

export function getFirebaseFirestore() {
  return withRetryablePromise(firestorePromise, async () => {
    const [app, api] = await Promise.all([
      getFirebaseApp(),
      import(`${FIREBASE_CDN}firebase-firestore.js`)
    ]);
    let wantsPersistentCache = false;
    try { wantsPersistentCache = persistentCacheWasChosen(globalThis.localStorage); }
    catch { /* Use memory cache if site storage is blocked. */ }

    let db;
    let offlineCacheMode = 'memory';
    if (wantsPersistentCache) {
      try {
        db = api.initializeFirestore(app, {
          localCache: api.persistentLocalCache({ tabManager: api.persistentMultipleTabManager() })
        });
        offlineCacheMode = 'persistent';
      } catch (error) {
        console.warn('Persistent Firestore storage is unavailable; using in-memory Firestore cache.', error);
        try { db = api.initializeFirestore(app, { localCache: api.memoryLocalCache() }); }
        catch { db = api.getFirestore(app); }
      }
    } else {
      db = api.getFirestore(app);
    }
    return { app, db, api, offlineCacheMode };
  }, (value) => { firestorePromise = value; });
}

export function getFirebaseFunctions(region = 'us-central1') {
  const key = String(region || 'us-central1');
  return withRetryablePromise(functionsPromises.get(key), async () => {
    const [app, api] = await Promise.all([
      getFirebaseApp(),
      import(`${FIREBASE_CDN}firebase-functions.js`)
    ]);
    return { app, functions: api.getFunctions(app, key), api };
  }, (value) => {
    if (value) functionsPromises.set(key, value);
    else functionsPromises.delete(key);
  });
}
