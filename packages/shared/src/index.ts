import { z } from "zod";

export const savedViaSchema = z.enum([
  "web",
  "mobile_web",
  "extension",
  "ios_shortcut",
]);

export const internalTitleSourceSchema = z.enum([
  "fallback",
  "client",
  "user",
]);

export const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
});

export const tokenInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string().optional(),
});

export const tokenItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  current: z.boolean(),
});

export const bookmarkSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  normalized_url: z.string().url(),
  title: z.string(),
  image_url: z.string().url().nullable().optional(),
  site_name: z.string().nullable().optional(),
  saved_via: savedViaSchema,
  created_at: z.string(),
  updated_at: z.string(),
  extraction_status: z.enum([
    "pending",
    "complete",
    "failed",
    "skipped",
  ]).nullable().optional(),
});

export const extractionStatusSchema = z.enum([
  "pending",
  "complete",
  "failed",
  "skipped",
]);

export const articleContentSchema = z.object({
  bookmark_id: z.string(),
  content_html: z.string().nullable(),
  word_count: z.number().int().nonnegative(),
  author: z.string().nullable(),
  published_date: z.string().nullable(),
  extraction_status: extractionStatusSchema,
  extracted_at: z.string().nullable(),
  extraction_error: z.string().nullable().optional(),
});

export const articleContentResponseSchema = z.object({
  item: articleContentSchema,
});

export const extractBookmarkResponseSchema = z.object({
  extraction_status: extractionStatusSchema,
});

export const offlineStatusResponseSchema = z.object({
  bookmark_count: z.number().int().nonnegative(),
  latest_updated_at: z.string().nullable(),
});

export const offlineBundleItemSchema = z.object({
  bookmark: bookmarkSchema,
  content: articleContentSchema.nullable(),
});

export const offlineBundleResponseSchema = z.object({
  items: z.array(offlineBundleItemSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  client_name: z.string().trim().min(1).max(80),
});

export const loginResponseSchema = z.object({
  user: userSchema,
  token: z.string(),
  token_info: tokenInfoSchema,
});

export const meResponseSchema = z.object({
  user: userSchema,
  token_info: z.object({
    id: z.string(),
    name: z.string(),
  }),
});

export const tokenListResponseSchema = z.object({
  items: z.array(tokenItemSchema),
});

export const createTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const createTokenResponseSchema = z.object({
  item: tokenItemSchema,
  token: z.string(),
});

export const listBookmarksRequestSchema = z.object({
  q: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export const bookmarkListResponseSchema = z.object({
  items: z.array(bookmarkSchema),
  next_cursor: z.string().nullable(),
});

export const bookmarkResponseSchema = z.object({
  item: bookmarkSchema,
});

export const createBookmarkRequestSchema = z.object({
  url: z.string().min(1),
  title: z.string().trim().min(1).max(300).optional(),
  image_url: z.string().url().optional(),
  site_name: z.string().trim().min(1).max(120).optional(),
  saved_via: savedViaSchema,
});

export const updateBookmarkTitleRequestSchema = z.object({
  title: z.string().trim().min(1).max(300),
});

export const changePasswordRequestSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8, "password must be at least 8 characters"),
});

export type SavedVia = z.infer<typeof savedViaSchema>;
export type InternalTitleSource = z.infer<typeof internalTitleSourceSchema>;
export type User = z.infer<typeof userSchema>;
export type TokenItem = z.infer<typeof tokenItemSchema>;
export type Bookmark = z.infer<typeof bookmarkSchema>;
export type ExtractionStatus = z.infer<typeof extractionStatusSchema>;
export type ArticleContent = z.infer<typeof articleContentSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type TokenListResponse = z.infer<typeof tokenListResponseSchema>;
export type CreateTokenRequest = z.infer<typeof createTokenRequestSchema>;
export type CreateTokenResponse = z.infer<typeof createTokenResponseSchema>;
export type BookmarkListResponse = z.infer<typeof bookmarkListResponseSchema>;
export type BookmarkResponse = z.infer<typeof bookmarkResponseSchema>;
export type ArticleContentResponse = z.infer<typeof articleContentResponseSchema>;
export type ExtractBookmarkResponse = z.infer<typeof extractBookmarkResponseSchema>;
export type OfflineStatusResponse = z.infer<typeof offlineStatusResponseSchema>;
export type OfflineBundleItem = z.infer<typeof offlineBundleItemSchema>;
export type OfflineBundleResponse = z.infer<typeof offlineBundleResponseSchema>;
export type CreateBookmarkRequest = z.infer<typeof createBookmarkRequestSchema>;
export type UpdateBookmarkTitleRequest = z.infer<
  typeof updateBookmarkTitleRequestSchema
>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
