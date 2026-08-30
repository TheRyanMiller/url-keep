import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UrlKeepClient } from "@url-keep/api-client";
import type { ManifestItem } from "@url-keep/shared";
import {
  clearOfflineData,
  getOfflineDb,
  getOfflineSyncState,
  replaceOfflineManifest,
} from "./db";
import { SyncManager } from "./sync";

function item(title: string, ordinal = 1): ManifestItem {
  const suffix = String(ordinal).padStart(12, "0");
  const bookmarkId = `10000000-0000-4000-8000-${suffix}`;
  const articleId = `20000000-0000-4000-8000-${suffix}`;
  return {
    bookmark: {
      id: bookmarkId,
      url: `https://example.com/article-${ordinal}`,
      normalized_url: `https://example.com/article-${ordinal}`,
      bucket: "reading",
      title,
      title_source: "client",
      image_url: null,
      site_name: "Example",
      saved_via: "web",
      created_at: `2026-01-01T00:00:${String(ordinal % 60).padStart(2, "0")}.000Z`,
      updated_at: "2026-01-01T00:00:00.000Z",
      extraction_status: "complete",
    },
    article: {
      id: articleId,
      status: "complete",
      failure_code: null,
      title,
      word_count: 3,
      author: null,
      published_date: null,
      content_source: "server",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    narration: null,
  };
}

function client(options: {
  revisions: number[];
  pages: Array<{ items: ManifestItem[]; next_cursor: string | null }>;
  body?: (articleId: string) => Promise<string>;
}) {
  const getSyncRevision = vi.fn();
  for (const revision of options.revisions) {
    getSyncRevision.mockResolvedValueOnce({ revision });
  }
  const getManifest = vi.fn();
  for (const page of options.pages) getManifest.mockResolvedValueOnce(page);
  const getArticleBody = vi.fn(options.body ?? (async (id: string) => `<p>${id}</p>`));
  return {
    api: { getSyncRevision, getManifest, getArticleBody } as unknown as UrlKeepClient,
    getSyncRevision,
    getManifest,
    getArticleBody,
  };
}

beforeEach(clearOfflineData);

describe("SyncManager", () => {
  it("atomically commits a stable manifest and hydrates bodies separately", async () => {
    const db = await getOfflineDb();
    await db.put("bookmarks", {
      ...item("Stale", 9).bookmark,
      id: "stale",
    });
    const current = item("Current");
    const remote = client({
      revisions: [7, 7],
      pages: [{ items: [current], next_cursor: null }],
    });
    const manager = new SyncManager(remote.api);

    await manager.syncOnce();
    expect((await manager.getBookmarks()).map((bookmark) => bookmark.title)).toEqual(["Current"]);
    expect(await getOfflineSyncState()).toMatchObject({ accepted_revision: 7 });
    await manager.waitForHydrationForTests();
    expect((await manager.getArticle(current.bookmark.id))?.content_html).toContain(current.article!.id);
    expect(remote.getManifest).toHaveBeenCalledWith(undefined, 100);
  });

  it("restarts once when the revision changes during pagination", async () => {
    const remote = client({
      revisions: [1, 2, 2, 2],
      pages: [
        { items: [item("Moving")], next_cursor: null },
        { items: [item("Stable")], next_cursor: null },
      ],
    });
    const manager = new SyncManager(remote.api);
    await manager.syncOnce();
    expect((await manager.getBookmarks())[0]?.title).toBe("Stable");
    expect(remote.getManifest).toHaveBeenCalledTimes(2);
  });

  it("preserves the accepted snapshot after two unstable attempts", async () => {
    await replaceOfflineManifest([item("Existing")], 1);
    const remote = client({
      revisions: [2, 3, 3, 4],
      pages: [
        { items: [item("Unstable one")], next_cursor: null },
        { items: [item("Unstable two")], next_cursor: null },
      ],
    });
    const manager = new SyncManager(remote.api);
    await expect(manager.syncOnce()).rejects.toThrow("snapshot changed");
    expect((await manager.getBookmarks())[0]?.title).toBe("Existing");
    expect((await getOfflineSyncState())?.accepted_revision).toBe(1);
  });

  it("coalesces concurrent foreground triggers", async () => {
    let release!: (value: { revision: number }) => void;
    const firstRevision = new Promise<{ revision: number }>((resolve) => {
      release = resolve;
    });
    const remote = client({
      revisions: [4],
      pages: [{ items: [item("Single flight")], next_cursor: null }],
    });
    remote.getSyncRevision.mockReset()
      .mockReturnValueOnce(firstRevision)
      .mockResolvedValueOnce({ revision: 4 });
    const manager = new SyncManager(remote.api);
    const first = manager.syncOnce();
    const second = manager.syncOnce();
    release({ revision: 4 });
    await Promise.all([first, second]);
    expect(remote.getManifest).toHaveBeenCalledTimes(1);
  });

  it("reads the snapshot another tab committed before a revision-equality early exit", async () => {
    await replaceOfflineManifest([item("R2")], 2);
    await replaceOfflineManifest([item("R3")], 3);
    const remote = client({ revisions: [3], pages: [] });
    const manager = new SyncManager(remote.api);

    await manager.syncOnce();

    expect((await manager.getBookmarks())[0]?.title).toBe("R3");
    expect(remote.getManifest).not.toHaveBeenCalled();
  });

  it("accepts more than fifty bookmarks across bounded manifest pages", async () => {
    const first = Array.from({ length: 100 }, (_, index) => item(`Item ${index}`, index + 1));
    const second = [item("Item 100", 101)];
    const remote = client({
      revisions: [9, 9],
      pages: [
        { items: first, next_cursor: "page-2" },
        { items: second, next_cursor: null },
      ],
    });
    const manager = new SyncManager(remote.api);
    await manager.syncOnce();
    expect(await manager.getBookmarks()).toHaveLength(101);
    expect(remote.getManifest).toHaveBeenNthCalledWith(2, "page-2", 100);
  });
});
