// Service worker: cache-first, everything precached for offline use.
const CACHE = 'stl-splitter-d7a0695796';
const FILES = ['./', 'index.html', 'styles.css', 'manifest.json', 'js/app.js', 'js/db.js', 'js/estimate.js', 'js/export.js', 'js/geom.js', 'js/loaders.js', 'js/pack.js', 'js/viewer.js', 'vendor/three/three.core.js', 'vendor/three/three.module.js', 'vendor/three/addons/controls/OrbitControls.js', 'vendor/three/addons/controls/TransformControls.js', 'vendor/three/addons/loaders/OBJLoader.js', 'vendor/three/addons/loaders/STLLoader.js', 'vendor/three/addons/libs/fflate.module.js', 'vendor/manifold/manifold.js', 'vendor/manifold/manifold.wasm', 'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request).then((resp) => {
    if (resp.ok && new URL(e.request.url).origin === location.origin) { const cp = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); }
    return resp;
  }).catch(() => caches.match('index.html'))));
});
