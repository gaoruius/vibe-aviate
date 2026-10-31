/* VibeAviate service worker: makes the site work offline.
 * - Page: network first, falling back to the cached copy.
 * - Site files, data and CDN libraries: served from cache, refreshed in the background.
 * - Map tiles: cached as you view them (capped), so maps you've seen work offline. */
'use strict';

const CORE = 'vibe-core-v1';
const TILES = 'vibe-tiles-v1';
const MAX_TILES = 400;
const DATA = ['data/SB-airlines.txt', 'data/SB-airports.txt', 'data/SB-routes.txt', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE);
    const res = await fetch('./', { cache: 'no-cache' });
    const html = await res.clone().text();
    await cache.put('./', res);
    // Cache every script and stylesheet the page references, including versioned (?v=) URLs.
    const urls = new Set(DATA);
    for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      if (/\.(js|css)(\?|$)/.test(m[1])) urls.add(m[1]);
    }
    await Promise.all([...urls].map(u => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CORE && key !== TILES) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
  } else if (url.hostname === 'tile.openstreetmap.org') {
    event.respondWith(cacheFirstTile(req));
  } else if (url.origin === self.location.origin || url.hostname === 'cdnjs.cloudflare.com' ||
             url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, event));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(CORE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put('./', res.clone());
    return res;
  } catch {
    return (await cache.match('./')) || Response.error();
  }
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(CORE);
  const cached = await cache.match(req);
  const update = fetch(req).then(res => {
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  }).catch(() => cached || Response.error());
  if (cached) { event.waitUntil(update.catch(() => {})); return cached; }
  return update;
}

async function cacheFirstTile(req) {
  const cache = await caches.open(TILES);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') {
      await cache.put(req, res.clone());
      const keys = await cache.keys();
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await cache.delete(k);
    }
    return res;
  } catch {
    return Response.error();
  }
}
