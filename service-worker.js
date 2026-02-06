// Service Worker for MekanApp
const CACHE_NAME = 'mekanapp-v40';
const STATIC_CACHE = 'mekanapp-static-v40';
const API_CACHE = 'mekanapp-api-v40';

// Get base URL from service worker location
const BASE_URL = self.location.href.replace(/\/service-worker\.js$/, '/');

// Tek bir URL hata verse bile diğerleri cache'lensin (addAll yerine teker teker)
const staticUrlsToCache = [
  BASE_URL,
  BASE_URL + 'index.html',
  BASE_URL + 'styles.css',
  BASE_URL + 'icon.svg',
  BASE_URL + 'icon-192.png',
  BASE_URL + 'icon-512.png',
  BASE_URL + 'env.js',
  BASE_URL + 'app.js',
  BASE_URL + 'database.js',
  BASE_URL + 'hybrid-db.js',
  BASE_URL + 'supabase-config.js',
  BASE_URL + 'supabase-db.js',
  BASE_URL + 'manifest.json',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
];

// Install event - cache static files
self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(STATIC_CACHE).then((cache) => {
        console.log('Caching static files');
        return Promise.all(
          staticUrlsToCache.map((url) => cache.add(url).catch(() => {}))
        );
      }),
      caches.open(API_CACHE).then((cache) => {
        console.log('API cache ready');
        return Promise.resolve();
      })
    ])
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
          if (cacheName !== CACHE_NAME && cacheName !== STATIC_CACHE && cacheName !== API_CACHE) {
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

// Cache strategy helper
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    if (request.destination === 'document') {
      return cache.match(BASE_URL + 'index.html');
    }
    throw error;
  }
}

// Network first with cache fallback for API calls
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

// Fetch event - smart caching strategy
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

  // Static files: Cache First strategy
  if (url.origin === location.origin && 
      (url.pathname.endsWith('.js') || 
       url.pathname.endsWith('.css') || 
       url.pathname.endsWith('.html') ||
       url.pathname.endsWith('.svg') ||
       url.pathname.endsWith('.png') ||
       url.pathname.endsWith('.json'))) {
    event.respondWith(cacheFirst(event.request, STATIC_CACHE));
    return;
  }

  // Supabase API calls: Network First strategy (with cache fallback for offline)
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase')) {
    event.respondWith(networkFirst(event.request, API_CACHE));
    return;
  }

  // External CDN (Chart.js): Cache First
  if (url.hostname.includes('cdn.jsdelivr.net') || url.hostname.includes('cdn')) {
    event.respondWith(cacheFirst(event.request, STATIC_CACHE));
    return;
  }

  // Default: Network First with cache fallback
  event.respondWith(networkFirst(event.request, API_CACHE));
});