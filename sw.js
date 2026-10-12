const CACHE_NAME = 'yj-studios-shell-v33';
const BASE_URL = new URL('./', self.registration.scope);
const APP_URL = new URL('index.html', BASE_URL).href;
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
  './auth-flow.mjs',
  './firebase-config.js',
  './firebase-public-config.js',
  './firebase-client.js',
  './media-storage.js',
  './r2-uploader.js',
  './site-cloud.js',
  './studio-projects.js',
  './notifications.js',
  './notification-policy.mjs',
  './site.webmanifest',
  './yj-studios-logo.jpg',
  './icons/yj-icon-192.png',
  './icons/yj-icon-512.png',
  './icons/apple-touch-icon.png'
].map((path) => new URL(path, BASE_URL).href);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('yj-studios-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
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
  if (requestUrl.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match(APP_URL)) || Response.error())
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        return response;
      });
    })
  );
});




