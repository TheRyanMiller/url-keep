import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("service worker cache ownership", () => {
  it("purges but never registers the legacy authenticated API cache", () => {
    const source = readFileSync(resolve(import.meta.dirname, "sw.ts"), "utf8");
    expect(source.match(/api-cache/g)).toHaveLength(1);
    expect(source).toContain('caches.delete(LEGACY_API_CACHE)');
    expect(source).not.toContain("NetworkFirst");
    expect(source).not.toContain("Authorization");
    expect(source).not.toContain("periodicsync");
    expect(source).not.toContain('addEventListener("sync"');
    expect(source).not.toContain("indexedDB");
    expect(source).toContain("article-images");
  });
});
