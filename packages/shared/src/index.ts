import { z } from "zod";

export const CAPTURE_REQUEST_MAX_BYTES = 5 * 1024 * 1024;
export const CAPTURE_PREFLIGHT_MAX_BYTES = 4.5 * 1024 * 1024;
export const ARTICLE_CONTENT_MAX_BYTES = 1_500_000;
export const ARTICLE_TITLE_MAX_CHARS = 300;
export const ARTICLE_SITE_NAME_MAX_CHARS = 120;
export const ARTICLE_AUTHOR_MAX_CHARS = 300;
export const ARTICLE_PUBLISHED_DATE_MAX_CHARS = 100;
export const MANIFEST_MAX_LIMIT = 100;

export const ARTICLE_SANITIZER_POLICY = {
  allowedTags: [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "a",
    "img",
    "blockquote",
    "pre",
    "code",
    "em",
    "strong",
    "b",
    "i",
    "br",
    "hr",
    "figure",
    "figcaption",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "sup",
    "sub",
    "del",
    "div",
    "span",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title"],
  },
  allowedSchemes: ["http", "https"],
} as const;

export const ARTICLE_ALLOWED_ATTRIBUTES = [
  ...new Set(Object.values(ARTICLE_SANITIZER_POLICY.allowedAttributes).flat()),
];

export const ARTICLE_SANITIZER_HOSTILE_FIXTURES = [
  {
    name: "active and unsupported markup",
    html: `
      <h2 style="color:red">Safe heading</h2>
      <p class="tracking" onclick="steal()">Readable text</p>
      <p title="not allowed here">Attribute scope</p>
      <script>alert(1)</script>
      <form><input value="secret"><button>submit</button></form>
      <iframe src="https://evil.example"></iframe>
      <svg><script>alert(2)</script><circle /></svg>
      <a href="javascript:alert(3)" data-id="bad">unsafe link</a>
      <a href="mailto:reader@example.com">unsupported mail link</a>
      <a href="ftp://example.com/file">unsupported ftp link</a>
      <a href="https://example.com/read">safe link</a>
      <img src="https://example.com/image.jpg" alt="safe" onerror="steal()">
    `,
    retained: [
      "Safe heading",
      "Readable text",
      'href="https://example.com/read"',
      'target="_blank"',
      'rel="noopener noreferrer"',
      'src="https://example.com/image.jpg"',
      'alt="safe"',
    ],
    removed: [
      "<script",
      "<form",
      "<input",
      "<button",
      "<iframe",
      "<svg",
      "<circle",
      "onclick",
      "onerror",
      "javascript:",
      "mailto:",
      "ftp://",
      "data-id",
      "style=",
      "class=",
      'title="not allowed here"',
    ],
  },
] as const;

function tryParseAbsoluteUrl(input: string): URL | null {
  try {
    return new URL(input.trim());
  } catch {
    return null;
  }
}

function isHackmdHostname(hostname: string): boolean {
  return hostname.toLowerCase() === "hackmd.io";
}

function normalizeHackmdPath(pathname: string): string {
  let next = pathname;

  if (next.endsWith("/edit")) {
    next = next.slice(0, -5);
  }

  if (next.endsWith(".md")) {
    next = next.slice(0, -3);
  }

  return next || "/";
}

export function isHackmdUrl(input: string): boolean {
  const url = tryParseAbsoluteUrl(input);
  return !!url && isHackmdHostname(url.hostname);
}

export function isHackmdRawMarkdownUrl(input: string): boolean {
  const url = tryParseAbsoluteUrl(input);
  return !!url && isHackmdHostname(url.hostname) && url.pathname.endsWith(".md");
}

export function canonicalizeBookmarkUrl(input: string): string {
  const trimmed = input.trim();
  const url = tryParseAbsoluteUrl(trimmed);

  if (!url || !isHackmdHostname(url.hostname)) {
    return trimmed;
  }

  url.pathname = normalizeHackmdPath(url.pathname);
  url.search = "";
  url.hash = "";

  return url.toString();
}

export function toReadableBookmarkUrl(input: string): string {
  const canonical = canonicalizeBookmarkUrl(input);
  const url = tryParseAbsoluteUrl(canonical);

  if (!url || !isHackmdHostname(url.hostname)) {
    return canonical;
  }

  url.search = "?type=view";
  return url.toString();
}

export function toHackmdMarkdownUrl(input: string): string | null {
  const canonical = canonicalizeBookmarkUrl(input);
  const url = tryParseAbsoluteUrl(canonical);

  if (!url || !isHackmdHostname(url.hostname)) {
    return null;
  }

  const normalizedPath = normalizeHackmdPath(url.pathname);
  if (normalizedPath === "/") {
    return null;
  }

  url.pathname = `${normalizedPath}.md`;
  url.search = "?no-meta";
  url.hash = "";

  return url.toString();
}

export const bookmarkBucketSchema = z.enum(["reading", "videos"]);

export type BookmarkBucket = z.infer<typeof bookmarkBucketSchema>;

export type BookmarkClassification = {
  bucket: BookmarkBucket;
  autoExtract: boolean;
  defaultAction: "open" | "watch" | null;
};

function normalizeBookmarkHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function defaultBookmarkClassification(): BookmarkClassification {
  return {
    bucket: "reading",
    autoExtract: true,
    defaultAction: null,
  };
}

function isYoutubeVideoUrl(url: URL): boolean {
  const hostname = normalizeBookmarkHostname(url.hostname);
  const pathname = url.pathname.toLowerCase();

  if (hostname === "youtu.be") {
    return pathname !== "/" && pathname.length > 1;
  }

  if (hostname !== "youtube.com" && hostname !== "m.youtube.com") {
    return false;
  }

  return pathname === "/watch" || pathname.startsWith("/shorts/");
}

function isLoomShareUrl(url: URL): boolean {
  return normalizeBookmarkHostname(url.hostname) === "loom.com"
    && url.pathname.toLowerCase().startsWith("/share/");
}

function isVimeoVideoUrl(url: URL): boolean {
  const hostname = normalizeBookmarkHostname(url.hostname);
  const pathname = url.pathname.toLowerCase();

  if (hostname === "player.vimeo.com") {
    return /^\/video\/\d+(?:\/|$)/.test(pathname);
  }

  return hostname === "vimeo.com" && /^\/\d+(?:\/|$)/.test(pathname);
}

function isNonReaderReadingUrl(url: URL): boolean {
  const hostname = normalizeBookmarkHostname(url.hostname);
  const pathname = url.pathname.toLowerCase();
  if (
    hostname !== "x.com"
    && hostname !== "twitter.com"
    && hostname !== "mobile.twitter.com"
  ) {
    return false;
  }

  return /^\/[^/]+\/status\/[^/]+/.test(pathname);
}

export function classifyBookmarkUrl(input: string): BookmarkClassification {
  const canonical = canonicalizeBookmarkUrl(input);
  const url = tryParseAbsoluteUrl(canonical);

  if (!url) {
    return defaultBookmarkClassification();
  }

  if (isYoutubeVideoUrl(url) || isLoomShareUrl(url) || isVimeoVideoUrl(url)) {
    return {
      bucket: "videos",
      autoExtract: false,
      defaultAction: "watch",
    };
  }

  if (isNonReaderReadingUrl(url)) {
    return {
      bucket: "reading",
      autoExtract: false,
      defaultAction: "open",
    };
  }

  return defaultBookmarkClassification();
}

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
  bucket: bookmarkBucketSchema,
  title: z.string(),
  title_source: internalTitleSourceSchema,
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

export const contentSourceSchema = z.enum(["client", "server"]);

export const articleFailureCodeSchema = z.enum([
  "access_denied",
  "fetch_error",
  "timeout",
  "unsupported_content_type",
  "transport_overflow",
  "stored_content_too_large",
  "no_readable_content",
  "parse_error",
  "readability_error",
  "unknown",
]);

export const articleMetadataSchema = z.object({
  id: z.string().uuid(),
  status: extractionStatusSchema,
  failure_code: articleFailureCodeSchema.nullable(),
  title: z.string(),
  word_count: z.number().int().nonnegative(),
  author: z.string().nullable(),
  published_date: z.string().nullable(),
  content_source: contentSourceSchema.nullable(),
  updated_at: z.string(),
});

export const articleContentSchema = z.object({
  id: z.string(),
  bookmark_id: z.string(),
  title: z.string(),
  content_html: z.string().nullable(),
  word_count: z.number().int().nonnegative(),
  author: z.string().nullable(),
  published_date: z.string().nullable(),
  extraction_status: extractionStatusSchema,
  extracted_at: z.string().nullable(),
  extraction_error: z.string().nullable().optional(),
  content_source: contentSourceSchema.nullable().optional(),
});

export const narrationAudioSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byte_size: z.number().int().positive(),
  duration_ms: z.number().int().positive(),
});

export const narrationSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["pending", "ready", "failed"]),
  retryable: z.boolean(),
  error_code: z.string().nullable(),
  audio: narrationAudioSchema.nullable(),
});

export const narrationResponseSchema = z.object({
  item: narrationSchema,
});

export const readyNarrationSummarySchema = narrationAudioSchema.extend({
  id: z.string().uuid(),
  article_id: z.string().uuid(),
});

export const bookmarkMutationItemSchema = z.object({
  bookmark: bookmarkSchema,
  article: articleMetadataSchema.nullable(),
});

export const bookmarkMutationResponseSchema = z.object({
  item: bookmarkMutationItemSchema,
});

export const syncRevisionResponseSchema = z.object({
  revision: z.number().int().nonnegative(),
});

export const manifestItemSchema = bookmarkMutationItemSchema.extend({
  narration: readyNarrationSummarySchema.nullable(),
});

export const manifestResponseSchema = z.object({
  items: z.array(manifestItemSchema).max(MANIFEST_MAX_LIMIT),
  next_cursor: z.string().nullable(),
});

export const bookmarkShareSchema = z.object({
  enabled: z.boolean(),
  share_url: z.string().url().nullable(),
  created_at: z.string().nullable(),
});

export const bookmarkShareResponseSchema = z.object({
  item: bookmarkShareSchema,
});

export const publicShareArticleSchema = z.object({
  article_id: z.string().uuid(),
  title: z.string(),
  url: z.string().url(),
  site_name: z.string().nullable(),
  author: z.string().nullable(),
  published_date: z.string().nullable(),
  word_count: z.number().int().nonnegative(),
});

export const publicShareArticleResponseSchema = z.object({
  item: publicShareArticleSchema,
});

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().optional(),
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

export const bookmarkResponseSchema = z.object({
  item: bookmarkSchema,
});

export const createBookmarkRequestSchema = z.object({
  url: z.string().min(1),
  title: z.string().trim().min(1).max(ARTICLE_TITLE_MAX_CHARS).optional(),
  image_url: z.string().url().optional(),
  site_name: z.string().trim().min(1).max(ARTICLE_SITE_NAME_MAX_CHARS).optional(),
  saved_via: savedViaSchema,
});

export const updateBookmarkTitleRequestSchema = z.object({
  title: z.string().trim().min(1).max(300),
});

export const changePasswordRequestSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8, "password must be at least 8 characters"),
});

export const uploadBookmarkContentRequestSchema = z.object({
  content_html: z.string().min(1),
  title: z.string().trim().max(ARTICLE_TITLE_MAX_CHARS).nullable().optional(),
  author: z.string().trim().max(ARTICLE_AUTHOR_MAX_CHARS).nullable().optional(),
  published_date: z.string().trim().max(ARTICLE_PUBLISHED_DATE_MAX_CHARS).nullable().optional(),
  site_name: z.string().trim().max(ARTICLE_SITE_NAME_MAX_CHARS).nullable().optional(),
});

export type SavedVia = z.infer<typeof savedViaSchema>;
export type InternalTitleSource = z.infer<typeof internalTitleSourceSchema>;
export type User = z.infer<typeof userSchema>;
export type TokenItem = z.infer<typeof tokenItemSchema>;
export type Bookmark = z.infer<typeof bookmarkSchema>;
export type ExtractionStatus = z.infer<typeof extractionStatusSchema>;
export type ArticleContent = z.infer<typeof articleContentSchema>;
export type ArticleFailureCode = z.infer<typeof articleFailureCodeSchema>;
export type ArticleMetadata = z.infer<typeof articleMetadataSchema>;
export type Narration = z.infer<typeof narrationSchema>;
export type NarrationResponse = z.infer<typeof narrationResponseSchema>;
export type ReadyNarrationSummary = z.infer<typeof readyNarrationSummarySchema>;
export type BookmarkMutationItem = z.infer<typeof bookmarkMutationItemSchema>;
export type BookmarkMutationResponse = z.infer<typeof bookmarkMutationResponseSchema>;
export type SyncRevisionResponse = z.infer<typeof syncRevisionResponseSchema>;
export type ManifestItem = z.infer<typeof manifestItemSchema>;
export type ManifestResponse = z.infer<typeof manifestResponseSchema>;
export type BookmarkShare = z.infer<typeof bookmarkShareSchema>;
export type PublicShareArticle = z.infer<typeof publicShareArticleSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type TokenListResponse = z.infer<typeof tokenListResponseSchema>;
export type CreateTokenRequest = z.infer<typeof createTokenRequestSchema>;
export type CreateTokenResponse = z.infer<typeof createTokenResponseSchema>;
export type BookmarkResponse = z.infer<typeof bookmarkResponseSchema>;
export type BookmarkShareResponse = z.infer<typeof bookmarkShareResponseSchema>;
export type PublicShareArticleResponse = z.infer<typeof publicShareArticleResponseSchema>;
export type CreateBookmarkRequest = z.infer<typeof createBookmarkRequestSchema>;
export type UpdateBookmarkTitleRequest = z.infer<
  typeof updateBookmarkTitleRequestSchema
>;
export type ContentSource = z.infer<typeof contentSourceSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type UploadBookmarkContentRequest = z.infer<typeof uploadBookmarkContentRequestSchema>;
