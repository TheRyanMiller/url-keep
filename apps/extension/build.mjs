import { build } from "esbuild";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname);
const outdir = resolve(root, "dist");
const assetsDir = resolve(root, "assets");
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
cpSync(resolve(assetsDir, "url-keep-logo.png"), resolve(outdir, "url-keep-logo.png"));
cpSync(resolve(assetsDir, "url-keep-icon-16.png"), resolve(outdir, "url-keep-icon-16.png"));
cpSync(resolve(assetsDir, "url-keep-icon-32.png"), resolve(outdir, "url-keep-icon-32.png"));
cpSync(resolve(assetsDir, "url-keep-icon-48.png"), resolve(outdir, "url-keep-icon-48.png"));
cpSync(resolve(assetsDir, "url-keep-icon-128.png"), resolve(outdir, "url-keep-icon-128.png"));

writeFileSync(
  resolve(outdir, "manifest.json"),
  JSON.stringify(
    {
      manifest_version: 3,
      key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuwKeLiYcJjHbiYhOWefXGy4fMhSt7oyL9D5yGymb48WzuF9lSvYImtvcsjCeqs574QFACY0qHkaKRnuoDeqEf/A5BTKvgmfvFwFZU2fppVmVyOtnZtmxodVM745bL9m1S3iFUYYQCsGBkMPD7aPT0F6pNZWVC1c+CQvUJ2yzlImODdVj+lXf3WU6aICaUJiJIYqp4HaT99tsna5FVQVfLtr8N47yIMSW8wzttEvp8Xaj3Yp3vUIluoXOIsIlDTvlYeU9B6w8nr7AyjxabTE3EjhkQSa3NlFY/sT3cfxKm31quHzNOBpDovNV27DyKXmR4udnFEI2FMDRh3kG07wixQIDAQAB",
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
        default_icon: {
          16: "url-keep-icon-16.png",
          32: "url-keep-icon-32.png",
        },
      },
      icons: {
        16: "url-keep-icon-16.png",
        32: "url-keep-icon-32.png",
        48: "url-keep-icon-48.png",
        128: "url-keep-icon-128.png",
      },
      homepage_url: appOrigin,
    },
    null,
    2,
  ),
);
