import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UrlKeepClient } from "@url-keep/api-client";
import type { Bookmark, OfflineBundleItem } from "@url-keep/shared";
import { clearOfflineData, getOfflineDb, getOfflineSyncState } from "./db";
import { SyncManager } from "./sync";

function bookmark(title: string, id = "bookmark-1"): Bookmark {
  return {
    id,
    url: "https://example.com/article",
    normalized_url: "https://example.com/article",
    bucket: "reading",
    title,
    image_url: null,
    site_name: "Example",
    saved_via: "web",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    extraction_status: "complete",
  };
}

function bundleItem(title: string, id = "bookmark-1"): OfflineBundleItem {
  return {
    bookmark: bookmark(title, id),
    content: {
      id: `article-${id}`,
      bookmark_id: id,
      title,
      content_html: `<p>${title} article content</p>`,
      word_count: 3,
      author: null,
      published_date: null,
      extraction_status: "complete",
      extraction_error: null,
      extracted_at: "2026-01-01T00:00:00.000Z",
      content_source: "server",
    },
    narration: null,
  };
}

function clientWith(
  getOfflineStatus: ReturnType<typeof vi.fn>,
  getOfflineBundle: ReturnType<typeof vi.fn>,
) {
  return { getOfflineStatus, getOfflineBundle } as unknown as UrlKeepClient;
}

beforeEach(async () => {
  await clearOfflineData();
});

describe("SyncManager", () => {
  it("commits a complete stable snapshot and removes stale local rows", async () => {
    const db = await getOfflineDb();
    await db.put("bookmarks", { ...bookmark("Stale"), id: "stale" });

    const getOfflineStatus = vi.fn().mockResolvedValue({
      bookmark_count: 1,
      sync_revision: 7,
    });
    const getOfflineBundle = vi.fn().mockResolvedValue({
      items: [bundleItem("Current")],
      next_cursor: null,
      has_more: false,
    });
    const manager = new SyncManager(
      clientWith(getOfflineStatus, getOfflineBundle),
      "https://api.example.com",
    );

    await manager.syncOnce();

    expect((await db.getAll("bookmarks")).map((item) => item.title)).toEqual(["Current"]);
    expect(await getOfflineSyncState()).toMatchObject({
      bookmark_count: 1,
      sync_revision: 7,
    });
    expect(getOfflineBundle).toHaveBeenCalledWith(undefined, 10);
  });

  it("restarts once when the server revision moves during pagination", async () => {
    const getOfflineStatus = vi.fn()
      .mockResolvedValueOnce({ bookmark_count: 1, sync_revision: 1 })
      .mockResolvedValueOnce({ bookmark_count: 1, sync_revision: 2 })
      .mockResolvedValueOnce({ bookmark_count: 1, sync_revision: 2 })
      .mockResolvedValueOnce({ bookmark_count: 1, sync_revision: 2 });
    const getOfflineBundle = vi.fn()
      .mockResolvedValueOnce({
        items: [bundleItem("Moving")],
        next_cursor: null,
        has_more: false,
      })
      .mockResolvedValueOnce({
        items: [bundleItem("Stable")],
        next_cursor: null,
        has_more: false,
      });
    const manager = new SyncManager(
      clientWith(getOfflineStatus, getOfflineBundle),
      "https://api.example.com",
    );

    await manager.syncOnce();

    expect((await manager.getBookmark("bookmark-1"))?.title).toBe("Stable");
    expect(getOfflineBundle).toHaveBeenCalledTimes(2);
  });

  it("does not commit either unstable attempt", async () => {
    const db = await getOfflineDb();
    await db.put("bookmarks", bookmark("Existing"));
    const getOfflineStatus = vi.fn()
      .mockResolvedValueOnce({ bookmark_count: 1, sync_revision: 1 })
      .mockResolvedValueOnce({ bookmark_count: 1, sync_revision: 2 })
      .mockResolvedValueOnce({ bookmark_count: 1, sync_revision: 2 })
      .mockResolvedValueOnce({ bookmark_count: 1, sync_revision: 3 });
    const getOfflineBundle = vi.fn().mockResolvedValue({
      items: [bundleItem("Unstable")],
      next_cursor: null,
      has_more: false,
    });
    const manager = new SyncManager(
      clientWith(getOfflineStatus, getOfflineBundle),
      "https://api.example.com",
    );

    await expect(manager.syncOnce()).rejects.toThrow("snapshot changed");
    expect((await manager.getBookmark("bookmark-1"))?.title).toBe("Existing");
    expect(getOfflineBundle).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent foreground sync triggers", async () => {
    let release!: (value: { bookmark_count: number; sync_revision: number }) => void;
    const firstStatus = new Promise<{ bookmark_count: number; sync_revision: number }>(
      (resolve) => { release = resolve; },
    );
    const getOfflineStatus = vi.fn()
      .mockReturnValueOnce(firstStatus)
      .mockResolvedValue({ bookmark_count: 1, sync_revision: 4 });
    const getOfflineBundle = vi.fn().mockResolvedValue({
      items: [bundleItem("Single flight")],
      next_cursor: null,
      has_more: false,
    });
    const manager = new SyncManager(
      clientWith(getOfflineStatus, getOfflineBundle),
      "https://api.example.com",
    );

    const first = manager.syncOnce();
    const second = manager.syncOnce();
    release({ bookmark_count: 1, sync_revision: 4 });
    await Promise.all([first, second]);

    expect(getOfflineBundle).toHaveBeenCalledTimes(1);
  });

  it("reconciles ten maximum-sized articles with one bundle request in flight", async () => {
    const largeHtml = `<p>${"x".repeat(1_499_983)}</p>`;
    const items = Array.from({ length: 10 }, (_, index) => {
      const item = bundleItem(`Large ${index}`, `bookmark-${index}`);
      return {
        ...item,
        content: { ...item.content!, content_html: largeHtml },
      };
    });
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const getOfflineBundle = vi.fn().mockImplementation(async () => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await Promise.resolve();
      activeRequests -= 1;
      return { items, next_cursor: null, has_more: false };
    });
    const manager = new SyncManager(
      clientWith(
        vi.fn().mockResolvedValue({ bookmark_count: 10, sync_revision: 9 }),
        getOfflineBundle,
      ),
      "https://api.example.com",
    );

    await manager.syncOnce();

    expect((await manager.getBookmarks())).toHaveLength(10);
    expect(getOfflineBundle).toHaveBeenCalledTimes(1);
    expect(maxActiveRequests).toBe(1);
  });
});
