import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ArticleContent, Bookmark } from "@url-keep/shared";

const DB_NAME = "url-keep-offline";
const DB_VERSION = 2;
const LEGACY_CREDENTIALS_KEY = "credentials" as OfflineSyncState["key"];
const LEGACY_API_CACHE = "api-cache";

export type OfflineArticle = ArticleContent & {
  synced_at: string;
};

export type OfflineSyncState = {
  key: "state";
  last_sync_at: string | null;
  bookmark_count: number;
  sync_revision: number;
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
}

let dbPromise: Promise<IDBPDatabase<OfflineDBSchema>> | null = null;

export function getOfflineDb() {
  dbPromise ??= openDB<OfflineDBSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (!db.objectStoreNames.contains("bookmarks")) {
        const store = db.createObjectStore("bookmarks", {
          keyPath: "id",
        });
        store.createIndex("by-created", "created_at");
        store.createIndex("by-normalized-url", "normalized_url");
      }

      if (!db.objectStoreNames.contains("articles")) {
        db.createObjectStore("articles", {
          keyPath: "bookmark_id",
        });
      }

      if (!db.objectStoreNames.contains("sync_meta")) {
        db.createObjectStore("sync_meta", {
          keyPath: "key",
        });
      }

      if (oldVersion < 2 && db.objectStoreNames.contains("sync_meta")) {
        void transaction.objectStore("sync_meta").delete(LEGACY_CREDENTIALS_KEY);
      }
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
  const tx = db.transaction(["bookmarks", "articles", "sync_meta"], "readwrite");
  await Promise.all([
    tx.objectStore("bookmarks").clear(),
    tx.objectStore("articles").clear(),
    tx.objectStore("sync_meta").clear(),
  ]);
  await tx.done;
  if (typeof caches !== "undefined") {
    await Promise.all([
      caches.delete("article-images"),
      caches.delete(LEGACY_API_CACHE),
    ]);
  }
}
