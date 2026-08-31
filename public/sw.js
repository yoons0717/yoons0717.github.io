// Self-destroying service worker.
// The previous Jekyll/Chirpy site registered a PWA service worker that cached
// the whole site. This replaces it: on activation it wipes every cache,
// unregisters itself, and reloads open tabs so visitors get the current site.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			try {
				const keys = await caches.keys();
				await Promise.all(keys.map((key) => caches.delete(key)));
				await self.registration.unregister();
				const clients = await self.clients.matchAll({ type: 'window' });
				for (const client of clients) client.navigate(client.url);
			} catch (e) {
				// ignore
			}
		})(),
	);
});
