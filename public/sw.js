/* Karibu Kwenu – service worker minimal.
   Toujours la version la plus récente du site quand le réseau marche ;
   la page d'accueil en secours si le téléphone est hors connexion.
   Les appels /api/ (commandes, paiements, connexion) ne sont JAMAIS mis en cache. */
const V = 'kk-v1';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.add(new Request('/', { cache: 'reload' }))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  if (r.mode === 'navigate') {
    e.respondWith(
      fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put('/', cp)); } return res; })
        .catch(() => caches.match('/'))
    );
  }
});
