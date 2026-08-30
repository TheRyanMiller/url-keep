import type { UrlKeepClient } from "@url-keep/api-client";
import { OFFLINE_BUNDLE_MAX_LIMIT, type OfflineBundleItem } from "@url-keep/shared";
import {
  getOfflineArticle,
  getOfflineBookmark,
  getOfflineBookmarks,
  getOfflineDb,
  getOfflineSyncState,
} from "./db";

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
  private activeSyncPromise: Promise<void> | null = null;

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

  async hasChanges(): Promise<boolean> {
    const [local, remote] = await Promise.all([
      getOfflineSyncState(),
      this.client.getOfflineStatus(),
    ]);

    if (!local) {
      return true;
    }

    if (local.bookmark_count !== remote.bookmark_count) {
      return true;
    }

    if (local.sync_revision !== remote.sync_revision) {
      return true;
    }

    return false;
  }

  async syncOnce(): Promise<void> {
    if (this.activeSyncPromise) {
      return this.activeSyncPromise;
    }

    this.activeSyncPromise = this.sync().finally(() => {
      this.activeSyncPromise = null;
    });
    return this.activeSyncPromise;
  }

  async sync(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await this.tryStableSync()) {
        return;
      }
    }

    throw new Error("offline snapshot changed while syncing");
  }

  private async tryStableSync(): Promise<boolean> {
    const start = await this.client.getOfflineStatus();
    const items = new Map<string, OfflineBundleItem>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    do {
      const response = await this.client.getOfflineBundle(
        cursor,
        OFFLINE_BUNDLE_MAX_LIMIT,
      );
      for (const item of response.items) {
        items.set(item.bookmark.id, item);
      }

      if (!response.has_more) {
        cursor = undefined;
        continue;
      }
      if (!response.next_cursor || seenCursors.has(response.next_cursor)) {
        throw new Error("offline bundle returned an invalid cursor");
      }
      seenCursors.add(response.next_cursor);
      cursor = response.next_cursor;
    } while (cursor);

    const end = await this.client.getOfflineStatus();
    if (
      start.sync_revision !== end.sync_revision
      || start.bookmark_count !== end.bookmark_count
      || items.size !== end.bookmark_count
    ) {
      return false;
    }

    const db = await getOfflineDb();
    const syncedAt = new Date().toISOString();
    const tx = db.transaction(["bookmarks", "articles", "sync_meta"], "readwrite");
    await tx.objectStore("bookmarks").clear();
    await tx.objectStore("articles").clear();
    for (const item of items.values()) {
      await tx.objectStore("bookmarks").put(item.bookmark);
      if (item.content) {
        await tx.objectStore("articles").put({ ...item.content, synced_at: syncedAt });
      }
    }
    await tx.objectStore("sync_meta").put({
      key: "state",
      last_sync_at: syncedAt,
      bookmark_count: end.bookmark_count,
      sync_revision: end.sync_revision,
    });
    await tx.done;

    if (typeof caches !== "undefined") {
      await caches.delete("article-images");
    }
    await Promise.allSettled(
      [...items.values()]
        .filter((item) => item.content?.content_html)
        .map((item) => precacheArticleImages(item.content!.content_html!, this.apiOrigin)),
    );
    return true;
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
