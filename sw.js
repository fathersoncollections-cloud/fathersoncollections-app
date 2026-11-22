/* FatherSon Collections phone app v4. The app files come from this site and are cached for offline use.
   Collection data comes live from the Apps Script API; the app keeps its own last copy in IndexedDB (not here). */
const CACHE = 'fatherson-app-v7l-20261122';
const SHELL = ["./", "./index.html", "./app.js?v7l-20261122", "./manifest.json", "./lib/zxing.min.js?v4", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png", "./assets/family.jpg", "./assets/LuckiestGuy-Regular.ttf", "./assets/simpsons/bart-head.webp", "./assets/simpsons/bart-wave.webp", "./assets/simpsons/burns.webp", "./assets/simpsons/donut.webp", "./assets/simpsons/family.webp", "./assets/simpsons/helper.webp", "./assets/simpsons/homer-donut.webp", "./assets/simpsons/homer-peek.webp", "./assets/simpsons/homer-wave.webp", "./assets/simpsons/kwikemart.webp", "./assets/simpsons/lisa.webp", "./assets/simpsons/maggie.webp", "./assets/simpsons/marge.webp", "./assets/simpsons/sky.webp", "./assets/simpsons/springfield.webp", "./assets/standins/FS-0066.webp", "./assets/standins/FS-0098.webp", "./assets/standins/FS-0124.webp", "./assets/standins/FS-0276.webp", "./assets/standins/FS-0304.webp", "./assets/standins/FS-0312.webp", "./assets/standins/FS-0412.webp", "./assets/standins/FS-0415.webp", "./assets/standins/FS-0417.webp", "./assets/standins/FS-0418.webp", "./assets/standins/FS-0423.webp", "./assets/standins/FS-0424.webp"];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.indexOf('fatherson-') === 0 && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates show straight away), cached copy only when offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match(req, { ignoreSearch: true })).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./') : undefined)))
  );
});
