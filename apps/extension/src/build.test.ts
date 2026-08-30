import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const extensionRoot = resolve(import.meta.dirname, "..");

function buildManifest(apiOrigin: string) {
  execFileSync(process.execPath, ["build.mjs"], {
    cwd: extensionRoot,
    env: {
      ...process.env,
      URL_KEEP_API_ORIGIN: apiOrigin,
      URL_KEEP_APP_ORIGIN: "https://www.url-keep.com",
    },
    stdio: "pipe",
  });
  return JSON.parse(
    readFileSync(resolve(extensionRoot, "dist/manifest.json"), "utf8"),
  ) as {
    host_permissions: string[];
    background?: { service_worker: string };
  };
}

describe("generated extension manifest", () => {
  it("grants production access only to the configured API origin", () => {
    const manifest = buildManifest("https://api.url-keep.com");
    expect(manifest.host_permissions).toEqual(["https://api.url-keep.com/*"]);
    expect(manifest.host_permissions).not.toContain("https://*/*");
    expect(manifest.background?.service_worker).toBe("background.js");
  });

  it("keeps local API access confined to development builds", () => {
    const manifest = buildManifest("http://localhost:8787");
    expect(manifest.host_permissions).toEqual(["http://localhost:8787/*"]);
  });
});
