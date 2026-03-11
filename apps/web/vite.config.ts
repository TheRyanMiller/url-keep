import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

function normalizeApiOrigin(value: string | undefined) {
  const fallback = "http://localhost:8787";
  const trimmed = value?.trim();

  if (!trimmed) {
    return fallback;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed.replace(/^\/+/, "")}`;

  try {
    return new URL(withProtocol).origin;
  } catch {
    return fallback;
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiOrigin = normalizeApiOrigin(env.VITE_API_ORIGIN);

  return {
    plugins: [
      react(),
      VitePWA({
        injectRegister: "auto",
        manifest: false,
        registerType: "autoUpdate",
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
          navigateFallback: "/index.html",
          navigateFallbackAllowlist: [/^(?!\/?v1\/).*/],
          runtimeCaching: [
            {
              urlPattern: ({ url }) =>
                url.origin === apiOrigin &&
                url.pathname.startsWith("/v1/") &&
                !url.pathname.startsWith("/v1/images/"),
              handler: "NetworkFirst",
              options: {
                cacheName: "api-cache",
                expiration: {
                  maxEntries: 200,
                  maxAgeSeconds: 7 * 24 * 60 * 60,
                },
                networkTimeoutSeconds: 5,
              },
            },
            {
              urlPattern: ({ url }) =>
                url.origin === apiOrigin && url.pathname.startsWith("/v1/images/"),
              handler: "CacheFirst",
              options: {
                cacheName: "article-images",
                expiration: {
                  maxEntries: 2000,
                  maxAgeSeconds: 90 * 24 * 60 * 60,
                },
                cacheableResponse: {
                  statuses: [200],
                },
              },
            },
          ],
        },
      }),
    ],
  };
});
