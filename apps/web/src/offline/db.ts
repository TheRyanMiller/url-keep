import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ArticleContent, Bookmark } from "@url-keep/shared";

const DB_NAME = "url-keep";
const DB_VERSION = 1;

export type OfflineArticle = ArticleContent & {
  synced_at: string;
};

export type OfflineSyncState = {
  key: "state";
  last_sync_at: string | null;
  bookmark_count: number;
  sync_revision: number;
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
    value: Bookmark;
    indexes: {
      "by-created": string;
      "by-normalized-url": string;
    };
  };
  articles: {
    key: string;
    value: OfflineArticle;
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

export function getOfflineDb() {
  dbPromise ??= openDB<OfflineDBSchema>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const bookmarks = db.createObjectStore("bookmarks", { keyPath: "id" });
      bookmarks.createIndex("by-created", "created_at");
      bookmarks.createIndex("by-normalized-url", "normalized_url");

      db.createObjectStore("articles", { keyPath: "bookmark_id" });
      db.createObjectStore("sync_meta", { keyPath: "key" });
      db.createObjectStore("audio_settings", { keyPath: "key" });

      const audio = db.createObjectStore("offline_audio", {
        keyPath: "narration_id",
      });
      audio.createIndex("by-article", "article_id");
      audio.createIndex("by-accessed", "last_accessed_at");
    },
  });

  return dbPromise;
}

export async function getOfflineBookmarks(): Promise<Bookmark[]> {
  const db = await getOfflineDb();
  const bookmarks = await db.getAll("bookmarks");
  return bookmarks.sort((left, right) => {
    const byDate = right.created_at.localeCompare(left.created_at);
    if (byDate !== 0) {
      return byDate;
    }
    return right.id.localeCompare(left.id);
  });
}

export async function getOfflineBookmark(id: string): Promise<Bookmark | null> {
  const bookmark = await (await getOfflineDb()).get("bookmarks", id);
  return bookmark ?? null;
}

export async function getOfflineArticle(bookmarkId: string): Promise<OfflineArticle | null> {
  const article = await (await getOfflineDb()).get("articles", bookmarkId);
  return article ?? null;
}

export async function putOfflineSyncState(state: Omit<OfflineSyncState, "key">) {
  await (await getOfflineDb()).put("sync_meta", {
    key: "state",
    ...state,
  });
}

export async function getOfflineSyncState(): Promise<OfflineSyncState | null> {
  const state = await (await getOfflineDb()).get("sync_meta", "state");
  return state ?? null;
}

export async function getOfflineReadableBookmarkIds(): Promise<Set<string>> {
  const articles = await (await getOfflineDb()).getAll("articles");
  return new Set(
    articles
      .filter((article) => article.extraction_status === "complete" && article.content_html)
      .map((article) => article.bookmark_id),
  );
}

export async function clearOfflineData() {
  const db = await getOfflineDb();
  const tx = db.transaction(
    ["bookmarks", "articles", "sync_meta", "offline_audio"],
    "readwrite",
  );
  await Promise.all([
    tx.objectStore("bookmarks").clear(),
    tx.objectStore("articles").clear(),
    tx.objectStore("sync_meta").clear(),
    tx.objectStore("offline_audio").clear(),
  ]);
  await tx.done;
  if (typeof caches !== "undefined") {
    await caches.delete("article-images");
    await caches.delete("url-keep-audio");
  }
}
