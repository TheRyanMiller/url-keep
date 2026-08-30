import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("service worker cache ownership", () => {
  it("never handles authenticated API data", () => {
    const source = readFileSync(resolve(import.meta.dirname, "sw.ts"), "utf8");
    expect(source).toContain("self.skipWaiting();");
    expect(source).toContain("clientsClaim();");
    expect(source).not.toContain("SKIP_WAITING");
    expect(source).not.toContain("api-cache");
    expect(source).not.toContain("NetworkFirst");
    expect(source).not.toContain("Authorization");
    expect(source).not.toContain("periodicsync");
    expect(source).not.toContain('addEventListener("sync"');
    expect(source).not.toContain("indexedDB");
    expect(source).toContain("article-images");
    expect(source).not.toContain('addEventListener("push"');
    expect(source).not.toContain('addEventListener("notificationclick"');
    expect(source).not.toContain("__audio");
  });
});
