/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";

declare const self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Article images: cache-first
registerRoute(
  ({ url }) => url.pathname.startsWith("/images/"),
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

type NarrationNotification = {
  type: "narration.ready";
  title: string;
  body: string;
  path: string;
  tag: string;
};

function narrationNotification(value: unknown): NarrationNotification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.type !== "narration.ready"
    || typeof row.title !== "string"
    || row.title.length < 1
    || row.title.length > 80
    || typeof row.body !== "string"
    || row.body.length > 200
    || typeof row.path !== "string"
    || !/^\/read\/[0-9a-f-]{36}#audio$/.test(row.path)
    || typeof row.tag !== "string"
    || !/^narration:[0-9a-f-]{36}$/.test(row.tag)
  ) return null;
  return row as NarrationNotification;
}

self.addEventListener("push", (event) => {
  let value: unknown = null;
  try {
    value = event.data?.json();
  } catch {
    // A generic notification is safer than trusting malformed push data.
  }
  const payload = narrationNotification(value) ?? {
    type: "narration.ready" as const,
    title: "url-keep",
    body: "audio is ready",
    path: "/",
    tag: "narration",
  };
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    data: { path: payload.path },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawPath = (event.notification.data as { path?: unknown } | null)?.path;
  const path = typeof rawPath === "string"
    && (rawPath === "/" || /^\/read\/[0-9a-f-]{36}#audio$/.test(rawPath))
    ? rawPath
    : "/";
  const target = new URL(path, self.location.origin).toString();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const exact = windows.find((client) => client.url === target);
    if (exact && "focus" in exact) return exact.focus();
    const existing = windows[0];
    if (existing && "navigate" in existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});
