import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ArticleContent, Bookmark } from "@url-keep/shared";

const DB_NAME = "url-keep-offline";
const DB_VERSION = 1;

export type OfflineArticle = ArticleContent & {
  synced_at: string;
};

export type OfflineSyncState = {
  key: "state";
  last_sync_at: string | null;
  bookmark_count: number;
  latest_updated_at: string | null;
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
    upgrade(db) {
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

export type OfflineCredentials = {
  key: "credentials";
  token: string;
  apiOrigin: string;
};

export async function putOfflineCredentials(token: string, apiOrigin: string) {
  await (await getOfflineDb()).put("sync_meta", {
    key: "credentials",
    token,
    apiOrigin,
  } as unknown as OfflineSyncState);
}

export async function clearOfflineCredentials() {
  await (await getOfflineDb()).delete("sync_meta", "credentials");
}
