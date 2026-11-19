// Service worker: la app se abre al instante y funciona sin conexión.
// Estrategia: se responde con la copia guardada y, a la vez, se descarga la
// versión nueva en segundo plano. Si algo ha cambiado, se avisa a la app
// para que ofrezca recargar.
const CACHE = 'planning-semanal-v3';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'store.js',
  'sync.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const versionOf = (res) => res.headers.get('ETag') || res.headers.get('Last-Modified') || '';

async function notifyUpdate() {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) client.postMessage({ type: 'update-available' });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Solo archivos propios de la app; las llamadas a GitHub pasan directas.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });

    const refresh = fetch(req.url, { cache: 'no-cache' }).then(async (res) => {
      if (!res.ok) return res;
      const before = cached ? versionOf(cached) : '';
      const after = versionOf(res);
      await cache.put(req, res.clone());
      if (before && after && before !== after) notifyUpdate();
      return res;
    });

    if (cached) {
      event.waitUntil(refresh.catch(() => {}));
      return cached;
    }
    return refresh.catch(() => cache.match('index.html'));
  })());
});
