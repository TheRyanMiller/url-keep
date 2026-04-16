import type {
  BookmarkBucket,
  ContentSource,
  ExtractionStatus,
  InternalTitleSource,
  SavedVia,
} from "@url-keep/shared";

export type Bindings = {
  DB: D1Database;
  IMAGES?: R2Bucket;
  APP_ORIGIN?: string;
  DEBUG_LOGS?: string;
  API_ORIGIN?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD_HASH?: string;
  TOKEN_PEPPER?: string;
  ALLOWED_EXTENSION_ORIGINS?: string;
};

export type UserRecord = {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
};

export type AccessTokenRecord = {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type BookmarkRecord = {
  id: string;
  userId: string;
  url: string;
  normalizedUrl: string;
  bucket: BookmarkBucket;
  title: string;
  titleSource: InternalTitleSource;
  imageUrl: string | null;
  siteName: string | null;
  savedVia: SavedVia;
  createdAt: string;
  updatedAt: string;
  extractionStatus?: ExtractionStatus | null;
};

export type { ContentSource };

export type ArticleContentRecord = {
  id: string;
  bookmarkId: string;
  userId: string;
  contentHtml: string | null;
  wordCount: number;
  author: string | null;
  publishedDate: string | null;
  extractionStatus: ExtractionStatus;
  extractionError: string | null;
  extractedAt: string | null;
  contentSource: ContentSource | null;
  createdAt: string;
  updatedAt: string;
};

export type BookmarkShareRecord = {
  bookmarkId: string;
  userId: string;
  shareId: string;
  enabledAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastAccessedAt: string | null;
};

export type PublicShareLookupRecord = {
  bookmark: BookmarkRecord;
  content: ArticleContentRecord | null;
  share: BookmarkShareRecord;
};

export type ListBookmarksOptions = {
  q?: string;
  bucket?: BookmarkBucket;
  limit: number;
  cursor?: string;
};

export type ListBookmarksResult = {
  items: BookmarkRecord[];
  nextCursor: string | null;
};

export type OfflineBundleItemRecord = {
  bookmark: BookmarkRecord;
  content: ArticleContentRecord | null;
};

export type OfflineBundleResult = {
  items: OfflineBundleItemRecord[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type OfflineStatusResult = {
  bookmarkCount: number;
  latestUpdatedAt: string | null;
};

export type AuthContext = {
  user: UserRecord;
  token: AccessTokenRecord;
};
