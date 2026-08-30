import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOfflineData,
  closeOfflineDb,
  getOfflineDb,
} from "./db";

async function deleteDatabase() {
  await closeOfflineDb();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("url-keep");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

beforeEach(deleteDatabase);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline account storage", () => {
  it("creates the version-2 read-model schema", async () => {
    const db = await getOfflineDb();
    expect(db.name).toBe("url-keep");
    expect(db.version).toBe(2);
    expect([...db.objectStoreNames]).toEqual([
      "article_bodies",
      "article_meta",
      "audio_settings",
      "bookmarks",
      "offline_audio",
      "sync_meta",
    ]);
  });

  it("upgrades v1 in place, preserving only audio settings", async () => {
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("url-keep", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("bookmarks", { keyPath: "id" });
        db.createObjectStore("articles", { keyPath: "bookmark_id" });
        db.createObjectStore("sync_meta", { keyPath: "key" });
        db.createObjectStore("audio_settings", { keyPath: "key" });
        db.createObjectStore("offline_audio", { keyPath: "narration_id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = legacy.transaction(
      ["bookmarks", "articles", "sync_meta", "audio_settings", "offline_audio"],
      "readwrite",
    );
    transaction.objectStore("bookmarks").put({ id: "old" });
    transaction.objectStore("articles").put({ bookmark_id: "old" });
    transaction.objectStore("sync_meta").put({ key: "state" });
    transaction.objectStore("audio_settings").put({
      key: "audio",
      enabled: true,
      byte_limit: 250 * 1024 * 1024,
    });
    transaction.objectStore("offline_audio").put({ narration_id: "old" });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    legacy.close();

    const db = await getOfflineDb();
    expect(db.version).toBe(2);
    expect(db.objectStoreNames.contains("articles" as never)).toBe(false);
    expect(await db.count("bookmarks")).toBe(0);
    expect(await db.count("sync_meta")).toBe(0);
    expect(await db.count("offline_audio")).toBe(0);
    expect(await db.get("audio_settings", "audio")).toMatchObject({ enabled: true });
  });

  it("clears private read-model rows and media caches but preserves audio settings", async () => {
    const db = await getOfflineDb();
    await db.put("bookmarks", {
      id: "bookmark-1",
      url: "https://example.com",
      normalized_url: "https://example.com",
      bucket: "reading",
      title: "Example",
      title_source: "client",
      image_url: null,
      site_name: null,
      saved_via: "web",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    });
    await db.put("article_meta", {
      bookmark_id: "bookmark-1",
      id: "00000000-0000-4000-8000-000000000001",
      status: "complete",
      failure_code: null,
      title: "Example",
      word_count: 1,
      author: null,
      published_date: null,
      content_source: "server",
      updated_at: "2026-01-01",
      narration: null,
    });
    await db.put("article_bodies", {
      article_id: "00000000-0000-4000-8000-000000000001",
      content_html: "<p>Example</p>",
      synced_at: "2026-01-01",
    });
    await db.put("sync_meta", {
      key: "state",
      accepted_revision: 1,
      last_check_at: "2026-01-01",
      last_sync_at: "2026-01-01",
    });
    await db.put("audio_settings", {
      key: "audio",
      enabled: true,
      byte_limit: 250 * 1024 * 1024,
    });
    const deleteCache = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", { delete: deleteCache });

    await clearOfflineData();

    expect(await db.count("bookmarks")).toBe(0);
    expect(await db.count("article_meta")).toBe(0);
    expect(await db.count("article_bodies")).toBe(0);
    expect(await db.count("sync_meta")).toBe(0);
    expect(await db.count("offline_audio")).toBe(0);
    expect(await db.get("audio_settings", "audio")).toMatchObject({ enabled: true });
    expect(deleteCache).toHaveBeenCalledWith("article-images");
    expect(deleteCache).toHaveBeenCalledWith("url-keep-audio");
  });
});
