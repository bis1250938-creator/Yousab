const CACHE_NAME = 'yj-studios-shell-v42';
const BASE_URL = new URL('./', self.registration.scope);
const APP_URL = new URL('index.html', BASE_URL).href;
const OFFLINE_URL = new URL('offline.html', BASE_URL).href;
const APP_ROOT_PATH = new URL('./', BASE_URL).pathname;
const APP_INDEX_PATH = new URL('index.html', BASE_URL).pathname;
let firebaseMessagingReady = false;

// Messaging runs inside this existing root-scoped worker so the site keeps one
// service-worker registration and its current offline behavior.
try {
  importScripts('./firebase-public-config.js');
  importScripts(
    'https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js'
  );
  if (!firebase.apps.length) firebase.initializeApp(self.YJ_FIREBASE_CONFIG);
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const data = payload?.data || {};
    const title = String(data.title || 'YJ Studios').slice(0, 100);
    const body = String(data.body || 'There is an update from YJ Studios.').slice(0, 240);
    const requestedUrl = new URL(data.url || APP_URL, self.location.origin);
    const url = requestedUrl.origin === self.location.origin ? requestedUrl.href : APP_URL;
    return self.registration.showNotification(title, {
      body,
      icon: new URL('icons/yj-icon-192.png', BASE_URL).href,
      badge: new URL('icons/yj-icon-192.png', BASE_URL).href,
      tag: String(data.eventId || 'yj-studios-notification').slice(0, 100),
      renotify: false,
      data: { url }
    });
  });
  firebaseMessagingReady = true;
} catch (error) {
  // Preserve the offline shell even when the Firebase CDN is temporarily down.
  console.warn('YJ Studios background messaging could not initialize.', error);
}

const SHELL_FILES = [
  './',
  './index.html',
  './offline.html',
  './site.webmanifest',
  './fonts/dm-sans-latin.woff2',
  './fonts/manrope-latin.woff2',
  './yj-studios-logo-190.webp',
  './yj-studios-logo-380.webp',
  './icons/yj-icon-192.png',
  './icons/yj-icon-512.png',
  './icons/apple-touch-icon.png'
].map((path) => new URL(path, BASE_URL).href);
const LAZY_FILES = [
  './auth-flow.mjs',
  './offline-policy.mjs',
  './offline-recovery.mjs',
  './offline-replay.mjs',
  './project-upload-policy.mjs',
  './project-upload-flow.mjs',
  './offline-sync.mjs',
  './firebase-config.js',
  './firebase-public-config.js',
  './firebase-client.js',
  './auth-session.mjs',
  './media-storage.js',
  './r2-uploader.js',
  './site-cloud.js',
  './studio-projects.js',
  './notifications.js',
  './notification-policy.mjs'
].map((path) => new URL(path, BASE_URL).href);
const CACHEABLE_FILES = [...SHELL_FILES, ...LAZY_FILES];
const CACHEABLE_ASSET_PATHS = new Set(CACHEABLE_FILES.map((url) => new URL(url).pathname));
const LOGO_ASSETS = [
  './yj-studios-logo.jpg',
  './yj-studios-logo-64.webp',
  './yj-studios-logo-80.webp',
  './yj-studios-logo-190.webp',
  './yj-studios-logo-288.webp',
  './yj-studios-logo-336.webp',
  './yj-studios-logo-380.webp',
  './yj-studios-logo-64.jpg',
  './yj-studios-logo-80.jpg',
  './yj-studios-logo-190.jpg',
  './yj-studios-logo-288.jpg',
  './yj-studios-logo-336.jpg',
  './yj-studios-logo-380.jpg'
].map((path) => new URL(path, BASE_URL).href);
const LOGO_ASSET_PATHS = new Set(LOGO_ASSETS.map((url) => new URL(url).pathname));
const FIREBASE_VERSION = '12.19.0';
const FIREBASE_MODULES = [
  'firebase-app.js',
  'firebase-auth.js',
  'firebase-firestore.js'
].map((file) => `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/${file}`);
const FIREBASE_MODULE_PATHS = new Set(FIREBASE_MODULES.map((url) => new URL(url).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        await cache.addAll(SHELL_FILES);
        // Firebase ES modules are cached on first real use by the fetch handler
        // below; do not fetch Auth and Firestore just to install the app shell.
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const previousCaches = (await caches.keys()).filter((key) => key.startsWith('yj-studios-shell-') && key !== CACHE_NAME);
      const currentCache = await caches.open(CACHE_NAME);
      for (const previousName of previousCaches) {
        const previousCache = await caches.open(previousName);
        for (const request of await previousCache.keys()) {
          if (await currentCache.match(request)) continue;
          const response = await previousCache.match(request);
          if (response) await currentCache.put(request, response);
        }
        await caches.delete(previousName);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'YJ_CHECK_MESSAGING') {
    event.ports?.[0]?.postMessage({ ready: firebaseMessagingReady });
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const requestedUrl = new URL(event.notification.data?.url || APP_URL, self.location.origin);
  const targetUrl = requestedUrl.origin === self.location.origin ? requestedUrl.href : APP_URL;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.navigate(targetUrl);
        return client.focus();
      }
    }
    return self.clients.openWindow(targetUrl);
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);

  if (requestUrl.origin === 'https://www.gstatic.com'
    && request.mode !== 'no-cors'
    && FIREBASE_MODULE_PATHS.has(requestUrl.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type !== 'opaque') await cache.put(request, response.clone());
      return response;
    })());
    return;
  }

  if (requestUrl.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if ((requestUrl.pathname === APP_ROOT_PATH || requestUrl.pathname === APP_INDEX_PATH)
            && response.ok && response.headers.get('content-type')?.includes('text/html')) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(APP_URL, response.clone());
          }
          return response;
        } catch {
          if (requestUrl.pathname === APP_ROOT_PATH || requestUrl.pathname === APP_INDEX_PATH) {
            return (await caches.match(request, { ignoreSearch: true })) || (await caches.match(APP_URL)) || Response.error();
          }
          return (await caches.match(OFFLINE_URL)) || Response.error();
        }
      })()
    );
    return;
  }

  const logoUrl = LOGO_ASSETS.find((url) => new URL(url).pathname === requestUrl.pathname);
  if (logoUrl && LOGO_ASSET_PATHS.has(requestUrl.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(logoUrl);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(logoUrl, response.clone());
      return response;
    })());
    return;
  }

  // Cache only the reviewed, same-origin app shell allowlist. Firebase data,
  // authentication responses, API calls, and media are intentionally never
  // stored by this worker.
  const cachedAssetUrl = CACHEABLE_FILES.find((url) => new URL(url).pathname === requestUrl.pathname);
  if (!cachedAssetUrl || !CACHEABLE_ASSET_PATHS.has(requestUrl.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(cachedAssetUrl);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(cachedAssetUrl, response.clone());
    return response;
  })());
});




