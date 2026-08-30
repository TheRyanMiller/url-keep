import { decodeCursor, encodeCursor, nowIso } from "./utils";
import { classifyBookmarkUrl } from "@url-keep/shared";
import type {
  AccessTokenRecord,
  ArticleBodyRecord,
  ArticleContentWriteResult,
  ArticleContentRecord,
  BookmarkRecord,
  BookmarkShareRecord,
  AuthContext,
  ManifestListOptions,
  ManifestResult,
  PublicShareLookupRecord,
  PublicArticleBodyRecord,
  UserRecord,
} from "./types";
import { InvalidCursorError, type Store } from "./store";

export class MemoryStore implements Store {
  private users = new Map<string, UserRecord>();
  private accessTokens = new Map<string, AccessTokenRecord>();
  private bookmarks = new Map<string, BookmarkRecord>();
  private articleContent = new Map<string, ArticleContentRecord>();
  private bookmarkShares = new Map<string, BookmarkShareRecord>();
  private offlineRevisions = new Map<string, number>();

  private bumpOfflineRevision(userId: string) {
    this.offlineRevisions.set(userId, (this.offlineRevisions.get(userId) ?? 0) + 1);
  }

  private revokeBookmarkShare(userId: string, bookmarkId: string) {
    const share = this.bookmarkShares.get(bookmarkId);
    if (share?.userId === userId) {
      this.bookmarkShares.delete(bookmarkId);
    }
  }

  private sameBookmark(left: BookmarkRecord | undefined, right: BookmarkRecord): boolean {
    return Boolean(left)
      && left!.url === right.url
      && left!.normalizedUrl === right.normalizedUrl
      && left!.bucket === right.bucket
      && left!.title === right.title
      && left!.titleSource === right.titleSource
      && left!.imageUrl === right.imageUrl
      && left!.siteName === right.siteName
      && left!.savedVia === right.savedVia
      && left!.createdAt === right.createdAt
      && left!.updatedAt === right.updatedAt;
  }

  private sameArticle(
    left: ArticleContentRecord | undefined,
    right: ArticleContentRecord,
  ): boolean {
    return Boolean(left)
      && left!.id === right.id
      && left!.bookmarkId === right.bookmarkId
      && left!.userId === right.userId
      && left!.title === right.title
      && left!.contentHtml === right.contentHtml
      && left!.wordCount === right.wordCount
      && left!.author === right.author
      && left!.publishedDate === right.publishedDate
      && left!.extractionStatus === right.extractionStatus
      && left!.extractionError === right.extractionError
      && left!.extractedAt === right.extractedAt
      && left!.contentSource === right.contentSource
      && left!.createdAt === right.createdAt
      && left!.updatedAt === right.updatedAt;
  }

  async getSyncRevision(userId: string): Promise<number> {
    return this.offlineRevisions.get(userId) ?? 0;
  }

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

  async updateUserPasswordHash(userId: string, passwordHash: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) {
      user.passwordHash = passwordHash;
    }
  }

  async getAccessTokenByHash(tokenHash: string): Promise<AccessTokenRecord | null> {
    for (const token of this.accessTokens.values()) {
      if (token.tokenHash === tokenHash) {
        return token;
      }
    }
    return null;
  }

  async getAuthByTokenHash(tokenHash: string): Promise<AuthContext | null> {
    const token = await this.getAccessTokenByHash(tokenHash);
    if (!token) return null;
    const user = this.users.get(token.userId);
    return user ? { user, token } : null;
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

  private attachExtractionStatus(bookmark: BookmarkRecord): BookmarkRecord {
    const content = this.articleContent.get(bookmark.id);
    const classification = classifyBookmarkUrl(bookmark.normalizedUrl);
    return {
      ...structuredClone(bookmark),
      bucket: bookmark.bucket ?? classification.bucket,
      extractionStatus: classification.autoExtract
        ? content?.extractionStatus ?? null
        : null,
    };
  }

  async getBookmarkByNormalizedUrl(
    userId: string,
    normalizedUrl: string,
  ): Promise<BookmarkRecord | null> {
    for (const bookmark of this.bookmarks.values()) {
      if (bookmark.userId === userId && bookmark.normalizedUrl === normalizedUrl) {
        return this.attachExtractionStatus(bookmark);
      }
    }
    return null;
  }

  async getBookmarkById(userId: string, id: string): Promise<BookmarkRecord | null> {
    const bookmark = this.bookmarks.get(id) ?? null;
    return bookmark && bookmark.userId === userId
      ? this.attachExtractionStatus(bookmark)
      : null;
  }

  async listManifest(
    userId: string,
    options: ManifestListOptions,
  ): Promise<ManifestResult> {
    const cursor = decodeCursor(options.cursor);
    if (options.cursor && !cursor) throw new InvalidCursorError();
    const filtered = [...this.bookmarks.values()]
      .filter((bookmark) => bookmark.userId === userId)
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
    return {
      items: items.map((bookmark) => ({
        bookmark: this.attachExtractionStatus(bookmark),
        content: structuredClone(this.articleContent.get(bookmark.id) ?? null),
        narration: null,
      })),
      nextCursor: hasMore ? encodeCursor(items[items.length - 1]) : null,
    };
  }

  async insertBookmark(bookmark: BookmarkRecord): Promise<void> {
    this.bookmarks.set(bookmark.id, structuredClone(bookmark));
    this.bumpOfflineRevision(bookmark.userId);
  }

  async updateBookmark(bookmark: BookmarkRecord): Promise<void> {
    const existing = this.bookmarks.get(bookmark.id);
    this.bookmarks.set(bookmark.id, structuredClone(bookmark));
    if (!this.sameBookmark(existing, bookmark)) {
      this.bumpOfflineRevision(bookmark.userId);
    }
  }

  async getBookmarkShare(
    userId: string,
    bookmarkId: string,
  ): Promise<BookmarkShareRecord | null> {
    const share = this.bookmarkShares.get(bookmarkId) ?? null;
    return share && share.userId === userId ? structuredClone(share) : null;
  }

  async enableBookmarkShare(
    userId: string,
    bookmarkId: string,
    shareId: string,
    enabledAt: string,
  ): Promise<BookmarkShareRecord | null> {
    const bookmark = this.bookmarks.get(bookmarkId) ?? null;
    if (!bookmark || bookmark.userId !== userId) {
      return null;
    }

    const share: BookmarkShareRecord = {
      bookmarkId,
      userId,
      shareId,
      enabledAt,
      revokedAt: null,
    };
    this.bookmarkShares.set(bookmarkId, structuredClone(share));
    return share;
  }

  async disableBookmarkShare(userId: string, bookmarkId: string, revokedAt: string): Promise<void> {
    const share = this.bookmarkShares.get(bookmarkId);
    if (share?.userId === userId) {
      share.revokedAt = revokedAt;
      this.bookmarkShares.delete(bookmarkId);
    }
  }

  async getPublicShareById(shareId: string): Promise<PublicShareLookupRecord | null> {
    for (const share of this.bookmarkShares.values()) {
      if (share.shareId !== shareId || share.revokedAt) {
        continue;
      }

      const bookmark = this.bookmarks.get(share.bookmarkId) ?? null;
      if (!bookmark) {
        return null;
      }

      return {
        bookmark: this.attachExtractionStatus(bookmark),
        content: structuredClone(this.articleContent.get(bookmark.id) ?? null),
        share: structuredClone(share),
      };
    }

    return null;
  }

  async getPublicShareBodyById(
    shareId: string,
  ): Promise<PublicArticleBodyRecord | null> {
    const result = await this.getPublicShareById(shareId);
    const content = result?.content;
    return content?.extractionStatus === "complete" && content.contentHtml
      ? { articleId: content.id, contentHtml: content.contentHtml }
      : null;
  }

  async getArticleContentByBookmarkId(
    userId: string,
    bookmarkId: string,
  ): Promise<ArticleContentRecord | null> {
    const content = this.articleContent.get(bookmarkId) ?? null;
    return content && content.userId === userId ? structuredClone(content) : null;
  }

  async getArticleBodyById(
    userId: string,
    articleId: string,
  ): Promise<ArticleBodyRecord | null> {
    for (const content of this.articleContent.values()) {
      if (
        content.userId === userId
        && content.id === articleId
        && content.extractionStatus === "complete"
        && content.contentHtml
      ) {
        return { articleId: content.id, contentHtml: content.contentHtml };
      }
    }
    return null;
  }

  private putArticleContent(
    content: ArticleContentRecord,
    bookmark: BookmarkRecord | undefined,
    source: "client" | "server",
    expectedArticleId: string | null,
  ): ArticleContentWriteResult {
    const existing = this.articleContent.get(content.bookmarkId);
    if (
      source === "server"
      && existing?.contentSource === "client"
      && existing.extractionStatus === "complete"
    ) {
      return { written: false, replacedServerContent: false };
    }
    if (
      source === "server"
      && (expectedArticleId === null ? Boolean(existing) : existing?.id !== expectedArticleId)
    ) {
      return { written: false, replacedServerContent: false };
    }

    const next = {
      ...structuredClone(content),
      contentSource: content.contentSource ?? null,
      createdAt: content.createdAt ?? nowIso(),
      updatedAt: content.updatedAt ?? nowIso(),
    };
    const contentChanged = !this.sameArticle(existing, next);
    this.articleContent.set(content.bookmarkId, next);

    if (bookmark) {
      const existingBookmark = this.bookmarks.get(bookmark.id);
      this.bookmarks.set(bookmark.id, structuredClone(bookmark));
      if (!this.sameBookmark(existingBookmark, bookmark)) {
        this.bumpOfflineRevision(bookmark.userId);
      }
    }

    if (contentChanged) {
      this.bumpOfflineRevision(content.userId);
      this.revokeBookmarkShare(content.userId, content.bookmarkId);
    }
    return {
      written: true,
      replacedServerContent: existing?.contentSource === "server",
    };
  }

  async putClientArticleContent(
    content: ArticleContentRecord,
    bookmark?: BookmarkRecord,
  ): Promise<ArticleContentWriteResult> {
    return this.putArticleContent(content, bookmark, "client", null);
  }

  async putServerArticleContent(
    content: ArticleContentRecord,
    bookmark: BookmarkRecord | undefined,
    expectedArticleId: string | null,
  ): Promise<ArticleContentWriteResult> {
    return this.putArticleContent(content, bookmark, "server", expectedArticleId);
  }

  async recordServerArticleFailure(
    content: ArticleContentRecord,
    expectedArticleId: string | null,
  ): Promise<ArticleContentWriteResult> {
    return this.putArticleContent(content, undefined, "server", expectedArticleId);
  }

  async deleteBookmarkByNormalizedUrl(
    userId: string,
    normalizedUrl: string,
  ): Promise<BookmarkRecord | null> {
    for (const [id, bookmark] of this.bookmarks.entries()) {
      if (bookmark.userId === userId && bookmark.normalizedUrl === normalizedUrl) {
        this.bookmarks.delete(id);
        if (this.articleContent.delete(id)) {
          this.bumpOfflineRevision(userId);
        }
        this.bookmarkShares.delete(id);
        this.bumpOfflineRevision(userId);
        return this.attachExtractionStatus(bookmark);
      }
    }

    return null;
  }
}
