import { decodeCursor, encodeCursor } from "./utils";
import type { Store } from "./store";
import type {
  AccessTokenRecord,
  BookmarkRecord,
  ListBookmarksOptions,
  ListBookmarksResult,
  UserRecord,
} from "./types";

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
};

type AccessTokenRow = {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

type BookmarkRow = {
  id: string;
  user_id: string;
  url: string;
  normalized_url: string;
  title: string;
  title_source: BookmarkRecord["titleSource"];
  image_url: string | null;
  site_name: string | null;
  saved_via: BookmarkRecord["savedVia"];
  created_at: string;
  updated_at: string;
};

function mapUser(row: UserRow | null): UserRecord | null {
  return row
    ? {
        id: row.id,
        email: row.email,
        passwordHash: row.password_hash,
        createdAt: row.created_at,
      }
    : null;
}

function mapAccessToken(row: AccessTokenRow | null): AccessTokenRecord | null {
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        tokenHash: row.token_hash,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
      }
    : null;
}

function mapBookmark(row: BookmarkRow | null): BookmarkRecord | null {
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        url: row.url,
        normalizedUrl: row.normalized_url,
        title: row.title,
        titleSource: row.title_source,
        imageUrl: row.image_url,
        siteName: row.site_name,
        savedVia: row.saved_via,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT id, email, password_hash, created_at FROM users WHERE email = ? LIMIT 1",
      )
      .bind(email)
      .first<UserRow>();
    return mapUser(row ?? null);
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT id, email, password_hash, created_at FROM users WHERE id = ? LIMIT 1",
      )
      .bind(id)
      .first<UserRow>();
    return mapUser(row ?? null);
  }

  async insertUser(user: UserRecord): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(user.id, user.email, user.passwordHash, user.createdAt)
      .run();
  }

  async getAccessTokenByHash(tokenHash: string): Promise<AccessTokenRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT id, user_id, name, token_hash, created_at, last_used_at, revoked_at FROM access_tokens WHERE token_hash = ? LIMIT 1",
      )
      .bind(tokenHash)
      .first<AccessTokenRow>();
    return mapAccessToken(row ?? null);
  }

  async getAccessTokenById(
    userId: string,
    tokenId: string,
  ): Promise<AccessTokenRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT id, user_id, name, token_hash, created_at, last_used_at, revoked_at FROM access_tokens WHERE id = ? AND user_id = ? LIMIT 1",
      )
      .bind(tokenId, userId)
      .first<AccessTokenRow>();
    return mapAccessToken(row ?? null);
  }

  async listAccessTokens(userId: string): Promise<AccessTokenRecord[]> {
    const result = await this.db
      .prepare(
        "SELECT id, user_id, name, token_hash, created_at, last_used_at, revoked_at FROM access_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
      )
      .bind(userId)
      .all<AccessTokenRow>();

    return (result.results ?? [])
      .map((row) => mapAccessToken(row)!)
      .filter(Boolean);
  }

  async insertAccessToken(token: AccessTokenRecord): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO access_tokens (id, user_id, name, token_hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        token.id,
        token.userId,
        token.name,
        token.tokenHash,
        token.createdAt,
        token.lastUsedAt,
        token.revokedAt,
      )
      .run();
  }

  async updateAccessTokenLastUsed(tokenId: string, lastUsedAt: string): Promise<void> {
    await this.db
      .prepare("UPDATE access_tokens SET last_used_at = ? WHERE id = ?")
      .bind(lastUsedAt, tokenId)
      .run();
  }

  async revokeAccessToken(tokenId: string, revokedAt: string): Promise<void> {
    await this.db
      .prepare("UPDATE access_tokens SET revoked_at = ? WHERE id = ?")
      .bind(revokedAt, tokenId)
      .run();
  }

  async getBookmarkByNormalizedUrl(
    userId: string,
    normalizedUrl: string,
  ): Promise<BookmarkRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT id, user_id, url, normalized_url, title, title_source, image_url, site_name, saved_via, created_at, updated_at FROM bookmarks WHERE user_id = ? AND normalized_url = ? LIMIT 1",
      )
      .bind(userId, normalizedUrl)
      .first<BookmarkRow>();
    return mapBookmark(row ?? null);
  }

  async getBookmarkById(userId: string, id: string): Promise<BookmarkRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT id, user_id, url, normalized_url, title, title_source, image_url, site_name, saved_via, created_at, updated_at FROM bookmarks WHERE user_id = ? AND id = ? LIMIT 1",
      )
      .bind(userId, id)
      .first<BookmarkRow>();
    return mapBookmark(row ?? null);
  }

  async listBookmarks(
    userId: string,
    options: ListBookmarksOptions,
  ): Promise<ListBookmarksResult> {
    const cursor = decodeCursor(options.cursor);
    const clauses = ["user_id = ?"];
    const bindings: Array<string | number> = [userId];

    if (options.q) {
      const needle = `%${options.q.toLowerCase()}%`;
      clauses.push(
        "(LOWER(title) LIKE ? OR LOWER(url) LIKE ? OR LOWER(COALESCE(site_name, '')) LIKE ?)",
      );
      bindings.push(needle, needle, needle);
    }

    if (cursor) {
      clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    bindings.push(options.limit + 1);

    const sql = `
      SELECT id, user_id, url, normalized_url, title, title_source, image_url, site_name, saved_via, created_at, updated_at
      FROM bookmarks
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `;

    const result = await this.db.prepare(sql).bind(...bindings).all<BookmarkRow>();
    const allRows = (result.results ?? [])
      .map((row) => mapBookmark(row)!)
      .filter(Boolean);
    const hasMore = allRows.length > options.limit;
    const items = hasMore ? allRows.slice(0, options.limit) : allRows;
    const nextCursor = hasMore ? encodeCursor(items[items.length - 1]) : null;
    return { items, nextCursor };
  }

  async insertBookmark(bookmark: BookmarkRecord): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO bookmarks (id, user_id, url, normalized_url, title, title_source, image_url, site_name, saved_via, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        bookmark.id,
        bookmark.userId,
        bookmark.url,
        bookmark.normalizedUrl,
        bookmark.title,
        bookmark.titleSource,
        bookmark.imageUrl,
        bookmark.siteName,
        bookmark.savedVia,
        bookmark.createdAt,
        bookmark.updatedAt,
      )
      .run();
  }

  async updateBookmark(bookmark: BookmarkRecord): Promise<void> {
    await this.db
      .prepare(
        "UPDATE bookmarks SET url = ?, normalized_url = ?, title = ?, title_source = ?, image_url = ?, site_name = ?, saved_via = ?, updated_at = ? WHERE id = ? AND user_id = ?",
      )
      .bind(
        bookmark.url,
        bookmark.normalizedUrl,
        bookmark.title,
        bookmark.titleSource,
        bookmark.imageUrl,
        bookmark.siteName,
        bookmark.savedVia,
        bookmark.updatedAt,
        bookmark.id,
        bookmark.userId,
      )
      .run();
  }

  async deleteBookmarkByNormalizedUrl(
    userId: string,
    normalizedUrl: string,
  ): Promise<void> {
    await this.db
      .prepare("DELETE FROM bookmarks WHERE user_id = ? AND normalized_url = ?")
      .bind(userId, normalizedUrl)
      .run();
  }
}
