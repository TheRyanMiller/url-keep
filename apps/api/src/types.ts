import type { InternalTitleSource, SavedVia } from "@url-keep/shared";

export type Bindings = {
  DB: D1Database;
  APP_ORIGIN?: string;
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
  title: string;
  titleSource: InternalTitleSource;
  imageUrl: string | null;
  siteName: string | null;
  savedVia: SavedVia;
  createdAt: string;
  updatedAt: string;
};

export type ListBookmarksOptions = {
  q?: string;
  limit: number;
  cursor?: string;
};

export type ListBookmarksResult = {
  items: BookmarkRecord[];
  nextCursor: string | null;
};

export type AuthContext = {
  user: UserRecord;
  token: AccessTokenRecord;
};
