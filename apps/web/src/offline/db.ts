import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  ArticleContent,
  ArticleMetadata,
  Bookmark,
  ManifestItem,
  ReadyNarrationSummary,
} from "@url-keep/shared";

const DB_NAME = "url-keep";
const DB_VERSION = 2;

type StoredBookmark = Omit<Bookmark, "extraction_status">;

export type OfflineArticleMeta = ArticleMetadata & {
  bookmark_id: string;
  narration: ReadyNarrationSummary | null;
};

export type OfflineArticleBody = {
  article_id: string;
  content_html: string;
  synced_at: string;
};

export type OfflineArticle = ArticleContent & {
  synced_at: string | null;
  narration: ReadyNarrationSummary | null;
};

export type OfflineSyncState = {
  key: "state";
  accepted_revision: number | null;
  last_check_at: string | null;
  last_sync_at: string | null;
};

export const OFFLINE_AUDIO_LIMITS = [250, 500, 1024].map(
  (megabytes) => megabytes * 1024 * 1024,
) as [number, number, number];

export type AudioSettings = {
  key: "audio";
  enabled: boolean;
  byte_limit: number;
};

export type OfflineAudioRecord = {
  narration_id: string;
  article_id: string;
  cache_key: string;
  sha256: string;
  byte_size: number;
  last_accessed_at: string;
};

interface OfflineDBSchema extends DBSchema {
  bookmarks: {
    key: string;
    value: StoredBookmark;
    indexes: {
      "by-created": string;
      "by-normalized-url": string;
    };
  };
  article_meta: {
    key: string;
    value: OfflineArticleMeta;
    indexes: {
      "by-article": string;
    };
  };
  article_bodies: {
    key: string;
    value: OfflineArticleBody;
  };
  sync_meta: {
    key: string;
    value: OfflineSyncState;
  };
  audio_settings: {
    key: "audio";
    value: AudioSettings;
  };
  offline_audio: {
    key: string;
    value: OfflineAudioRecord;
    indexes: {
      "by-article": string;
      "by-accessed": string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<OfflineDBSchema>> | null = null;
let privateStorageGeneration = 0;

export function getPrivateStorageGeneration(): number {
  return privateStorageGeneration;
}

export function isPrivateStorageGenerationCurrent(generation: number): boolean {
  return generation === privateStorageGeneration;
}

function notifyBlockedUpgrade() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("url-keep:database-blocked", {
      detail: "Close other URL Keep tabs, then reload to finish the offline database upgrade.",
    }));
  }
}

export function getOfflineDb() {
  dbPromise ??= openDB<OfflineDBSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion === 0) {
        const bookmarks = db.createObjectStore("bookmarks", { keyPath: "id" });
        bookmarks.createIndex("by-created", "created_at");
        bookmarks.createIndex("by-normalized-url", "normalized_url");
        db.createObjectStore("sync_meta", { keyPath: "key" });
        db.createObjectStore("audio_settings", { keyPath: "key" });
        const audio = db.createObjectStore("offline_audio", { keyPath: "narration_id" });
        audio.createIndex("by-article", "article_id");
        audio.createIndex("by-accessed", "last_accessed_at");
      } else {
        const legacyDb = db as unknown as {
          objectStoreNames: DOMStringList;
          deleteObjectStore(name: string): void;
        };
        if (legacyDb.objectStoreNames.contains("articles")) {
          legacyDb.deleteObjectStore("articles");
        }
        transaction.objectStore("bookmarks").clear();
        transaction.objectStore("sync_meta").clear();
        transaction.objectStore("offline_audio").clear();
      }

      if (!db.objectStoreNames.contains("article_meta")) {
        const meta = db.createObjectStore("article_meta", { keyPath: "bookmark_id" });
        meta.createIndex("by-article", "id", { unique: true });
      }
      if (!db.objectStoreNames.contains("article_bodies")) {
        db.createObjectStore("article_bodies", { keyPath: "article_id" });
      }
    },
    blocked: notifyBlockedUpgrade,
    blocking(_currentVersion, _blockedVersion, event) {
      (event.target as IDBDatabase | null)?.close();
      dbPromise = null;
    },
    terminated() {
      dbPromise = null;
    },
  });
  return dbPromise;
}

export async function closeOfflineDb() {
  const db = await dbPromise;
  db?.close();
  dbPromise = null;
}

function withArticleStatus(bookmark: StoredBookmark, meta?: OfflineArticleMeta): Bookmark {
  return {
    ...bookmark,
    extraction_status: meta?.status ?? null,
  };
}

export async function getOfflineBookmarks(): Promise<Bookmark[]> {
  const db = await getOfflineDb();
  const [bookmarks, metadata] = await Promise.all([
    db.getAll("bookmarks"),
    db.getAll("article_meta"),
  ]);
  const byBookmark = new Map(metadata.map((item) => [item.bookmark_id, item]));
  return bookmarks
    .map((bookmark) => withArticleStatus(bookmark, byBookmark.get(bookmark.id)))
    .sort((left, right) => {
      const byDate = right.created_at.localeCompare(left.created_at);
      return byDate !== 0 ? byDate : right.id.localeCompare(left.id);
    });
}

export async function getOfflineBookmark(id: string): Promise<Bookmark | null> {
  const db = await getOfflineDb();
  const [bookmark, meta] = await Promise.all([
    db.get("bookmarks", id),
    db.get("article_meta", id),
  ]);
  return bookmark ? withArticleStatus(bookmark, meta) : null;
}

export async function getOfflineArticleMeta(bookmarkId: string) {
  return (await (await getOfflineDb()).get("article_meta", bookmarkId)) ?? null;
}

export async function getOfflineArticle(bookmarkId: string): Promise<OfflineArticle | null> {
  const db = await getOfflineDb();
  const meta = await db.get("article_meta", bookmarkId);
  if (!meta) return null;
  const body = await db.get("article_bodies", meta.id);
  return {
    id: meta.id,
    bookmark_id: bookmarkId,
    title: meta.title,
    content_html: body?.content_html ?? null,
    word_count: meta.word_count,
    author: meta.author,
    published_date: meta.published_date,
    extraction_status: meta.status,
    extraction_error: meta.failure_code
      ? JSON.stringify({ reason: meta.failure_code })
      : null,
    extracted_at: meta.updated_at,
    content_source: meta.content_source,
    synced_at: body?.synced_at ?? null,
    narration: meta.narration,
  };
}

export async function putOfflineSyncState(state: Omit<OfflineSyncState, "key">) {
  await (await getOfflineDb()).put("sync_meta", { key: "state", ...state });
}

export async function getOfflineSyncState(): Promise<OfflineSyncState | null> {
  return (await (await getOfflineDb()).get("sync_meta", "state")) ?? null;
}

export async function touchOfflineCheck(checkedAt: string) {
  const db = await getOfflineDb();
  const state = await db.get("sync_meta", "state");
  await db.put("sync_meta", {
    key: "state",
    accepted_revision: state?.accepted_revision ?? null,
    last_sync_at: state?.last_sync_at ?? null,
    last_check_at: checkedAt,
  });
}

export async function replaceOfflineManifest(items: ManifestItem[], revision: number) {
  const db = await getOfflineDb();
  const now = new Date().toISOString();
  const tx = db.transaction(["bookmarks", "article_meta", "sync_meta"], "readwrite");
  await Promise.all([
    tx.objectStore("bookmarks").clear(),
    tx.objectStore("article_meta").clear(),
  ]);
  for (const item of items) {
    const { extraction_status: _status, ...bookmark } = item.bookmark;
    await tx.objectStore("bookmarks").put(bookmark);
    if (item.article) {
      await tx.objectStore("article_meta").put({
        ...item.article,
        bookmark_id: item.bookmark.id,
        narration: item.narration,
      });
    }
  }
  await tx.objectStore("sync_meta").put({
    key: "state",
    accepted_revision: revision,
    last_check_at: now,
    last_sync_at: now,
  });
  await tx.done;
}

export async function putOfflineArticleBody(articleId: string, contentHtml: string) {
  await (await getOfflineDb()).put("article_bodies", {
    article_id: articleId,
    content_html: contentHtml,
    synced_at: new Date().toISOString(),
  });
}

export async function getMissingArticleBodies(): Promise<OfflineArticleMeta[]> {
  const db = await getOfflineDb();
  const metadata = await db.getAll("article_meta");
  const missing: OfflineArticleMeta[] = [];
  for (const meta of metadata) {
    if (meta.status === "complete" && !(await db.getKey("article_bodies", meta.id))) {
      missing.push(meta);
    }
  }
  return missing;
}

export async function deleteUnreferencedBodies(limit = 25): Promise<number> {
  const db = await getOfflineDb();
  const metadata = await db.getAll("article_meta");
  const referenced = new Set(metadata.map((item) => item.id));
  const keys = await db.getAllKeys("article_bodies");
  const stale = keys.filter((key) => !referenced.has(key)).slice(0, limit);
  const tx = db.transaction("article_bodies", "readwrite");
  for (const key of stale) await tx.store.delete(key);
  await tx.done;
  return stale.length;
}

export async function getOfflineReadableBookmarkIds(): Promise<Set<string>> {
  const db = await getOfflineDb();
  const metadata = await db.getAll("article_meta");
  const ids = new Set<string>();
  for (const meta of metadata) {
    if (meta.status === "complete" && await db.getKey("article_bodies", meta.id)) {
      ids.add(meta.bookmark_id);
    }
  }
  return ids;
}

export async function getReadyNarrations(): Promise<ReadyNarrationSummary[]> {
  return (await (await getOfflineDb()).getAll("article_meta"))
    .map((item) => item.narration)
    .filter((item): item is ReadyNarrationSummary => item !== null);
}

export async function clearOfflineData() {
  privateStorageGeneration += 1;
  const db = await getOfflineDb();
  const tx = db.transaction(
    ["bookmarks", "article_meta", "article_bodies", "sync_meta", "offline_audio"],
    "readwrite",
  );
  await Promise.all([
    tx.objectStore("bookmarks").clear(),
    tx.objectStore("article_meta").clear(),
    tx.objectStore("article_bodies").clear(),
    tx.objectStore("sync_meta").clear(),
    tx.objectStore("offline_audio").clear(),
  ]);
  await tx.done;
  if (typeof caches !== "undefined") {
    await caches.delete("article-images");
    await caches.delete("url-keep-audio");
  }
}
