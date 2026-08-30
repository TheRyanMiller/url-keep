import "fake-indexeddb/auto";
import { deleteDB, openDB } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOfflineData,
  getOfflineDb,
} from "./db";

beforeEach(async () => {
  await clearOfflineData();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline account storage", () => {
  it("opens the exact greenfield schema", async () => {
    const db = await getOfflineDb();

    expect(db.name).toBe("url-keep");
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames]).toEqual([
      "articles",
      "audio_settings",
      "bookmarks",
      "offline_audio",
      "sync_meta",
    ]);
  });

  it("does not collide with the previous higher-version database", async () => {
    const previous = await openDB("url-keep-offline", 2, {
      upgrade(db) {
        db.createObjectStore("previous");
      },
    });

    try {
      const db = await getOfflineDb();
      expect(db.name).toBe("url-keep");
      expect(db.version).toBe(1);
    } finally {
      previous.close();
      await deleteDB("url-keep-offline");
    }
  });

  it("clears private IndexedDB rows and media caches without touching the shell", async () => {
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
    const deleteCache = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", { delete: deleteCache });

    await clearOfflineData();

    expect(await db.count("bookmarks")).toBe(0);
    expect(await db.count("articles")).toBe(0);
    expect(await db.count("sync_meta")).toBe(0);
    expect(await db.count("offline_audio")).toBe(0);
    expect(deleteCache).toHaveBeenCalledTimes(2);
    expect(deleteCache).toHaveBeenCalledWith("article-images");
    expect(deleteCache).toHaveBeenCalledWith("url-keep-audio");
  });
});
