import { decodeCursor, encodeCursor } from "./utils";
import { classifyBookmarkUrl } from "@url-keep/shared";
import type { Store } from "./store";
import type {
  AccessTokenRecord,
  ArticleContentRecord,
  BookmarkRecord,
  BookmarkShareRecord,
  ListBookmarksOptions,
  ListBookmarksResult,
  OfflineBundleItemRecord,
  OfflineBundleResult,
  OfflineStatusResult,
  PublicShareLookupRecord,
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
  bucket: BookmarkRecord["bucket"] | null;
  title: string;
  title_source: BookmarkRecord["titleSource"];
  image_url: string | null;
  site_name: string | null;
  saved_via: BookmarkRecord["savedVia"];
  created_at: string;
  updated_at: string;
  extraction_status: BookmarkRecord["extractionStatus"];
};

type ArticleContentRow = {
  content_id: string | null;
  bookmark_id: string | null;
  content_user_id: string | null;
  content_html: string | null;
  word_count: number | null;
  author: string | null;
  published_date: string | null;
  content_extraction_status: ArticleContentRecord["extractionStatus"] | null;
  extraction_error: string | null;
  extracted_at: string | null;
  content_source: ArticleContentRecord["contentSource"] | null;
  content_created_at: string | null;
  content_updated_at: string | null;
};

type BookmarkShareRow = {
  share_id: string | null;
  share_enabled_at: string | null;
  share_revoked_at: string | null;
  share_view_count: number | null;
  share_last_accessed_at: string | null;
};

type BookmarkWithContentRow = BookmarkRow & ArticleContentRow;
type PublicShareRow = BookmarkRow & ArticleContentRow & BookmarkShareRow;

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
  const classification = row ? classifyBookmarkUrl(row.normalized_url) : null;

  return row
    ? {
        id: row.id,
        userId: row.user_id,
        url: row.url,
        normalizedUrl: row.normalized_url,
        bucket: row.bucket ?? classification?.bucket ?? "reading",
        title: row.title,
        titleSource: row.title_source,
        imageUrl: row.image_url,
        siteName: row.site_name,
        savedVia: row.saved_via,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        extractionStatus: classification?.autoExtract
          ? row.extraction_status ?? null
          : null,
      }
    : null;
}

function mapArticleContent(row: ArticleContentRow | null): ArticleContentRecord | null {
  return row?.content_id && row.bookmark_id && row.content_user_id
    ? {
        id: row.content_id,
        bookmarkId: row.bookmark_id,
        userId: row.content_user_id,
        contentHtml: row.content_html,
        wordCount: row.word_count ?? 0,
        author: row.author,
        publishedDate: row.published_date,
        extractionStatus: row.content_extraction_status ?? "pending",
        extractionError: row.extraction_error,
        extractedAt: row.extracted_at,
        contentSource: row.content_source ?? null,
        createdAt: row.content_created_at ?? row.extracted_at ?? row.content_updated_at ?? "",
        updatedAt: row.content_updated_at ?? row.extracted_at ?? row.content_created_at ?? "",
      }
    : null;
}

function mapBookmarkShare(
  row: BookmarkShareRow | null,
  bookmark: Pick<BookmarkRecord, "id" | "userId">,
): BookmarkShareRecord | null {
  return row?.share_id && row.share_enabled_at && !row.share_revoked_at
    ? {
        bookmarkId: bookmark.id,
        userId: bookmark.userId,
        shareId: row.share_id,
        enabledAt: row.share_enabled_at,
        revokedAt: row.share_revoked_at,
        viewCount: row.share_view_count ?? 0,
        lastAccessedAt: row.share_last_accessed_at,
      }
    : null;
}

function bookmarkSelectSql() {
  return `
    SELECT
      b.id,
      b.user_id,
      b.url,
      b.normalized_url,
      b.bucket,
      b.title,
      b.title_source,
      b.image_url,
      b.site_name,
      b.saved_via,
      b.created_at,
      b.updated_at,
      ac.extraction_status AS extraction_status
    FROM bookmarks b
    LEFT JOIN article_content ac ON ac.bookmark_id = b.id
  `;
}

function bookmarkShareSelectSql(alias?: string) {
  const prefix = alias ? `${alias}.` : "";
  return `
    ${prefix}share_id,
    ${prefix}share_enabled_at,
    ${prefix}share_revoked_at,
    ${prefix}share_view_count,
    ${prefix}share_last_accessed_at
  `;
}

function articleContentSelectSql() {
  return `
    ac.id AS content_id,
    ac.bookmark_id,
    ac.user_id AS content_user_id,
    ac.content_html,
    ac.word_count,
    ac.author,
    ac.published_date,
    ac.extraction_status AS content_extraction_status,
    ac.extraction_error,
    ac.extracted_at,
    ac.content_source,
    ac.created_at AS content_created_at,
    ac.updated_at AS content_updated_at
  `;
}

export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  async getOfflineStatus(userId: string): Promise<OfflineStatusResult> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS cnt, MAX(updated_at) AS latest FROM bookmarks WHERE user_id = ?",
      )
      .bind(userId)
      .first<{ cnt: number; latest: string | null }>();
    return {
      bookmarkCount: row?.cnt ?? 0,
      latestUpdatedAt: row?.latest ?? null,
    };
  }

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

  async updateUserPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.db
      .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(passwordHash, userId)
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
        `${bookmarkSelectSql()} WHERE b.user_id = ? AND b.normalized_url = ? LIMIT 1`,
      )
      .bind(userId, normalizedUrl)
      .first<BookmarkRow>();
    return mapBookmark(row ?? null);
  }

  async getBookmarkById(userId: string, id: string): Promise<BookmarkRecord | null> {
    const row = await this.db
      .prepare(
        `${bookmarkSelectSql()} WHERE b.user_id = ? AND b.id = ? LIMIT 1`,
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
    const clauses = ["b.user_id = ?"];
    const bindings: Array<string | number> = [userId];

    if (options.q) {
      const needle = `%${options.q.toLowerCase()}%`;
      clauses.push(
        "(LOWER(b.title) LIKE ? OR LOWER(b.url) LIKE ? OR LOWER(COALESCE(b.site_name, '')) LIKE ?)",
      );
      bindings.push(needle, needle, needle);
    }

    if (options.bucket) {
      clauses.push("b.bucket = ?");
      bindings.push(options.bucket);
    }

    if (cursor) {
      clauses.push("(b.created_at < ? OR (b.created_at = ? AND b.id < ?))");
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    bindings.push(options.limit + 1);

    const sql = `
      ${bookmarkSelectSql()}
      WHERE ${clauses.join(" AND ")}
      ORDER BY b.created_at DESC, b.id DESC
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

  async listOfflineBundle(
    userId: string,
    options: Pick<ListBookmarksOptions, "limit" | "cursor">,
  ): Promise<OfflineBundleResult> {
    const cursor = decodeCursor(options.cursor);
    const clauses = ["b.user_id = ?"];
    const bindings: Array<string | number> = [userId];

    if (cursor) {
      clauses.push("(b.created_at < ? OR (b.created_at = ? AND b.id < ?))");
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    bindings.push(options.limit + 1);

    const sql = `
      SELECT
        b.id,
        b.user_id,
        b.url,
        b.normalized_url,
        b.bucket,
        b.title,
        b.title_source,
        b.image_url,
        b.site_name,
        b.saved_via,
        b.created_at,
        b.updated_at,
        ac.extraction_status AS extraction_status,
        ${articleContentSelectSql()}
      FROM bookmarks b
      LEFT JOIN article_content ac ON ac.bookmark_id = b.id
      WHERE ${clauses.join(" AND ")}
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ?
    `;

    const result = await this.db.prepare(sql).bind(...bindings).all<BookmarkWithContentRow>();
    const rows = (result.results ?? []).filter(Boolean);
    const hasMore = rows.length > options.limit;
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
    const items = pageRows.map<OfflineBundleItemRecord>((row) => ({
      bookmark: mapBookmark(row)!,
      content: mapArticleContent(row),
    }));
    const nextCursor = hasMore
      ? encodeCursor(items[items.length - 1].bookmark)
      : null;

    return {
      items,
      nextCursor,
      hasMore,
    };
  }

  async insertBookmark(bookmark: BookmarkRecord): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO bookmarks (id, user_id, url, normalized_url, bucket, title, title_source, image_url, site_name, saved_via, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        bookmark.id,
        bookmark.userId,
        bookmark.url,
        bookmark.normalizedUrl,
        bookmark.bucket,
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
        "UPDATE bookmarks SET url = ?, normalized_url = ?, bucket = ?, title = ?, title_source = ?, image_url = ?, site_name = ?, saved_via = ?, updated_at = ? WHERE id = ? AND user_id = ?",
      )
      .bind(
        bookmark.url,
        bookmark.normalizedUrl,
        bookmark.bucket,
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

  async getBookmarkShare(
    userId: string,
    bookmarkId: string,
  ): Promise<BookmarkShareRecord | null> {
    const row = await this.db
      .prepare(
        `
          SELECT
            id,
            user_id,
            ${bookmarkShareSelectSql()}
          FROM bookmarks
          WHERE user_id = ? AND id = ?
          LIMIT 1
        `,
      )
      .bind(userId, bookmarkId)
      .first<
        Pick<BookmarkRow, "id" | "user_id"> & BookmarkShareRow
      >();

    if (!row) {
      return null;
    }

    return mapBookmarkShare(row, {
      id: row.id,
      userId: row.user_id,
    });
  }

  async enableBookmarkShare(
    userId: string,
    bookmarkId: string,
    shareId: string,
    enabledAt: string,
  ): Promise<BookmarkShareRecord | null> {
    await this.db
      .prepare(
        `
          UPDATE bookmarks
          SET
            share_id = ?,
            share_enabled_at = ?,
            share_revoked_at = NULL,
            share_view_count = 0,
            share_last_accessed_at = NULL
          WHERE user_id = ? AND id = ?
        `,
      )
      .bind(shareId, enabledAt, userId, bookmarkId)
      .run();

    return this.getBookmarkShare(userId, bookmarkId);
  }

  async disableBookmarkShare(userId: string, bookmarkId: string, revokedAt: string): Promise<void> {
    await this.db
      .prepare(
        `
          UPDATE bookmarks
          SET
            share_id = NULL,
            share_enabled_at = NULL,
            share_revoked_at = ?,
            share_view_count = 0,
            share_last_accessed_at = NULL
          WHERE user_id = ? AND id = ?
        `,
      )
      .bind(revokedAt, userId, bookmarkId)
      .run();
  }

  async getPublicShareById(shareId: string): Promise<PublicShareLookupRecord | null> {
    const row = await this.db
      .prepare(
        `
          SELECT
            b.id,
            b.user_id,
            b.bucket,
            b.url,
            b.normalized_url,
            b.title,
            b.title_source,
            b.image_url,
            b.site_name,
            b.saved_via,
            b.created_at,
            b.updated_at,
            ac.extraction_status AS extraction_status,
            ${bookmarkShareSelectSql("b")},
            ${articleContentSelectSql()}
          FROM bookmarks b
          LEFT JOIN article_content ac ON ac.bookmark_id = b.id
          WHERE b.share_id = ? AND b.share_enabled_at IS NOT NULL AND b.share_revoked_at IS NULL
          LIMIT 1
        `,
      )
      .bind(shareId)
      .first<PublicShareRow>();

    if (!row) {
      return null;
    }

    const bookmark = mapBookmark(row);
    if (!bookmark) {
      return null;
    }

    const share = mapBookmarkShare(row, bookmark);
    if (!share) {
      return null;
    }

    return {
      bookmark,
      content: mapArticleContent(row),
      share,
    };
  }

  async recordBookmarkShareHit(bookmarkId: string, accessedAt: string): Promise<void> {
    await this.db
      .prepare(
        `
          UPDATE bookmarks
          SET
            share_view_count = share_view_count + 1,
            share_last_accessed_at = ?
          WHERE id = ? AND share_id IS NOT NULL
        `,
      )
      .bind(accessedAt, bookmarkId)
      .run();
  }

  async getArticleContentByBookmarkId(
    userId: string,
    bookmarkId: string,
  ): Promise<ArticleContentRecord | null> {
    const row = await this.db
      .prepare(
        `
          SELECT ${articleContentSelectSql()}
          FROM article_content ac
          WHERE ac.user_id = ? AND ac.bookmark_id = ?
          LIMIT 1
        `,
      )
      .bind(userId, bookmarkId)
      .first<ArticleContentRow>();
    return mapArticleContent(row ?? null);
  }

  async upsertArticleContent(content: ArticleContentRecord): Promise<void> {
    await this.db
      .prepare(
        `
          INSERT INTO article_content (
            id,
            bookmark_id,
            user_id,
            content_html,
            word_count,
            author,
            published_date,
            extraction_status,
            extraction_error,
            extracted_at,
            content_source,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(bookmark_id) DO UPDATE SET
            id = excluded.id,
            user_id = excluded.user_id,
            content_html = excluded.content_html,
            word_count = excluded.word_count,
            author = excluded.author,
            published_date = excluded.published_date,
            extraction_status = excluded.extraction_status,
            extraction_error = excluded.extraction_error,
            extracted_at = excluded.extracted_at,
            content_source = excluded.content_source,
            updated_at = excluded.updated_at
        `,
      )
      .bind(
        content.id,
        content.bookmarkId,
        content.userId,
        content.contentHtml,
        content.wordCount,
        content.author,
        content.publishedDate,
        content.extractionStatus,
        content.extractionError,
        content.extractedAt,
        content.contentSource,
        content.createdAt,
        content.updatedAt,
      )
      .run();
  }

  async deleteBookmarkContent(userId: string, bookmarkId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM article_content WHERE user_id = ? AND bookmark_id = ?")
      .bind(userId, bookmarkId)
      .run();
  }

  async deleteBookmarkByNormalizedUrl(
    userId: string,
    normalizedUrl: string,
  ): Promise<BookmarkRecord | null> {
    const bookmark = await this.getBookmarkByNormalizedUrl(userId, normalizedUrl);
    if (!bookmark) {
      return null;
    }

    await this.db
      .prepare("DELETE FROM bookmarks WHERE user_id = ? AND normalized_url = ?")
      .bind(userId, normalizedUrl)
      .run();

    return bookmark;
  }
}
