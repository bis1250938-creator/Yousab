import { app, auth } from './firebase-client.js';
import { fcmVapidKey } from './firebase-config.js';
import { friendlyMessagingError, isInstalledWebApp, isIosDevice } from './notification-policy.mjs';

let onAuthStateChanged = null;
let firebaseSignOut = null;
let sdkLoadError = null;
let registerDeviceCall = async () => { throw sdkLoadError || new Error('Firebase Functions is unavailable.'); };
let removeDeviceCall = registerDeviceCall;
let sendTestCall = registerDeviceCall;
try {
  const authApi = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js');
  onAuthStateChanged = authApi.onAuthStateChanged;
  firebaseSignOut = authApi.signOut;
} catch (error) {
  sdkLoadError = error;
}
try {
  const functionsApi = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js');
  const functions = functionsApi.getFunctions(app, 'us-central1');
  registerDeviceCall = functionsApi.httpsCallable(functions, 'registerNotificationDevice');
  removeDeviceCall = functionsApi.httpsCallable(functions, 'removeNotificationDevice');
  sendTestCall = functionsApi.httpsCallable(functions, 'sendTestNotification');
} catch (error) {
  sdkLoadError ||= error;
}

const byId = (id) => document.getElementById(id);
const dialog = byId('notification-settings-dialog');
const statusText = byId('notification-settings-status');
const permissionText = byId('notification-permission-status');
const authText = byId('notification-auth-status');
const enableButton = byId('notification-enable');
const disableButton = byId('notification-disable');
const testButton = byId('notification-test');
const signInButton = byId('notification-sign-in');
const signOutButton = byId('notification-account-sign-out');
const toast = byId('notification-toast');
let currentUser = null;
let messagingApi = null;
let messaging = null;
let messageUnsubscribe = null;
let registeredUnsubscribe = null;
let unregisteredUnsubscribe = null;
const registrationInFlight = new Map();
const registrationWaiters = new Map();
const registrationWrites = new Map();
const enabledUsers = new Set();
const currentFids = new Map();
let registeredForCurrentDevice = false;
let toastTimer = 0;

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.dataset.error = String(isError);
}

function getLocal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function setLocal(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Storage can be disabled by the browser. */ }
}

function removeLocal(key) {
  try { localStorage.removeItem(key); } catch { /* Storage can be disabled by the browser. */ }
}

function enabledKey(uid) { return `yj-fcm-enabled:${uid}`; }
function fidKey(uid) { return `yj-fcm-fid:${uid}`; }
function fidFor(uid) { return currentFids.get(uid) || getLocal(fidKey(uid)) || ''; }
function hasExplicitOptIn(uid) { return enabledUsers.has(uid) || getLocal(enabledKey(uid)) === 'true'; }

function isNotificationApiAvailable() {
  return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

function updateView() {
  const permission = isNotificationApiAvailable() ? Notification.permission : 'unsupported';
  const authenticated = Boolean(currentUser);
  const iosNeedsInstall = isIosDevice() && !isInstalledWebApp();

  authText.textContent = authenticated
    ? `Signed in as ${currentUser.email || 'Firebase user'}. Device subscriptions are private to this account.`
    : 'Sign in with your verified Firebase account to register this browser.';
  permissionText.textContent = permission === 'unsupported'
    ? (iosNeedsInstall
      ? 'On iPhone or iPad, add this website to the Home Screen first. Web Push requires iOS/iPadOS 16.4 or newer; Firebase support is also checked by this browser.'
      : 'This browser does not expose the APIs required for Web Push notifications.')
    : permission === 'denied'
      ? 'Blocked by browser settings. Change notifications for this site in browser or device settings; this site cannot show the permission prompt again.'
      : permission === 'granted'
        ? (registeredForCurrentDevice ? 'Permission granted · this browser is subscribed.' : 'Permission granted · this browser still needs registration.')
        : 'Not enabled. Permission will only be requested after you select Enable Notifications.';

  enableButton.disabled = !authenticated || permission === 'unsupported';
  disableButton.disabled = !authenticated;
  testButton.disabled = !authenticated || !registeredForCurrentDevice;
  signInButton.hidden = authenticated;
  signOutButton.hidden = !authenticated;
  if (!authenticated) {
    disableButton.disabled = true;
    testButton.disabled = true;
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6500);
}

async function checkWorkerMessaging(registration) {
  const worker = registration.active;
  if (!worker) throw new Error('The website service worker is not active yet. Reload the page and retry.');
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('The notification service worker did not respond. Reload the website and retry.')), 3500);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(Boolean(event.data?.ready));
    };
    worker.postMessage({ type: 'YJ_CHECK_MESSAGING' }, [channel.port2]);
  });
}

async function getMessagingRuntime() {
  if (!window.isSecureContext) throw new Error('Notifications require the published HTTPS website (or localhost for development).');
  if (!fcmVapidKey || fcmVapidKey.length < 80) {
    throw new Error('Add the Firebase Web Push public VAPID key to firebase-public-config.js first.');
  }
  if (!messagingApi) messagingApi = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging.js');
  if (!await messagingApi.isSupported()) {
    throw new Error('Firebase Messaging is not supported by this browser environment. On iPhone or iPad, use an iOS/iPadOS 16.4+ Home Screen app; if it still fails, this Firebase SDK/browser combination is unsupported.');
  }
  const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
  await navigator.serviceWorker.ready;
  if (!await checkWorkerMessaging(registration)) {
    throw new Error('Background messaging did not initialize. Check access to Firebase SDK files and reload the website.');
  }
  if (!messaging) messaging = messagingApi.getMessaging(app);
  if (!messageUnsubscribe) {
    messageUnsubscribe = messagingApi.onMessage(messaging, (payload) => {
      const message = payload?.data || {};
      showToast(`${message.title || 'YJ Studios'} — ${message.body || 'New notification received.'}`);
    });
  }
  if (!registeredUnsubscribe) {
    registeredUnsubscribe = messagingApi.onRegistered(messaging, async (fid) => {
      const user = currentUser;
      if (!user || !hasExplicitOptIn(user.uid)) return;
      const uid = user.uid;
      const id = fid;
      const previousFid = getLocal(fidKey(uid));
      currentFids.set(uid, fid);
      const write = (async () => {
        await registerDeviceCall({
          deviceId: id,
          previousDeviceId: previousFid && previousFid !== fid ? previousFid : '',
          fid,
          platform: platformName(),
          deviceLabel: `${platformName()} browser`
        });
        if (currentUser?.uid !== uid || !hasExplicitOptIn(uid)) {
          await removeDeviceCall({ deviceId: id });
          if (getLocal(fidKey(uid)) === fid) removeLocal(fidKey(uid));
          currentFids.delete(uid);
          registrationWaiters.get(uid)?.resolve(false);
          registrationWaiters.delete(uid);
          return;
        }
        enabledUsers.add(uid);
        setLocal(fidKey(uid), fid);
        setLocal(enabledKey(uid), 'true');
        registeredForCurrentDevice = true;
        updateView();
        registrationWaiters.get(uid)?.resolve(true);
        registrationWaiters.delete(uid);
      })();
      registrationWrites.set(uid, write);
      try { await write; }
      catch (error) {
        registrationWaiters.get(uid)?.reject(error);
        registrationWaiters.delete(uid);
        if (dialog.open) setStatus(friendlyMessagingError(error), true);
      } finally {
        if (registrationWrites.get(uid) === write) registrationWrites.delete(uid);
      }
    });
  }
  if (!unregisteredUnsubscribe) {
    unregisteredUnsubscribe = messagingApi.onUnregistered(messaging, (fid) => {
      const user = currentUser;
      if (!user || !fid) return;
      if (currentFids.get(user.uid) === fid) {
        currentFids.delete(user.uid);
        registeredForCurrentDevice = false;
        updateView();
      }
      removeDeviceCall({ deviceId: fid }).then(() => {
        if (getLocal(fidKey(user.uid)) === fid) removeLocal(fidKey(user.uid));
      }).catch(() => {});
    });
  }
  return { registration };
}

function platformName() {
  if (isIosDevice()) return 'ios';
  const agent = navigator.userAgent || '';
  if (/Android/i.test(agent)) return 'android';
  if (/Windows|Macintosh|Linux|X11/i.test(agent)) return 'desktop';
  return 'unknown';
}

async function registerGrantedDevice({ quiet = false } = {}) {
  if (!currentUser) throw new Error('Sign in with a verified Firebase account first.');
  if (!isNotificationApiAvailable()) throw new Error('This browser does not support Web Push notifications.');
  if (Notification.permission !== 'granted') throw new Error('Allow notifications in this browser before registering this device.');
  const uid = currentUser.uid;
  if (!hasExplicitOptIn(uid)) return false;
  if (registrationInFlight.has(uid)) return registrationInFlight.get(uid);

  const registration = (async () => {
    const { registration } = await getMessagingRuntime();
    if (!currentUser || currentUser.uid !== uid || !hasExplicitOptIn(uid)) return false;
    const registrationResult = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        registrationWaiters.delete(uid);
        reject(new Error('Firebase did not return an installation registration. Check the Web Push certificate and try again.'));
      }, 12000);
      registrationWaiters.set(uid, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
    try {
      await messagingApi.register(messaging, { vapidKey: fcmVapidKey, serviceWorkerRegistration: registration });
      if (!await registrationResult) return false;
      if (!quiet) setStatus('This browser is subscribed. You can send a test notification now.');
      return true;
    } catch (error) {
      registrationWaiters.delete(uid);
      throw error;
    }
  })();
  registrationInFlight.set(uid, registration);
  try { return await registration; }
  finally { if (registrationInFlight.get(uid) === registration) registrationInFlight.delete(uid); }
}

async function enableNotifications() {
  if (!currentUser) { setStatus('Sign in with a verified Firebase account first.', true); return; }
  if (!fcmVapidKey || fcmVapidKey.length < 80) {
    setStatus('Add the Firebase Web Push public VAPID key to firebase-public-config.js, then deploy the site.', true);
    return;
  }
  if (!isNotificationApiAvailable()) {
    updateView();
    setStatus(isIosDevice() && !isInstalledWebApp()
      ? 'On iPhone or iPad: open this site in Safari, choose Share → Add to Home Screen, then open the installed app. Requires iOS/iPadOS 16.4 or newer.'
      : 'This browser does not support the required Web Push APIs.', true);
    return;
  }

  try {
    // Call requestPermission directly from the button gesture, only for default.
    if (Notification.permission === 'denied') {
      setStatus('Permission is blocked. Enable notifications for this site in browser or device settings, then return here.', true);
      return;
    }
    if (Notification.permission === 'default') {
      const result = await Notification.requestPermission();
      if (result !== 'granted') {
        updateView();
        setStatus(result === 'denied'
          ? 'Notifications were blocked. Enable them in browser or device settings; the site cannot prompt again.'
          : 'Permission was not granted. You can enable it later from browser settings.', true);
        return;
      }
    }
    enabledUsers.add(currentUser.uid);
    setLocal(enabledKey(currentUser.uid), 'true');
    setStatus('Registering this browser with Firebase…');
    await registerGrantedDevice();
  } catch (error) {
    registeredForCurrentDevice = false;
    updateView();
    setStatus(friendlyMessagingError(error), true);
  }
}

async function disableNotifications({ signingOut = false } = {}) {
  const user = currentUser || auth.currentUser;
  if (!user) return;
  enabledUsers.delete(user.uid);
  setLocal(enabledKey(user.uid), 'false');
  const waiter = registrationWaiters.get(user.uid);
  if (waiter) {
    waiter.reject(Object.assign(new Error('Registration stopped because notifications were disabled.'), { code: 'notifications/canceled' }));
    registrationWaiters.delete(user.uid);
  }
  try { await registrationInFlight.get(user.uid); } catch { /* Let the in-flight registration settle before removing its record. */ }
  try { await registrationWrites.get(user.uid); } catch { /* Remove the record even if its refresh update failed. */ }
  const id = fidFor(user.uid);
  let backendError = null;
  if (id) {
    try { await removeDeviceCall({ deviceId: id }); }
    catch (error) { backendError = error; }
    if (!backendError && getLocal(fidKey(user.uid)) === id) removeLocal(fidKey(user.uid));
  }
  try {
    if (messagingApi && messaging) await messagingApi.unregister(messaging);
  } catch (error) {
    if (!backendError) backendError = error;
  }
  registeredForCurrentDevice = false;
  currentFids.delete(user.uid);
  updateView();
  if (backendError) {
    const message = `${friendlyMessagingError(backendError)} The local browser token was removed where possible; a stale server record will be pruned after a send attempt.`;
    if (!signingOut) setStatus(message, true);
    throw backendError;
  }
  if (!signingOut) setStatus('Notifications are disabled on this browser. Other devices remain subscribed.');
}

export async function unregisterCurrentDevice() {
  if (!auth.currentUser) return;
  try { await disableNotifications({ signingOut: true }); }
  catch { /* Signing out must remain possible if a cleanup request cannot reach Firebase. */ }
}

window.YJNotifications = { unregisterCurrentDevice };

async function sendTest() {
  testButton.disabled = true;
  setStatus('Sending a test to the registered devices on this account…');
  try {
    const result = (await sendTestCall({})).data;
    if (!result?.sent) throw new Error('Firebase did not confirm delivery to any registered browser. Re-enable notifications on the target device.');
    setStatus(`Firebase accepted the test for ${result.sent} device${result.sent === 1 ? '' : 's'}${result.removed ? `; removed ${result.removed} expired registration${result.removed === 1 ? '' : 's'}` : ''}. Delivery timing depends on browser and device settings.`);
  } catch (error) {
    setStatus(friendlyMessagingError(error), true);
  } finally {
    updateView();
  }
}

async function signOutFromSettings() {
  try { await disableNotifications({ signingOut: true }); }
  catch { /* Auth sign-out must continue even if remote cleanup is offline. */ }
  try {
    if (!firebaseSignOut) throw new Error('Firebase Authentication could not load. Reload this page and try again.');
    await firebaseSignOut(auth);
    dialog.close();
  } catch (error) {
    setStatus(friendlyMessagingError(error), true);
  }
}

byId('notification-settings-open').addEventListener('click', () => {
  updateView();
  setStatus('');
  dialog.showModal();
});
byId('notification-settings-close').addEventListener('click', () => dialog.close());
enableButton.addEventListener('click', enableNotifications);
disableButton.addEventListener('click', () => disableNotifications().catch(() => {}));
testButton.addEventListener('click', sendTest);
signOutButton.addEventListener('click', signOutFromSettings);
signInButton.addEventListener('click', () => window.dispatchEvent(new Event('yj:open-owner-sign-in')));

if (onAuthStateChanged) {
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    registeredForCurrentDevice = false;
    updateView();
    if (user && isNotificationApiAvailable() && Notification.permission === 'granted' && hasExplicitOptIn(user.uid)) {
      registerGrantedDevice({ quiet: true }).catch((error) => {
        registeredForCurrentDevice = false;
        updateView();
        if (dialog.open) setStatus(friendlyMessagingError(error), true);
      });
    }
  });
} else {
  setStatus('Firebase notification libraries could not load. Check the connection and reload this page.', true);
}

window.addEventListener('focus', () => {
  if (currentUser && isNotificationApiAvailable() && Notification.permission === 'granted' && hasExplicitOptIn(currentUser.uid)) {
    registerGrantedDevice({ quiet: true }).catch(() => {});
  }
});
