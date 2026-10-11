const CACHE_NAME = 'yj-studios-shell-v26';
const BASE_URL = new URL('./', self.registration.scope);
const APP_URL = new URL('index.html', BASE_URL).href;
const SHELL_FILES = [
  './',
  './index.html',
  './auth.html',
  './account.html',
  './dashboard.html',
  './auth-flow.mjs',
  './firebase-config.js',
  './firebase-client.js',
  './site-cloud.js',
  './site.webmanifest',
  './dashboard.webmanifest',
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
