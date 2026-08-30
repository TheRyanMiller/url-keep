import type {
  BookmarkBucket,
  ContentSource,
  ExtractionStatus,
  InternalTitleSource,
  SavedVia,
  ReadyNarrationSummary,
} from "@url-keep/shared";

export type Bindings = {
  DB: D1Database;
  IMAGES?: R2Bucket;
  APP_ORIGIN?: string;
  DEBUG_LOGS?: string;
  API_ORIGIN?: string;
  TOKEN_PEPPER?: string;
  ALLOWED_EXTENSION_ORIGINS?: string;
  NARRATION_SERVICE_ORIGIN?: string;
  NARRATION_SERVICE_TOKEN?: string;
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
  title: string;
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
};

export type PublicShareLookupRecord = {
  bookmark: BookmarkRecord;
  content: ArticleContentRecord | null;
  share: BookmarkShareRecord;
};

export type ManifestListOptions = {
  limit: number;
  cursor?: string;
};

export type ManifestItemRecord = {
  bookmark: BookmarkRecord;
  content: ArticleContentRecord | null;
  narration: ReadyNarrationSummary | null;
};

export type ManifestResult = {
  items: ManifestItemRecord[];
  nextCursor: string | null;
};

export type ArticleBodyRecord = {
  articleId: string;
  contentHtml: string;
};

export type PublicArticleBodyRecord = ArticleBodyRecord;

export type NarrationStatus = "pending" | "ready" | "failed";

export type NarrationRecord = {
  id: string;
  articleId: string;
  serviceJobId: string;
  textSha256: string;
  status: NarrationStatus;
  retryCount: 0 | 1;
  engineFingerprint: string | null;
  errorCode: string | null;
  audioSha256: string | null;
  byteSize: number | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type ArticleContentWriteResult = {
  written: boolean;
  replacedServerContent: boolean;
};

export type AuthContext = {
  user: UserRecord;
  token: AccessTokenRecord;
};
