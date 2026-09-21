// Service worker: lets the site open with no signal (e.g. out on the water) by
// falling back to the last copy of each file it fetched.
//
// Strategy: NETWORK FIRST for everything, so a deploy is always picked up
// immediately and stale code is never served while online; the cache is only
// used when the network fails. Only same-origin files and the pinned CDN
// libraries (Leaflet, Chart.js) are cached. The Worker API (logins, marks,
// live config) and map tiles are never cached here.
const CACHE = "fishing-v1";
const CDN_HOSTS = ["unpkg.com", "cdnjs.cloudflare.com"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CDN_HOSTS.includes(url.hostname)) return; // API, tiles, etc.: leave to the browser

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // Key on the plain path: the site adds a changing ?_=timestamp to data
      // fetches to bypass caches, and keying on that would fill the cache with
      // a new copy of the 4 MB data file on every load.
      const key = sameOrigin ? url.origin + url.pathname : req.url;
      try {
        // "no-cache" = always ask the server whether the file changed (a cheap 304 when it hasn't). Without it the
        // browser's own HTTP cache can hand back a file GitHub Pages marked max-age=600, so a fresh deploy would
        // not reach an installed app for up to 10 minutes. Same-origin only; the pinned CDN libraries can cache.
        const fresh = await fetch(req, sameOrigin ? { cache: "no-cache" } : undefined);
        if (fresh && fresh.ok) cache.put(key, fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await cache.match(key);
        if (cached) return cached;
        throw err;
      }
    })()
  );
});
