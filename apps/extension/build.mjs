import { build } from "esbuild";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname);
const outdir = resolve(root, "dist");
const apiOrigin = process.env.URL_KEEP_API_ORIGIN ?? "http://localhost:8787";
const appOrigin = process.env.URL_KEEP_APP_ORIGIN ?? "http://localhost:5173";

mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [resolve(root, "src/popup.ts")],
  bundle: true,
  format: "esm",
  outfile: resolve(outdir, "popup.js"),
  define: {
    __API_ORIGIN__: JSON.stringify(apiOrigin),
    __APP_ORIGIN__: JSON.stringify(appOrigin),
  },
});

cpSync(resolve(root, "src/popup.html"), resolve(outdir, "popup.html"));
cpSync(resolve(root, "src/styles.css"), resolve(outdir, "styles.css"));

writeFileSync(
  resolve(outdir, "manifest.json"),
  JSON.stringify(
    {
      manifest_version: 3,
      name: "url-keep",
      version: "0.0.1",
      description: "Save or un-save the current URL in url-keep.",
      permissions: ["activeTab", "scripting", "storage"],
      host_permissions: [
        "https://*/*",
        "http://localhost/*",
        "http://127.0.0.1/*",
      ],
      action: {
        default_title: "url-keep",
        default_popup: "popup.html",
      },
      homepage_url: appOrigin,
    },
    null,
    2,
  ),
);
