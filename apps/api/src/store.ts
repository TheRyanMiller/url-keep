import type {
  AccessTokenRecord,
  ArticleContentRecord,
  BookmarkRecord,
  ListBookmarksOptions,
  ListBookmarksResult,
  OfflineBundleResult,
  UserRecord,
} from "./types";

export interface Store {
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
  getArticleContentByBookmarkId(
    userId: string,
    bookmarkId: string,
  ): Promise<ArticleContentRecord | null>;
  upsertArticleContent(content: ArticleContentRecord): Promise<void>;
  deleteBookmarkContent(userId: string, bookmarkId: string): Promise<void>;
  deleteBookmarkByNormalizedUrl(
    userId: string,
    normalizedUrl: string,
  ): Promise<BookmarkRecord | null>;
}
