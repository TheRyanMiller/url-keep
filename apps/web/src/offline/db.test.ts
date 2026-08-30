import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOfflineData,
  getOfflineDb,
  type OfflineSyncState,
} from "./db";

beforeEach(async () => {
  await clearOfflineData();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline account storage", () => {
  it("clears private IndexedDB rows and article images without touching the shell", async () => {
    const db = await getOfflineDb();
    await db.put("bookmarks", {
      id: "bookmark-1",
      url: "https://example.com",
      normalized_url: "https://example.com",
      bucket: "reading",
      title: "Example",
      image_url: null,
      site_name: null,
      saved_via: "web",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
      extraction_status: null,
    });
    await db.put("sync_meta", {
      key: "state",
      last_sync_at: "2026-01-01",
      bookmark_count: 1,
      sync_revision: 1,
    });
    await db.put("sync_meta", {
      key: "credentials",
      token: "legacy-secret",
      apiOrigin: "https://api.example.com",
    } as unknown as OfflineSyncState);
    const deleteCache = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", { delete: deleteCache });

    await clearOfflineData();

    expect(await db.count("bookmarks")).toBe(0);
    expect(await db.count("articles")).toBe(0);
    expect(await db.count("sync_meta")).toBe(0);
    expect(deleteCache).toHaveBeenCalledTimes(2);
    expect(deleteCache).toHaveBeenCalledWith("article-images");
    expect(deleteCache).toHaveBeenCalledWith("api-cache");
  });
});
