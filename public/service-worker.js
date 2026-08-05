// PadelCom service worker — caches the app shell (HTML/JS/icons) for instant loads
// and offline resilience, but NEVER caches /api/* calls, since the data must
// always stay fresh and consistent with the server.
const CACHE_NAME = "padelcom-shell-v1";
const SHELL_FILES = [
  "/",
  "/index.html",
  "/bundle.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Always hit the network for API calls — data must never be served stale.
  if (url.pathname.startsWith("/api/")) return;
  if (event.request.method !== "GET") return;

  // Stale-while-revalidate for the app shell: instant response from cache,
  // silently refreshed from the network in the background.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res && res.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone()));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
