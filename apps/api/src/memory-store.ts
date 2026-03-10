import {
  decodeCursor,
  encodeCursor,
} from "./utils";
import type {
  AccessTokenRecord,
  BookmarkRecord,
  ListBookmarksOptions,
  ListBookmarksResult,
  UserRecord,
} from "./types";
import type { Store } from "./store";

export class MemoryStore implements Store {
  private users = new Map<string, UserRecord>();
  private accessTokens = new Map<string, AccessTokenRecord>();
  private bookmarks = new Map<string, BookmarkRecord>();

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    for (const user of this.users.values()) {
      if (user.email === email) {
        return user;
      }
    }
    return null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async insertUser(user: UserRecord): Promise<void> {
    this.users.set(user.id, user);
  }

  async getAccessTokenByHash(tokenHash: string): Promise<AccessTokenRecord | null> {
    for (const token of this.accessTokens.values()) {
      if (token.tokenHash === tokenHash) {
        return token;
      }
    }
    return null;
  }

  async getAccessTokenById(
    userId: string,
    tokenId: string,
  ): Promise<AccessTokenRecord | null> {
    const token = this.accessTokens.get(tokenId) ?? null;
    return token && token.userId === userId ? token : null;
  }

  async listAccessTokens(userId: string): Promise<AccessTokenRecord[]> {
    return [...this.accessTokens.values()]
      .filter((token) => token.userId === userId && token.revokedAt === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async insertAccessToken(token: AccessTokenRecord): Promise<void> {
    this.accessTokens.set(token.id, token);
  }

  async updateAccessTokenLastUsed(tokenId: string, lastUsedAt: string): Promise<void> {
    const token = this.accessTokens.get(tokenId);
    if (token) {
      token.lastUsedAt = lastUsedAt;
    }
  }

  async revokeAccessToken(tokenId: string, revokedAt: string): Promise<void> {
    const token = this.accessTokens.get(tokenId);
    if (token) {
      token.revokedAt = revokedAt;
    }
  }

  async getBookmarkByNormalizedUrl(
    userId: string,
    normalizedUrl: string,
  ): Promise<BookmarkRecord | null> {
    for (const bookmark of this.bookmarks.values()) {
      if (bookmark.userId === userId && bookmark.normalizedUrl === normalizedUrl) {
        return structuredClone(bookmark);
      }
    }
    return null;
  }

  async getBookmarkById(userId: string, id: string): Promise<BookmarkRecord | null> {
    const bookmark = this.bookmarks.get(id) ?? null;
    return bookmark && bookmark.userId === userId ? structuredClone(bookmark) : null;
  }

  async listBookmarks(
    userId: string,
    options: ListBookmarksOptions,
  ): Promise<ListBookmarksResult> {
    const cursor = decodeCursor(options.cursor);
    const query = options.q?.toLowerCase() ?? "";
    const filtered = [...this.bookmarks.values()]
      .filter((bookmark) => bookmark.userId === userId)
      .filter((bookmark) => {
        if (!query) {
          return true;
        }

        return [
          bookmark.title,
          bookmark.url,
          bookmark.siteName ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
      .sort((a, b) => {
        const created = b.createdAt.localeCompare(a.createdAt);
        if (created !== 0) {
          return created;
        }
        return b.id.localeCompare(a.id);
      })
      .filter((bookmark) => {
        if (!cursor) {
          return true;
        }
        return (
          bookmark.createdAt < cursor.createdAt ||
          (bookmark.createdAt === cursor.createdAt && bookmark.id < cursor.id)
        );
      });

    const slice = filtered.slice(0, options.limit + 1);
    const hasMore = slice.length > options.limit;
    const items = hasMore ? slice.slice(0, options.limit) : slice;
    const nextCursor = hasMore ? encodeCursor(items[items.length - 1]) : null;
    return { items: structuredClone(items), nextCursor };
  }

  async insertBookmark(bookmark: BookmarkRecord): Promise<void> {
    this.bookmarks.set(bookmark.id, structuredClone(bookmark));
  }

  async updateBookmark(bookmark: BookmarkRecord): Promise<void> {
    this.bookmarks.set(bookmark.id, structuredClone(bookmark));
  }

  async deleteBookmarkByNormalizedUrl(
    userId: string,
    normalizedUrl: string,
  ): Promise<void> {
    for (const [id, bookmark] of this.bookmarks.entries()) {
      if (bookmark.userId === userId && bookmark.normalizedUrl === normalizedUrl) {
        this.bookmarks.delete(id);
      }
    }
  }
}
