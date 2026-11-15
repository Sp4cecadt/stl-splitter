# Regenerates sw.js with the full offline file list + a content hash version.
import os, hashlib
root = os.path.dirname(os.path.abspath(__file__))
files = ['./', 'index.html', 'styles.css', 'manifest.json']
for d in ['js', 'vendor', 'icons']:
    for dp, _, fs in os.walk(os.path.join(root, d)):
        for f in sorted(fs):
            if f.endswith(('.js', '.wasm', '.png', '.json')):
                files.append(os.path.relpath(os.path.join(dp, f), root))
h = hashlib.sha1()
for f in files[1:]:
    h.update(open(os.path.join(root, f), 'rb').read())
ver = h.hexdigest()[:10]
sw = f"""// Service worker: cache-first, everything precached for offline use.
const CACHE = 'stl-splitter-{ver}';
const FILES = {files!r};
self.addEventListener('install', (e) => {{ e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); }});
self.addEventListener('activate', (e) => {{ e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); }});
self.addEventListener('fetch', (e) => {{
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, {{ ignoreSearch: true }}).then((r) => r || fetch(e.request).then((resp) => {{
    if (resp.ok && new URL(e.request.url).origin === location.origin) {{ const cp = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); }}
    return resp;
  }}).catch(() => caches.match('index.html'))));
}});
"""
open(os.path.join(root, 'sw.js'), 'w').write(sw)
print(ver, len(files), 'files')
