import type { UrlKeepClient } from "@url-keep/api-client";
import {
  getOfflineArticle,
  getOfflineBookmark,
  getOfflineBookmarks,
  getOfflineDb,
  getOfflineSyncState,
  putOfflineSyncState,
} from "./db";

const DEFAULT_SYNC_LIMIT = 50;
const DEFAULT_SYNC_STALE_MS = 60_000;

async function precacheArticleImages(
  contentHtml: string,
  apiOrigin: string,
): Promise<void> {
  if (typeof caches === "undefined") {
    return;
  }

  const cache = await caches.open("article-images");
  const urls = [...contentHtml.matchAll(/src="(\/v1\/images\/[^"]+)"/gi)]
    .map((match) => match[1])
    .filter(Boolean);

  const batchSize = 5;
  for (let index = 0; index < urls.length; index += batchSize) {
    const batch = urls.slice(index, index + batchSize);
    await Promise.allSettled(
      batch.map(async (url) => {
        const fullUrl = new URL(url, apiOrigin).toString();
        const cached = await cache.match(fullUrl);
        if (cached) {
          return;
        }

        const response = await fetch(fullUrl, { credentials: "omit" });
        if (response.ok) {
          await cache.put(fullUrl, response);
        }
      }),
    );
  }
}

export class SyncManager {
  constructor(
    private readonly client: UrlKeepClient,
    private readonly apiOrigin: string,
  ) {}

  async isStale(maxAgeMs = DEFAULT_SYNC_STALE_MS): Promise<boolean> {
    const state = await getOfflineSyncState();
    if (!state?.last_sync_at) {
      return true;
    }

    const lastSyncMs = Date.parse(state.last_sync_at);
    if (!Number.isFinite(lastSyncMs)) {
      return true;
    }

    return Date.now() - lastSyncMs > maxAgeMs;
  }

  async sync(): Promise<void> {
    const db = await getOfflineDb();
    const serverIds = new Set<string>();
    let cursor: string | undefined;

    do {
      const response = await this.client.getOfflineBundle(cursor, DEFAULT_SYNC_LIMIT);
      const tx = db.transaction(["bookmarks", "articles"], "readwrite");

      for (const item of response.items) {
        serverIds.add(item.bookmark.id);
        await tx.objectStore("bookmarks").put(item.bookmark);

        if (item.content) {
          await tx.objectStore("articles").put({
            ...item.content,
            synced_at: new Date().toISOString(),
          });
        } else {
          await tx.objectStore("articles").delete(item.bookmark.id);
        }
      }

      await tx.done;

      await Promise.allSettled(
        response.items
          .filter((item) => item.content?.content_html)
          .map((item) =>
            precacheArticleImages(item.content!.content_html!, this.apiOrigin),
          ),
      );

      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);

    const localBookmarkKeys = await db.getAllKeys("bookmarks");
    const deleteTx = db.transaction(["bookmarks", "articles"], "readwrite");
    for (const key of localBookmarkKeys) {
      const id = String(key);
      if (!serverIds.has(id)) {
        await deleteTx.objectStore("bookmarks").delete(id);
        await deleteTx.objectStore("articles").delete(id);
      }
    }
    await deleteTx.done;

    await putOfflineSyncState({
      last_sync_at: new Date().toISOString(),
      bookmark_count: serverIds.size,
    });
  }

  async getBookmarks() {
    return getOfflineBookmarks();
  }

  async getBookmark(bookmarkId: string) {
    return getOfflineBookmark(bookmarkId);
  }

  async getArticle(bookmarkId: string) {
    return getOfflineArticle(bookmarkId);
  }
}
