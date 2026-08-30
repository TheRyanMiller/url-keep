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

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid manifest cursor");
    this.name = "InvalidCursorError";
  }
}

export interface Store {
  getSyncRevision(userId: string): Promise<number>;
  listManifest(
    userId: string,
    options: ManifestListOptions,
  ): Promise<ManifestResult>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserById(id: string): Promise<UserRecord | null>;
  insertUser(user: UserRecord): Promise<void>;
  updateUserPasswordHash(userId: string, passwordHash: string): Promise<void>;
  getAccessTokenByHash(tokenHash: string): Promise<AccessTokenRecord | null>;
  getAuthByTokenHash(tokenHash: string): Promise<AuthContext | null>;
  getAccessTokenById(
    userId: string,
    tokenId: string,
  ): Promise<AccessTokenRecord | null>;
  listAccessTokens(userId: string): Promise<AccessTokenRecord[]>;
  insertAccessToken(token: AccessTokenRecord): Promise<void>;
  updateAccessTokenLastUsed(tokenId: string, lastUsedAt: string): Promise<void>;
  revokeAccessToken(tokenId: string, revokedAt: string): Promise<void>;
  getBookmarkByNormalizedUrl(
    userId: string,
    normalizedUrl: string,
  ): Promise<BookmarkRecord | null>;
  getBookmarkById(userId: string, id: string): Promise<BookmarkRecord | null>;
  insertBookmark(bookmark: BookmarkRecord): Promise<void>;
  updateBookmark(bookmark: BookmarkRecord): Promise<void>;
  getBookmarkShare(userId: string, bookmarkId: string): Promise<BookmarkShareRecord | null>;
  enableBookmarkShare(
    userId: string,
    bookmarkId: string,
    shareId: string,
    enabledAt: string,
  ): Promise<BookmarkShareRecord | null>;
  disableBookmarkShare(userId: string, bookmarkId: string, revokedAt: string): Promise<void>;
  getPublicShareById(shareId: string): Promise<PublicShareLookupRecord | null>;
  getPublicShareBodyById(shareId: string): Promise<PublicArticleBodyRecord | null>;
  getArticleContentByBookmarkId(
    userId: string,
    bookmarkId: string,
  ): Promise<ArticleContentRecord | null>;
  getArticleBodyById(userId: string, articleId: string): Promise<ArticleBodyRecord | null>;
  putClientArticleContent(
    content: ArticleContentRecord,
    bookmark?: BookmarkRecord,
  ): Promise<ArticleContentWriteResult>;
  putServerArticleContent(
    content: ArticleContentRecord,
    bookmark: BookmarkRecord | undefined,
    expectedArticleId: string | null,
  ): Promise<ArticleContentWriteResult>;
  recordServerArticleFailure(
    content: ArticleContentRecord,
    expectedArticleId: string | null,
  ): Promise<ArticleContentWriteResult>;
  deleteBookmarkByNormalizedUrl(
    userId: string,
    normalizedUrl: string,
  ): Promise<BookmarkRecord | null>;
}
