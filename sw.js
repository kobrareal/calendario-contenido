// Service worker: es lo que permite instalar el calendario como app y que se actualice solo.
//
// Estrategia deliberada:
//  - La página y los datos van SIEMPRE a la red primero. Un calendario que muestra el mes de
//    la semana pasada porque quedó cacheado es peor que uno que no abre.
//  - El cache es la red de emergencia: si no hay señal, se sirve la última versión vista.
//  - Los pedidos a /api/ nunca se guardan: llevan el token del link y datos de la marca.

const CACHE = 'calendario-v1';
const ESENCIALES = ['./', './index.html', './manifest.json', './icono.svg'];

self.addEventListener('install', (e) => {
  // skipWaiting: la versión nueva toma el control sin esperar a que se cierren las pestañas.
  // Sin esto, una publicación mía podía tardar días en llegarle a alguien que nunca cierra la app.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ESENCIALES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(nombres => Promise.all(nombres.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // fuentes e iconos externos: sin tocar
  if (url.pathname.startsWith('/api/')) return;          // datos y token: nunca al cache

  e.respondWith(
    fetch(req)
      .then(res => {
        // Se guarda una copia para poder abrir sin conexión más tarde.
        const copia = res.clone();
        caches.open(CACHE).then(c => c.put(req, copia)).catch(() => {});
        return res;
      })
      .catch(async () => {
        const guardado = await caches.match(req);
        if (guardado) return guardado;
        // Navegación sin red y sin copia: al menos la portada.
        if (req.mode === 'navigate') return caches.match('./index.html');
        throw new Error('sin conexión y sin copia guardada');
      })
  );
});
