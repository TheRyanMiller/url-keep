import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [
      react(),
      VitePWA({
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.ts",
        injectRegister: false,
        manifest: false,
        registerType: "autoUpdate",
        injectManifest: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
  };
});
