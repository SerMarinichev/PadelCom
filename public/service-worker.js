// PadelCom service worker — caches the app shell for offline resilience,
// but NEVER caches /api/* calls (data must always be fresh).
//
// IMPORTANT: JS and HTML use a network-first strategy. The app's code changes
// often during active development, and a stale cached bundle.js can silently
// keep serving an old, buggy version of the app indefinitely — that's exactly
// what happened before this fix. Network-first means the cache is only ever
// a fallback for when there's genuinely no connection, never the default.
const CACHE_NAME = "padelcom-shell-v2";
const SHELL_FILES = ["/", "/index.html", "/manifest.json", "/icon-192.png", "/icon-512.png"];

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

function putInCache(request, response) {
  // Clone immediately, synchronously, before the response body is read anywhere
  // else — cloning after the fact is what caused "Response body is already used".
  const copy = response.clone();
  caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith("/api/")) return; // always network, never cached
  if (event.request.method !== "GET") return;

  const isCodeOrHtml = event.request.mode === "navigate" || url.pathname.endsWith(".js") || url.pathname.endsWith(".html") || url.pathname === "/";

  if (isCodeOrHtml) {
    // Network-first: always prefer the live version; cache is only an offline fallback.
    event.respondWith(
      fetch(event.request)
        .then((res) => { if (res && res.ok) putInCache(event.request, res); return res; })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Static assets (icons etc.) rarely change — cache-first is fine and faster.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => { if (res && res.ok) putInCache(event.request, res); return res; });
    })
  );
});
