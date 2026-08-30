/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";

declare const self: ServiceWorkerGlobalScope;
const LEGACY_API_CACHE = "api-cache";

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.delete(LEGACY_API_CACHE));
});

// Article images: cache-first
registerRoute(
  ({ url }) => url.pathname.startsWith("/v1/images/"),
  new CacheFirst({
    cacheName: "article-images",
    plugins: [
      new ExpirationPlugin({
        maxEntries: 2000,
        maxAgeSeconds: 90 * 24 * 60 * 60,
      }),
      new CacheableResponsePlugin({
        statuses: [200],
      }),
    ],
  }),
);

// Navigate fallback for SPA
const FALLBACK_URL = "/index.html";
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cache = await caches.open("workbox-precache-v2");
        const keys = await cache.keys();
        const match = keys.find((key) =>
          new URL(key.url).pathname.endsWith(FALLBACK_URL),
        );
        if (match) {
          const resp = await cache.match(match);
          if (resp) return resp;
        }
        return caches.match(FALLBACK_URL).then((r) => r ?? new Response("Offline", { status: 503 }));
      }),
    );
  }
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});
