/* FatherSon Collections phone app v4. The app files come from this site and are cached for offline use.
   Collection data comes live from the Apps Script API; the app keeps its own last copy in IndexedDB (not here). */
const CACHE = 'fatherson-app-v7n-20261122';
const SHELL = ["./", "./index.html", "./app.js?v7n-20261122", "./manifest.json", "./lib/zxing.min.js?v4", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png", "./assets/family.jpg", "./assets/LuckiestGuy-Regular.ttf", "./assets/simpsons/bart-head.webp", "./assets/simpsons/bart-wave.webp", "./assets/simpsons/burns.webp", "./assets/simpsons/donut.webp", "./assets/simpsons/family.webp", "./assets/simpsons/helper.webp", "./assets/simpsons/homer-donut.webp", "./assets/simpsons/homer-peek.webp", "./assets/simpsons/homer-wave.webp", "./assets/simpsons/kwikemart.webp", "./assets/simpsons/lisa.webp", "./assets/simpsons/maggie.webp", "./assets/simpsons/marge.webp", "./assets/simpsons/sky.webp", "./assets/simpsons/springfield.webp", "./assets/standins/FS-0066.webp", "./assets/standins/FS-0098.webp", "./assets/standins/FS-0124.webp", "./assets/standins/FS-0276.webp", "./assets/standins/FS-0304.webp", "./assets/standins/FS-0312.webp", "./assets/standins/FS-0412.webp", "./assets/standins/FS-0415.webp", "./assets/standins/FS-0417.webp", "./assets/standins/FS-0418.webp", "./assets/standins/FS-0423.webp", "./assets/standins/FS-0424.webp", "./assets/refs/_placeholder.webp", "./assets/refs/jakks-pacific__2-5in-playset__simpsons-living-room-diorama-with-homer.webp", "./assets/refs/jakks-pacific__2-5in-wave-1__bart.webp", "./assets/refs/jakks-pacific__2-5in-wave-1__homer.webp", "./assets/refs/jakks-pacific__2-5in-wave-1__lisa.webp", "./assets/refs/jakks-pacific__2-5in-wave-2__itchy.webp", "./assets/refs/jakks-pacific__2-5in-wave-2__scratchy.webp", "./assets/refs/jakks-pacific__2-5in-wave-3__grampa.webp", "./assets/refs/jakks-pacific__2-5in-wave-3__milhouse.webp", "./assets/refs/jakks-pacific__2-5in-wave-3__ralph.webp", "./assets/refs/jakks-pacific__2-5in-wave-4__principal-skinner.webp", "./assets/refs/jakks-pacific__2-5in-wave-4__selma-bouvier.webp", "./assets/refs/jakks-pacific__5in-premium-treehouse-of-horror__fly-boy-bart.webp", "./assets/refs/jakks-pacific__5in-premium-treehouse-of-horror__grim-reaper-homer.webp", "./assets/refs/jakks-pacific__5in-premium-treehouse-of-horror__king-homer.webp", "./assets/refs/jakks-pacific__5in-premium-treehouse-of-horror__vampire-krusty.webp", "./assets/refs/jakks-pacific__5in-premium-treehouse-of-horror__werewolf-ned-flanders.webp", "./assets/refs/jakks-pacific__5in-premium__fat-tony.webp", "./assets/refs/jakks-pacific__5in-premium__king-size-homer.webp", "./assets/refs/jakks-pacific__5in-premium__the-chosen-one-homer.webp", "./assets/refs/jakks-pacific__5in-wave-3__homer-at-the-bat.webp", "./assets/refs/jakks-pacific__5in-wave-3__marge-with-maggie.webp", "./assets/refs/jakks-pacific__5in-wave-3__milhouse-with-bicycle.webp", "./assets/refs/jakks-pacific__5in-wave-4__bart-with-skateboard-blue-shirt.webp", "./assets/refs/jakks-pacific__5in-wave-5__bart-hockey.webp", "./assets/refs/jakks-pacific__5in-wave-5__troy-mcclure.webp", "./assets/refs/lego__41632__brickheadz-homer-simpson-krusty-the-clown.webp", "./assets/refs/lego__71016__kwik-e-mart.webp", "./assets/refs/lego__71202__lego-dimensions-level-pack-the-simpsons-homer.webp", "./assets/refs/lego__71211__lego-dimensions-fun-pack-bart.webp", "./assets/refs/lego__71227__lego-dimensions-fun-pack-krusty.webp"];

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
