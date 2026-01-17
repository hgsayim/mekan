// Service Worker for MekanApp
const CACHE_NAME = 'mekanapp-v24';

// Get base URL from service worker location
const BASE_URL = self.location.href.replace(/\/service-worker\.js$/, '/');

const urlsToCache = [
  BASE_URL,
  BASE_URL + 'index.html',
  BASE_URL + 'styles.css',
  BASE_URL + 'icon.svg',
  BASE_URL + 'env.js',
  BASE_URL + 'app.js',
  BASE_URL + 'database.js',
  BASE_URL + 'hybrid-db.js',
  BASE_URL + 'supabase-config.js',
  BASE_URL + 'supabase-db.js',
  BASE_URL + 'manifest.json',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
];

// Install event - cache files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
      .catch((error) => {
        console.log('Cache installation failed:', error);
        // Continue even if cache fails
        return Promise.resolve();
      })
  );
  // Force the waiting service worker to become the active service worker
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  // Claim clients immediately
  return self.clients.claim();
});

// Fetch event
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Skip chrome-extension and other protocols
  if (!event.request.url.startsWith('http')) {
    return;
  }

  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isAppAsset =
    isSameOrigin &&
    (
      url.pathname.endsWith('/') ||
      url.pathname.endsWith('/index.html') ||
      url.pathname.endsWith('/app.js') ||
      url.pathname.endsWith('/hybrid-db.js') ||
      url.pathname.endsWith('/database.js') ||
      url.pathname.endsWith('/supabase-db.js') ||
      url.pathname.endsWith('/supabase-config.js') ||
      url.pathname.endsWith('/styles.css') ||
      url.pathname.endsWith('/manifest.json') ||
      url.pathname.endsWith('/env.js') ||
      url.pathname.endsWith('/icon.svg')
    );

  // Network-first for app shell/assets so all devices converge to the same code quickly.
  if (isAppAsset || event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request)
        .then((netRes) => {
          const resClone = netRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone)).catch(() => {});
          return netRes;
        })
        .catch(() => {
          return caches.match(event.request).then((cached) => {
            return cached || caches.match(BASE_URL + 'index.html');
          });
        })
    );
    return;
  }

  // Cache-first for everything else (images/CDN/etc)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request)
          .then((netRes) => {
            const resClone = netRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone)).catch(() => {});
            return netRes;
          })
          .catch(() => cached)
      );
    })
  );
});