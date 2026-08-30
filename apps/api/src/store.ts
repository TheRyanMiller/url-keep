import type {
  AccessTokenRecord,
  ArticleContentDeleteResult,
  ArticleContentWriteResult,
  ArticleContentRecord,
  BookmarkRecord,
  BookmarkShareRecord,
  ListBookmarksOptions,
  ListBookmarksResult,
  OfflineBundleResult,
  OfflineStatusResult,
  PublicShareLookupRecord,
  UserRecord,
} from "./types";

export interface Store {
  getOfflineStatus(userId: string): Promise<OfflineStatusResult>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserById(id: string): Promise<UserRecord | null>;
  insertUser(user: UserRecord): Promise<void>;
  updateUserPasswordHash(userId: string, passwordHash: string): Promise<void>;
  getAccessTokenByHash(tokenHash: string): Promise<AccessTokenRecord | null>;
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
  listBookmarks(
    userId: string,
    options: ListBookmarksOptions,
  ): Promise<ListBookmarksResult>;
  listOfflineBundle(
    userId: string,
    options: Pick<ListBookmarksOptions, "limit" | "cursor">,
  ): Promise<OfflineBundleResult>;
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
  recordBookmarkShareHit(bookmarkId: string, accessedAt: string): Promise<void>;
  getArticleContentByBookmarkId(
    userId: string,
    bookmarkId: string,
  ): Promise<ArticleContentRecord | null>;
  putClientArticleContent(
    content: ArticleContentRecord,
    bookmark?: BookmarkRecord,
  ): Promise<ArticleContentWriteResult>;
  putServerArticleContent(
    content: ArticleContentRecord,
    bookmark?: BookmarkRecord,
    expectedArticleId?: string | null,
  ): Promise<ArticleContentWriteResult>;
  recordServerArticleFailure(
    content: ArticleContentRecord,
    expectedArticleId: string | null,
  ): Promise<ArticleContentWriteResult>;
  deleteArticleContent(
    userId: string,
    bookmarkId: string,
  ): Promise<ArticleContentDeleteResult>;
  deleteBookmarkByNormalizedUrl(
    userId: string,
    normalizedUrl: string,
  ): Promise<BookmarkRecord | null>;
}
