import { getFirebaseAuth } from './firebase-client.js';

const subscribers = new Set();
let authRuntimePromise = null;
let authObserverStarted = false;
let currentUser = null;
let authStateReady = false;

function notifySubscribers(user) {
  currentUser = user || null;
  authStateReady = true;
  for (const subscriber of [...subscribers]) {
    try { subscriber(currentUser); }
    catch (error) { console.error('YJ Studios auth-state handler failed:', error); }
  }
  window.dispatchEvent(new CustomEvent('yj:auth-state-changed', { detail: { user: currentUser } }));
}

export async function ensureAuthSession() {
  if (!authRuntimePromise) {
    authRuntimePromise = getFirebaseAuth().then((runtime) => {
      if (!authObserverStarted) {
        authObserverStarted = true;
        runtime.api.onAuthStateChanged(runtime.auth, notifySubscribers, (error) => {
          console.error('YJ Studios could not restore the Firebase session:', error);
        });
      }
      return runtime;
    }).catch((error) => {
      authRuntimePromise = null;
      throw error;
    });
  }
  return authRuntimePromise;
}

export function subscribeAuthState(subscriber) {
  if (typeof subscriber !== 'function') throw new TypeError('An auth-state callback is required.');
  subscribers.add(subscriber);
  if (authStateReady) queueMicrotask(() => {
    if (subscribers.has(subscriber)) subscriber(currentUser);
  });
  ensureAuthSession().catch((error) => {
    if (subscribers.has(subscriber)) subscriber(null, error);
  });
  return () => subscribers.delete(subscriber);
}

export function getCurrentAuthUser() { return authStateReady ? currentUser : null; }
export function isAuthStateReady() { return authStateReady; }
