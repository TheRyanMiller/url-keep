import { ApiError, type UrlKeepClient } from "@url-keep/api-client";
import { MANIFEST_MAX_LIMIT, type ManifestItem } from "@url-keep/shared";
import {
  deleteUnreferencedBodies,
  getMissingArticleBodies,
  getOfflineArticle,
  getOfflineArticleMeta,
  getOfflineBookmark,
  getOfflineBookmarks,
  getOfflineSyncState,
  getReadyNarrations,
  putOfflineArticleBody,
  replaceOfflineManifest,
  touchOfflineCheck,
} from "./db";
import { retainCurrentNarrations } from "../audio/offline-audio";

const DEFAULT_SYNC_STALE_MS = 60_000;

function quotaExceeded(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === "QuotaExceededError";
}

export class SyncManager {
  private activeSyncPromise: Promise<void> | null = null;
  private hydrationPromise: Promise<void> | null = null;
  private openedArticleId: string | null = null;

  constructor(
    private readonly client: UrlKeepClient,
    _legacyApiOrigin?: string,
    private readonly onPartialCoverage: (partial: boolean) => void = () => {},
  ) {}

  async isStale(maxAgeMs = DEFAULT_SYNC_STALE_MS): Promise<boolean> {
    const state = await getOfflineSyncState();
    if (!state?.last_check_at) return true;
    const lastCheck = Date.parse(state.last_check_at);
    return !Number.isFinite(lastCheck) || Date.now() - lastCheck > maxAgeMs;
  }

  prioritizeArticle(articleId: string | null) {
    this.openedArticleId = articleId;
  }

  async syncOnce(): Promise<void> {
    if (this.activeSyncPromise) return this.activeSyncPromise;
    this.activeSyncPromise = this.sync().finally(() => {
      this.activeSyncPromise = null;
    });
    return this.activeSyncPromise;
  }

  private async sync(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await this.tryStableSync()) return;
    }
    throw new Error("metadata snapshot changed while syncing");
  }

  private async tryStableSync(): Promise<boolean> {
    const start = (await this.client.getSyncRevision()).revision;
    const local = await getOfflineSyncState();
    if (local?.accepted_revision === start) {
      await touchOfflineCheck(new Date().toISOString());
      this.startHydration();
      return true;
    }

    const items = new Map<string, ManifestItem>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.client.getManifest(cursor, MANIFEST_MAX_LIMIT);
      if (response.items.length > MANIFEST_MAX_LIMIT) {
        throw new Error("manifest page exceeded its limit");
      }
      for (const item of response.items) {
        if (items.has(item.bookmark.id)) {
          throw new Error("manifest returned a duplicate bookmark");
        }
        items.set(item.bookmark.id, item);
      }
      if (!response.next_cursor) {
        cursor = undefined;
      } else {
        if (seenCursors.has(response.next_cursor)) {
          throw new Error("manifest returned a repeated cursor");
        }
        seenCursors.add(response.next_cursor);
        cursor = response.next_cursor;
      }
    } while (cursor);

    const end = (await this.client.getSyncRevision()).revision;
    if (start !== end) return false;
    await replaceOfflineManifest([...items.values()], end);
    this.startHydration();
    void getReadyNarrations().then(retainCurrentNarrations).catch(() => undefined);
    return true;
  }

  private startHydration() {
    if (this.hydrationPromise) return;
    this.hydrationPromise = this.hydrateMissingBodies().finally(() => {
      this.hydrationPromise = null;
    });
  }

  private async hydrateMissingBodies() {
    const missing = await getMissingArticleBodies();
    missing.sort((left, right) => {
      if (left.id === this.openedArticleId) return -1;
      if (right.id === this.openedArticleId) return 1;
      return right.updated_at.localeCompare(left.updated_at);
    });
    let index = 0;
    let stop = false;
    await Promise.all(Array.from({ length: Math.min(2, missing.length) }, async () => {
      while (!stop && index < missing.length) {
        const meta = missing[index++];
        try {
          const html = await this.client.getArticleBody(meta.id);
          await putOfflineArticleBody(meta.id, html);
        } catch (caught) {
          if (quotaExceeded(caught)) {
            this.onPartialCoverage(true);
            stop = true;
          } else if (caught instanceof ApiError && caught.status === 401) {
            stop = true;
          }
        }
      }
    }));
    await deleteUnreferencedBodies(25).catch(() => 0);
  }

  async hydrateArticle(articleId: string): Promise<void> {
    this.prioritizeArticle(articleId);
    try {
      const html = await this.client.getArticleBody(articleId);
      await putOfflineArticleBody(articleId, html);
    } catch (caught) {
      if (quotaExceeded(caught)) this.onPartialCoverage(true);
      throw caught;
    }
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

  async getArticleMeta(bookmarkId: string) {
    return getOfflineArticleMeta(bookmarkId);
  }

  async waitForHydrationForTests() {
    await this.hydrationPromise;
  }
}
