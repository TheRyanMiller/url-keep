/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";

declare const self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// API responses: network-first with 5s timeout
registerRoute(
  ({ url }) =>
    url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/v1/images/"),
  new NetworkFirst({
    cacheName: "api-cache",
    plugins: [
      new ExpirationPlugin({
        maxEntries: 200,
        maxAgeSeconds: 7 * 24 * 60 * 60,
      }),
    ],
    networkTimeoutSeconds: 5,
  }),
);

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

// Read credentials from IndexedDB (raw API for SW compatibility)
async function getCredentialsFromIdb(): Promise<{
  token: string;
  apiOrigin: string;
} | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("url-keep-offline", 1);
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains("sync_meta")) {
            db.close();
            return resolve(null);
          }
          const tx = db.transaction("sync_meta", "readonly");
          const store = tx.objectStore("sync_meta");
          const getReq = store.get("credentials");
          getReq.onsuccess = () => {
            db.close();
            const data = getReq.result;
            if (data?.token && data?.apiOrigin) {
              resolve({ token: data.token, apiOrigin: data.apiOrigin });
            } else {
              resolve(null);
            }
          };
          getReq.onerror = () => {
            db.close();
            resolve(null);
          };
        } catch {
          resolve(null);
        }
      };
      req.onupgradeneeded = () => {
        // DB doesn't exist yet; skip
        req.transaction?.abort();
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });
}

async function postMessageToClients(data: unknown) {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage(data);
  }
}

// Periodic Background Sync (Chrome/Edge on Android, installed PWAs)
self.addEventListener("periodicsync", (event: Event) => {
  const periodicSyncEvent = event as ExtendableEvent & { tag: string };
  if (periodicSyncEvent.tag !== "url-keep-sync") {
    return;
  }

  periodicSyncEvent.waitUntil(
    (async () => {
      const creds = await getCredentialsFromIdb();
      if (!creds) {
        return;
      }

      try {
        const response = await fetch(`${creds.apiOrigin}/v1/offline/status`, {
          headers: { Authorization: `Bearer ${creds.token}` },
        });
        if (!response.ok) {
          return;
        }

        const clients = await self.clients.matchAll({ type: "window" });
        if (clients.length > 0) {
          await postMessageToClients({ type: "url-keep:sync-needed" });
        }
      } catch {
        // Network unavailable during background sync; skip
      }
    })(),
  );
});

// One-shot Background Sync (retry after failed sync)
self.addEventListener("sync", (event: Event) => {
  const syncEvent = event as ExtendableEvent & { tag: string };
  if (syncEvent.tag !== "url-keep-retry") {
    return;
  }

  syncEvent.waitUntil(postMessageToClients({ type: "url-keep:sync-needed" }));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});
