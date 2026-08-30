import { cors } from "hono/cors";
import { Hono, type Context } from "hono";
import {
  ARTICLE_CONTENT_MAX_BYTES,
  CAPTURE_REQUEST_MAX_BYTES,
  MANIFEST_MAX_LIMIT,
  canonicalizeBookmarkUrl,
  classifyBookmarkUrl,
  changePasswordRequestSchema,
  createBookmarkRequestSchema,
  isHackmdRawMarkdownUrl,
  isHackmdUrl,
  createTokenRequestSchema,
  loginRequestSchema,
  updateBookmarkTitleRequestSchema,
  uploadBookmarkContentRequestSchema,
} from "@url-keep/shared";
import { extractMarkdownTitle, hasHtmlMarkup, renderMarkdownToHtml } from "./markdown";
import { sanitizeClientHtml } from "./sanitize";
import { D1Store } from "./d1-store";
import { runOneNarrationCleanup } from "./cleanup";
import {
  authorizedNarrationAudio,
  NarrationDomainError,
  narrationToApi,
  pollBookmarkNarration,
  requestNarration,
  retryNarration,
} from "./narration";
import {
  countWords,
  ExtractionFailure,
  runCapturedPageExtraction,
  runBookmarkExtraction,
  utf8ByteLength,
} from "./extraction";
import type { Store } from "./store";
import { InvalidCursorError } from "./store";
import type {
  ArticleContentRecord,
  AuthContext,
  Bindings,
  BookmarkRecord,
  BookmarkShareRecord,
} from "./types";
import {
  bookmarkToApi,
  deriveFallbackTitle,
  hashPassword,
  hashToken,
  makeId,
  makeOpaqueToken,
  makeShareToken,
  normalizeUrl,
  nowIso,
  shouldRefreshLastUsed,
  validateHttpsImageUrl,
  verifyPassword,
} from "./utils";

type AppEnv = {
  Bindings: Bindings;
  Variables: {
    store: Store;
    auth: AuthContext;
  };
};

type BookmarkExtractor = typeof runBookmarkExtraction;

type CreateAppOptions = {
  store?: Store;
  extractBookmark?: BookmarkExtractor;
};

function errorResponse(
  code: string,
  message: string,
  status: number,
  retryable?: boolean,
): Response {
  return Response.json({
    error: {
      code,
      message,
      ...(retryable === undefined ? {} : { retryable }),
    },
  }, { status });
}

function narrationErrorResponse(caught: unknown): Response {
  if (caught instanceof NarrationDomainError) {
    return errorResponse(caught.code, caught.message, caught.status, caught.retryable);
  }
  return errorResponse("server_error", "Narration request failed", 500);
}

function debugLogsEnabled(env: Bindings): boolean {
  const value = env.DEBUG_LOGS?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function debugLog(
  c: Context<AppEnv>,
  event: string,
  data: Record<string, unknown> = {},
) {
  if (!debugLogsEnabled(c.env)) {
    return;
  }

  console.log(
    JSON.stringify({
      ts: nowIso(),
      event,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status || null,
      origin: c.req.header("origin") ?? null,
      user_agent: c.req.header("user-agent") ?? null,
      ...data,
    }),
  );
}

function summarizeUrlField(value: unknown) {
  if (typeof value === "string") {
    let parsed: URL | null = null;
    try {
      parsed = new URL(value);
    } catch {
      // Invalid input is still summarized without recording its contents.
    }
    return {
      kind: "string",
      length: value.length,
      protocol: parsed?.protocol ?? null,
      hostname: parsed?.hostname ?? null,
      path_length: parsed?.pathname.length ?? null,
    };
  }

  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
    };
  }

  if (value === null) {
    return { kind: "null" };
  }

  return { kind: typeof value };
}

function summarizeBookmarkBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      body_type: Array.isArray(value) ? "array" : typeof value,
    };
  }

  const record = value as Record<string, unknown>;
  return {
    body_type: "object",
    keys: Object.keys(record).sort(),
    url: summarizeUrlField(record.url),
    saved_via:
      typeof record.saved_via === "string" ? record.saved_via : typeof record.saved_via,
    title_type: record.title === undefined ? "missing" : typeof record.title,
    image_url_type: record.image_url === undefined ? "missing" : typeof record.image_url,
    site_name_type: record.site_name === undefined ? "missing" : typeof record.site_name,
  };
}

function summarizeLoginBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      body_type: Array.isArray(value) ? "array" : typeof value,
    };
  }

  const record = value as Record<string, unknown>;
  return {
    body_type: "object",
    keys: Object.keys(record).sort(),
    email_type: typeof record.email,
    email_length: typeof record.email === "string" ? record.email.length : null,
    password_present: typeof record.password === "string" ? record.password.length > 0 : false,
    client_name:
      typeof record.client_name === "string" ? record.client_name : typeof record.client_name,
  };
}

function parseBearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const [scheme, token] = value.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
}

async function parseJsonBody<T>(
  c: Context<AppEnv>,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
): Promise<T | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse("invalid_request", "Invalid JSON body", 400);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("invalid_request", "Invalid request body", 400);
  }

  return parsed.data;
}

async function readJsonBodyWithLimit(
  c: Context<AppEnv>,
  maxBytes: number,
): Promise<unknown | Response> {
  const body = c.req.raw.body;
  if (!body) {
    return errorResponse("invalid_request", "Invalid JSON body", 400);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      return errorResponse("payload_too_large", "Request body exceeds 5MB limit", 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return errorResponse("invalid_request", "Invalid JSON body", 400);
  }
}

async function readTextBodyWithLimit(
  c: Context<AppEnv>,
  maxBytes: number,
): Promise<string | Response> {
  const body = c.req.raw.body;
  if (!body) return errorResponse("invalid_request", "Request body is required", 400);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      return errorResponse("payload_too_large", "Request body exceeds 5MB limit", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseManifestQuery(c: Context<AppEnv>) {
  const cursor = c.req.query("cursor")?.trim() || undefined;
  const rawLimit = c.req.query("limit");
  const limit = rawLimit ? Number(rawLimit) : MANIFEST_MAX_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MANIFEST_MAX_LIMIT) {
    return errorResponse(
      "invalid_request",
      `limit must be an integer between 1 and ${MANIFEST_MAX_LIMIT}`,
      400,
    );
  }
  return { cursor, limit };
}

function bookmarkSaveResponse(
  c: Context<AppEnv>,
  bookmark: BookmarkRecord,
  content: ArticleContentRecord | null,
  status: 200 | 201,
) {
  return c.json({ item: bookmarkMutationItem(bookmark, content) }, status);
}

function articleContentToApi(content: ArticleContentRecord) {
  return {
    id: content.id,
    bookmark_id: content.bookmarkId,
    title: content.title,
    content_html: content.contentHtml,
    word_count: content.wordCount,
    author: content.author,
    published_date: content.publishedDate,
    extraction_status: content.extractionStatus,
    extraction_error: content.extractionError,
    extracted_at: content.extractedAt,
    content_source: content.contentSource ?? null,
  };
}

const ARTICLE_FAILURE_CODES = new Set([
  "access_denied",
  "fetch_error",
  "timeout",
  "unsupported_content_type",
  "transport_overflow",
  "stored_content_too_large",
  "no_readable_content",
  "parse_error",
  "readability_error",
]);

function articleFailureCode(content: ArticleContentRecord): string | null {
  if (content.extractionStatus !== "failed" && content.extractionStatus !== "skipped") {
    return null;
  }
  try {
    const value = JSON.parse(content.extractionError ?? "null") as { reason?: unknown } | null;
    return typeof value?.reason === "string" && ARTICLE_FAILURE_CODES.has(value.reason)
      ? value.reason
      : "unknown";
  } catch {
    return "unknown";
  }
}

function articleMetadataToApi(content: ArticleContentRecord | null) {
  return content
    ? {
        id: content.id,
        status: content.extractionStatus,
        failure_code: articleFailureCode(content),
        title: content.title,
        word_count: content.wordCount,
        author: content.author,
        published_date: content.publishedDate,
        content_source: content.contentSource,
        updated_at: content.updatedAt,
      }
    : null;
}

function bookmarkMutationItem(bookmark: BookmarkRecord, content: ArticleContentRecord | null) {
  return {
    bookmark: bookmarkToApi(bookmark),
    article: articleMetadataToApi(content),
  };
}

const RAW_SHARE_ID_PATTERN = /^[a-f0-9]{32}$/;

function getAppOrigin(c: Context<AppEnv>): string {
  const configured = c.env.APP_ORIGIN
    ?.split(",")
    .map((value) => value.trim().replace(/^['"]|['"]$/g, "").replace(/\/+$/, ""))
    .find(Boolean);
  if (configured) {
    return configured;
  }
  return new URL(c.req.url).origin.replace(/\/+$/, "");
}

function parsePublicShareToken(value: string): string | null {
  const trimmed = value.trim();
  return RAW_SHARE_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function bookmarkShareToApi(
  c: Context<AppEnv>,
  share: BookmarkShareRecord | null,
) {
  if (!share) {
    return {
      enabled: false,
      share_url: null,
      created_at: null,
    };
  }

  return {
    enabled: true,
    share_url: `${getAppOrigin(c)}/s/${share.shareId}`,
    created_at: share.enabledAt,
  };
}

function publicShareArticleToApi(bookmark: BookmarkRecord, content: ArticleContentRecord) {
  return {
    article_id: content.id,
    title: content.title,
    url: bookmark.url,
    site_name: bookmark.siteName,
    author: content.author,
    published_date: content.publishedDate,
    word_count: content.wordCount,
  };
}

function validateShareableContent(
  content: ArticleContentRecord | null,
  requireBody = true,
): Response | null {
  if (!content || content.extractionStatus !== "complete") {
    return errorResponse(
      "share_unavailable",
      "article extraction must be complete before sharing",
      409,
    );
  }

  if (requireBody && !content.contentHtml) {
    return errorResponse("share_unavailable", "article content is not available for sharing", 409);
  }

  return null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function getAllowedOrigins(env: Bindings): string[] {
  const values = [env.APP_ORIGIN, env.ALLOWED_EXTENSION_ORIGINS]
    .flatMap((value) => (value ? value.split(",") : []))
    .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
  return [...new Set(values)];
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono<AppEnv>();
  const extractBookmark = options.extractBookmark ?? runBookmarkExtraction;

  app.use("*", async (c, next) => {
    c.set("store", options.store ?? new D1Store(c.env.DB));
    await next();
  });

  app.use("*", async (c, next) => {
    const startedAt = Date.now();
    await next();
    debugLog(c, "request.complete", {
      duration_ms: Date.now() - startedAt,
      status: c.res.status,
    });
  });

  app.use(
    "*",
    cors({
      origin: (origin, c) => {
        if (!origin) {
          return undefined;
        }
        return getAllowedOrigins(c.env).includes(origin) ? origin : undefined;
      },
      allowHeaders: [
        "Authorization",
        "Content-Type",
        "Range",
        "If-Range",
        "If-None-Match",
      ],
      allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: [
        "Accept-Ranges",
        "Content-Length",
        "Content-Range",
        "ETag",
        "X-Content-SHA256",
        "X-Audio-Duration-Ms",
        "X-Engine-Fingerprint",
      ],
      maxAge: 86400,
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/auth/login", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      debugLog(c, "auth.login.invalid_json");
      return errorResponse("invalid_request", "Invalid JSON body", 400);
    }

    const parsedResult = loginRequestSchema.safeParse(rawBody);
    if (!parsedResult.success) {
      debugLog(c, "auth.login.invalid_request", {
        body: summarizeLoginBody(rawBody),
        issues: parsedResult.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      });
      return errorResponse("invalid_request", "Invalid request body", 400);
    }

    const parsed = parsedResult.data;
    debugLog(c, "auth.login.attempt", {
      body: summarizeLoginBody(rawBody),
    });

    const store = c.get("store");
    const user = await store.getUserByEmail(parsed.email);
    const passwordCheck = user
      ? await verifyPassword(parsed.password, user.passwordHash)
      : { valid: false };
    if (!user || !passwordCheck.valid) {
      debugLog(c, "auth.login.rejected");
      return errorResponse("unauthorized", "Invalid email or password", 401);
    }

    const pepper = c.env.TOKEN_PEPPER;
    if (!pepper) {
      return errorResponse("server_error", "TOKEN_PEPPER is not configured", 500);
    }

    const token = makeOpaqueToken();
    const now = nowIso();
    const accessToken = {
      id: makeId(),
      userId: user.id,
      name: parsed.client_name,
      tokenHash: hashToken(token, pepper),
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null,
    };

    await store.insertAccessToken(accessToken);

    debugLog(c, "auth.login.success", {
      token_id: accessToken.id,
      token_name: accessToken.name,
    });

    return c.json({
      user: {
        id: user.id,
        email: user.email,
      },
      token,
      token_info: {
        id: accessToken.id,
        name: accessToken.name,
        created_at: accessToken.createdAt,
      },
    });
  });

  app.use("/*", async (c, next) => {
    if (
      c.req.path === "/auth/login" ||
      c.req.path.startsWith("/images/") ||
      c.req.path.startsWith("/public/shares/")
    ) {
      return next();
    }

    const pepper = c.env.TOKEN_PEPPER;
    if (!pepper) {
      return errorResponse("server_error", "TOKEN_PEPPER is not configured", 500);
    }

    const bearer = parseBearerToken(c.req.header("authorization"));
    if (!bearer) {
      debugLog(c, "auth.missing_bearer");
      return errorResponse("unauthorized", "Missing bearer token", 401);
    }

    const store = c.get("store");
    const tokenHash = hashToken(bearer, pepper);
    const auth = await store.getAuthByTokenHash(tokenHash);
    if (!auth || auth.token.revokedAt) {
      debugLog(c, "auth.invalid_bearer", {
        revoked: Boolean(auth?.token.revokedAt),
      });
      return errorResponse("unauthorized", "Invalid bearer token", 401);
    }
    const { user, token } = auth;

    const now = nowIso();
    if (shouldRefreshLastUsed(token.lastUsedAt, now)) {
      await store.updateAccessTokenLastUsed(token.id, now);
      token.lastUsedAt = now;
    }

    debugLog(c, "auth.valid_bearer", {
      token_id: token.id,
      token_name: token.name,
      auth_user_id: user.id,
    });

    c.set("auth", { user, token });
    await next();
  });

  app.post("/auth/logout", async (c) => {
    const { token } = c.get("auth");
    await c.get("store").revokeAccessToken(token.id, nowIso());
    return c.body(null, 204);
  });

  app.get("/auth/me", (c) => {
    const { user, token } = c.get("auth");
    return c.json({
      user: { id: user.id, email: user.email },
      token_info: { id: token.id, name: token.name },
    });
  });

  app.patch("/auth/password", async (c) => {
    const { user } = c.get("auth");
    const rawBody = await c.req.json().catch(() => null);
    const parsed = changePasswordRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return errorResponse("validation_error", parsed.error.issues[0]?.message ?? "Invalid request", 400);
    }

    const store = c.get("store");
    const fullUser = await store.getUserById(user.id);
    if (!fullUser) {
      return errorResponse("unauthorized", "Invalid user", 401);
    }

    const check = await verifyPassword(parsed.data.current_password, fullUser.passwordHash);
    if (!check.valid) {
      return errorResponse("unauthorized", "Current password is incorrect", 401);
    }

    const newHash = await hashPassword(parsed.data.new_password);
    await store.updateUserPasswordHash(user.id, newHash);

    return c.body(null, 204);
  });

  app.get("/tokens", async (c) => {
    const { user, token: currentToken } = c.get("auth");
    const tokens = await c.get("store").listAccessTokens(user.id);
    const ordered = tokens.sort((a, b) => {
      if (a.id === currentToken.id) {
        return -1;
      }
      if (b.id === currentToken.id) {
        return 1;
      }
      return b.createdAt.localeCompare(a.createdAt);
    });

    return c.json({
      items: ordered.map((item) => ({
        id: item.id,
        name: item.name,
        created_at: item.createdAt,
        last_used_at: item.lastUsedAt,
        current: item.id === currentToken.id,
      })),
    });
  });

  app.post("/tokens", async (c) => {
    const parsed = await parseJsonBody(c, createTokenRequestSchema);
    if (parsed instanceof Response) {
      return parsed;
    }

    const pepper = c.env.TOKEN_PEPPER;
    if (!pepper) {
      return errorResponse("server_error", "TOKEN_PEPPER is not configured", 500);
    }

    const { user, token: currentToken } = c.get("auth");
    const token = makeOpaqueToken();
    const now = nowIso();
    const accessToken = {
      id: makeId(),
      userId: user.id,
      name: parsed.name,
      tokenHash: hashToken(token, pepper),
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    };

    await c.get("store").insertAccessToken(accessToken);

    return c.json({
      item: {
        id: accessToken.id,
        name: accessToken.name,
        created_at: accessToken.createdAt,
        last_used_at: accessToken.lastUsedAt,
        current: accessToken.id === currentToken.id,
      },
      token,
    });
  });

  app.delete("/tokens/:id", async (c) => {
    const requestedId = c.req.param("id");
    const { user, token } = c.get("auth");
    if (requestedId === token.id) {
      return errorResponse("invalid_request", "Use logout for the current token", 400);
    }

    const existing = await c.get("store").getAccessTokenById(user.id, requestedId);
    if (!existing || existing.revokedAt) {
      return errorResponse("not_found", "Token not found", 404);
    }

    await c.get("store").revokeAccessToken(existing.id, nowIso());
    return c.body(null, 204);
  });

  app.get("/sync/revision", async (c) => {
    const revision = await c.get("store").getSyncRevision(c.get("auth").user.id);
    c.header("Cache-Control", "no-store");
    c.executionCtx.waitUntil(runOneNarrationCleanup(c.env));
    return c.json({ revision });
  });

  app.get("/sync/manifest", async (c) => {
    const parsed = parseManifestQuery(c);
    if (parsed instanceof Response) return parsed;
    try {
      const result = await c.get("store").listManifest(c.get("auth").user.id, parsed);
      c.header("Cache-Control", "no-store");
      return c.json({
        items: result.items.map((item) => ({
          ...bookmarkMutationItem(item.bookmark, item.content),
          narration: item.narration,
        })),
        next_cursor: result.nextCursor,
      });
    } catch (caught) {
      if (caught instanceof InvalidCursorError) {
        return errorResponse("invalid_cursor", "Manifest cursor is invalid", 400);
      }
      throw caught;
    }
  });

  app.get("/articles/:articleId/body", async (c) => {
    const body = await c.get("store").getArticleBodyById(
      c.get("auth").user.id,
      c.req.param("articleId"),
    );
    if (!body) return errorResponse("not_found", "Article body not found", 404);
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "private, no-store");
    c.header("ETag", `"${body.articleId}"`);
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(body.contentHtml);
  });

  app.put("/bookmarks/:id/narration", async (c) => {
    const { user } = c.get("auth");
    try {
      const result = await requestNarration(
        c.env,
        user.id,
        c.req.param("id"),
      );
      c.header("Cache-Control", "no-store");
      return c.json(
        { item: narrationToApi(result.narration) },
        result.narration.status === "pending"
          ? 202
          : 200,
      );
    } catch (caught) {
      return narrationErrorResponse(caught);
    }
  });

  app.get("/bookmarks/:id/narration", async (c) => {
    const { user } = c.get("auth");
    try {
      const narration = await pollBookmarkNarration(c.env, user.id, c.req.param("id"));
      c.header("Cache-Control", "no-store");
      return c.json(
        { item: narrationToApi(narration) },
        narration.status === "pending" ? 202 : 200,
      );
    } catch (caught) {
      return narrationErrorResponse(caught);
    }
  });

  app.post("/bookmarks/:id/narration/retry", async (c) => {
    const { user } = c.get("auth");
    try {
      const narration = await retryNarration(
        c.env,
        user.id,
        c.req.param("id"),
      );
      c.executionCtx.waitUntil(runOneNarrationCleanup(c.env));
      c.header("Cache-Control", "no-store");
      return c.json(
        { item: narrationToApi(narration) },
        narration.status === "pending" ? 202 : 200,
      );
    } catch (caught) {
      return narrationErrorResponse(caught);
    }
  });

  app.on(["GET", "HEAD"], "/bookmarks/:id/narration/audio", async (c) => {
    const { user } = c.get("auth");
    try {
      return await authorizedNarrationAudio(
        c.env,
        user.id,
        c.req.param("id"),
        c.req.raw.headers,
        c.req.method as "GET" | "HEAD",
      );
    } catch (caught) {
      return narrationErrorResponse(caught);
    }
  });

  app.get("/bookmarks/by-url", async (c) => {
    const rawUrl = c.req.query("url");
    if (!rawUrl) {
      return errorResponse("invalid_request", "url is required", 400);
    }

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeUrl(rawUrl);
    } catch (error) {
      return errorResponse(
        "invalid_request",
        error instanceof Error ? error.message : "Invalid URL",
        400,
      );
    }

    const bookmark = await c
      .get("store")
      .getBookmarkByNormalizedUrl(c.get("auth").user.id, normalizedUrl);

    if (!bookmark) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    return c.json({ item: bookmarkToApi(bookmark) });
  });

  app.post("/bookmarks", async (c) => {
    const rawBody = await readJsonBodyWithLimit(c, CAPTURE_REQUEST_MAX_BYTES);
    if (rawBody instanceof Response) {
      debugLog(c, "bookmark.save.invalid_json");
      return rawBody;
    }

    const parsedResult = createBookmarkRequestSchema.safeParse(rawBody);
    if (!parsedResult.success) {
      debugLog(c, "bookmark.save.invalid_request", {
        auth_user_id: c.get("auth").user.id,
        body: summarizeBookmarkBody(rawBody),
        issues: parsedResult.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      });
      return errorResponse("invalid_request", "Invalid request body", 400);
    }

    const parsed = parsedResult.data;
    debugLog(c, "bookmark.save.attempt", {
      auth_user_id: c.get("auth").user.id,
      body: summarizeBookmarkBody(rawBody),
    });

    const { user } = c.get("auth");
    let normalizedUrl: string;
    let canonicalUrl: string;
    let imageUrl: string | null;

    try {
      canonicalUrl = canonicalizeBookmarkUrl(parsed.url);
      normalizedUrl = normalizeUrl(parsed.url);
      imageUrl = validateHttpsImageUrl(parsed.image_url);
    } catch (error) {
      debugLog(c, "bookmark.save.invalid_bookmark_input", {
        auth_user_id: user.id,
        body: summarizeBookmarkBody(rawBody),
        error: error instanceof Error ? error.message : "Invalid bookmark input",
      });
      return errorResponse(
        "invalid_request",
        error instanceof Error ? error.message : "Invalid bookmark input",
        400,
      );
    }

    const store = c.get("store");
    const now = nowIso();
    const existing = await store.getBookmarkByNormalizedUrl(user.id, normalizedUrl);
    const trimmedTitle = isHackmdRawMarkdownUrl(parsed.url) ? undefined : parsed.title?.trim();
    const classification = classifyBookmarkUrl(normalizedUrl);

    if (!existing) {
      const title = trimmedTitle || deriveFallbackTitle(normalizedUrl);
      const titleSource = trimmedTitle ? "client" : "fallback";
      const bookmark = {
        id: makeId(),
        userId: user.id,
        url: canonicalUrl,
        normalizedUrl,
        bucket: classification.bucket,
        title,
        titleSource,
        imageUrl,
        siteName: parsed.site_name?.trim() || null,
        savedVia: parsed.saved_via,
        createdAt: now,
        updatedAt: now,
      } as const;

      await store.insertBookmark(bookmark);
      debugLog(c, "bookmark.save.created", {
        auth_user_id: user.id,
        bookmark_id: bookmark.id,
        url: summarizeUrlField(normalizedUrl),
        saved_via: bookmark.savedVia,
        status: 201,
      });
      return bookmarkSaveResponse(
        c,
        bookmark,
        null,
        201,
      );
    }

    const nextBookmark = { ...existing, bucket: classification.bucket, updatedAt: now };

    if (existing.titleSource === "fallback" && trimmedTitle) {
      nextBookmark.title = trimmedTitle;
      nextBookmark.titleSource = "client";
    }

    if (!existing.imageUrl && imageUrl) {
      nextBookmark.imageUrl = imageUrl;
    }

    if (!existing.siteName && parsed.site_name?.trim()) {
      nextBookmark.siteName = parsed.site_name.trim();
    }

    await store.updateBookmark(nextBookmark);
    const existingContent = await store.getArticleContentByBookmarkId(user.id, nextBookmark.id);
    debugLog(c, "bookmark.save.updated_existing", {
      auth_user_id: user.id,
      bookmark_id: nextBookmark.id,
      url: summarizeUrlField(normalizedUrl),
      saved_via: nextBookmark.savedVia,
      status: 200,
    });
    return bookmarkSaveResponse(
      c,
      nextBookmark,
      existingContent,
      200,
    );
  });

  app.patch("/bookmarks/:id", async (c) => {
    const parsed = await parseJsonBody(c, updateBookmarkTitleRequestSchema);
    if (parsed instanceof Response) {
      return parsed;
    }

    const bookmark = await c
      .get("store")
      .getBookmarkById(c.get("auth").user.id, c.req.param("id"));

    if (!bookmark) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    bookmark.title = parsed.title.trim();
    bookmark.titleSource = "user";
    bookmark.updatedAt = nowIso();
    await c.get("store").updateBookmark(bookmark);
    const content = await c.get("store").getArticleContentByBookmarkId(
      c.get("auth").user.id,
      bookmark.id,
    );
    return c.json({ item: bookmarkMutationItem(bookmark, content) });
  });

  app.get("/bookmarks/:id/share", async (c) => {
    const { user } = c.get("auth");
    const bookmark = await c.get("store").getBookmarkById(user.id, c.req.param("id"));
    if (!bookmark) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    const share = await c.get("store").getBookmarkShare(user.id, bookmark.id);
    return c.json({ item: bookmarkShareToApi(c, share) });
  });

  app.put("/bookmarks/:id/share", async (c) => {
    const { user } = c.get("auth");
    const store = c.get("store");
    const bookmark = await store.getBookmarkById(user.id, c.req.param("id"));
    if (!bookmark) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    const existingShare = await store.getBookmarkShare(user.id, bookmark.id);
    if (existingShare) {
      return c.json({ item: bookmarkShareToApi(c, existingShare) });
    }

    const content = await store.getArticleContentByBookmarkId(user.id, bookmark.id);
    const shareableError = validateShareableContent(content);
    if (shareableError) {
      return shareableError;
    }

    const share = await store.enableBookmarkShare(
      user.id,
      bookmark.id,
      makeShareToken(),
      nowIso(),
    );

    if (!share) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    return c.json({ item: bookmarkShareToApi(c, share) });
  });

  app.delete("/bookmarks/:id/share", async (c) => {
    const { user } = c.get("auth");
    const bookmark = await c.get("store").getBookmarkById(user.id, c.req.param("id"));
    if (!bookmark) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    await c.get("store").disableBookmarkShare(user.id, bookmark.id, nowIso());
    return c.body(null, 204);
  });

  app.put("/bookmarks/:id/capture", async (c) => {
    const { user } = c.get("auth");
    const store = c.get("store");
    const bookmark = await store.getBookmarkById(user.id, c.req.param("id"));
    if (!bookmark) return errorResponse("not_found", "Bookmark not found", 404);
    if (!classifyBookmarkUrl(bookmark.normalizedUrl).autoExtract) {
      return errorResponse(
        "extraction_unavailable",
        "reader extraction is not available for this bookmark",
        409,
      );
    }
    const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("text/html")) {
      return errorResponse("unsupported_content_type", "Content-Type must be text/html", 415);
    }
    const html = await readTextBodyWithLimit(c, CAPTURE_REQUEST_MAX_BYTES);
    if (html instanceof Response) return html;
    const existing = await store.getArticleContentByBookmarkId(user.id, bookmark.id);
    try {
      const result = await runCapturedPageExtraction({
        store,
        bookmark,
        documentHtml: html,
        baseUrl: bookmark.url,
      });
      const currentBookmark = await store.getBookmarkById(user.id, bookmark.id) ?? bookmark;
      c.executionCtx.waitUntil(runOneNarrationCleanup(c.env));
      return c.json({ item: bookmarkMutationItem(currentBookmark, result.article) });
    } catch (caught) {
      if (existing?.extractionStatus === "complete") {
        return c.json({ item: bookmarkMutationItem(bookmark, existing) });
      }
      const now = nowIso();
      const reason = caught instanceof ExtractionFailure ? caught.reason : "parse_error";
      const failed: ArticleContentRecord = {
        id: makeId(),
        bookmarkId: bookmark.id,
        userId: user.id,
        title: bookmark.title,
        contentHtml: null,
        wordCount: 0,
        author: null,
        publishedDate: null,
        extractionStatus: "failed",
        extractionError: JSON.stringify({ reason }),
        extractedAt: now,
        contentSource: "server",
        createdAt: now,
        updatedAt: now,
      };
      const write = await store.recordServerArticleFailure(failed, existing?.id ?? null);
      const current = write.written
        ? failed
        : await store.getArticleContentByBookmarkId(user.id, bookmark.id);
      return c.json({ item: bookmarkMutationItem(bookmark, current) });
    }
  });

  app.post("/bookmarks/:id/extract", async (c) => {
    const { user } = c.get("auth");
    const bookmark = await c.get("store").getBookmarkById(user.id, c.req.param("id"));
    if (!bookmark) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    if (!classifyBookmarkUrl(bookmark.normalizedUrl).autoExtract) {
      return errorResponse(
        "extraction_unavailable",
        "reader extraction is not available for this bookmark",
        409,
      );
    }

    const force = c.req.query("force")?.toLowerCase() === "true";
    const existing = await c.get("store").getArticleContentByBookmarkId(user.id, bookmark.id);

    if (existing?.contentSource === "client" && existing.extractionStatus === "complete") {
      if (force) {
        return errorResponse(
          "client_content_exists",
          "client-captured content exists. delete it first to re-extract from server.",
          409,
        );
      }
      return c.json({ item: bookmarkMutationItem(bookmark, existing) });
    }

    if (existing?.extractionStatus === "complete" && !force) {
      return c.json({ item: bookmarkMutationItem(bookmark, existing) });
    }

    const content = await extractBookmark({
      env: c.env,
      store: c.get("store"),
      bookmark,
      force,
    });
    const currentBookmark = await c.get("store").getBookmarkById(user.id, bookmark.id)
      ?? bookmark;
    if (!existing || content.id !== existing.id) {
      c.executionCtx.waitUntil(runOneNarrationCleanup(c.env));
    }
    return c.json({ item: bookmarkMutationItem(currentBookmark, content) });
  });

  app.put("/bookmarks/:id/content", async (c) => {
    const { user } = c.get("auth");
    const store = c.get("store");
    const bookmark = await store.getBookmarkById(user.id, c.req.param("id"));
    if (!bookmark) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    const rawBody = await readJsonBodyWithLimit(c, CAPTURE_REQUEST_MAX_BYTES);
    if (rawBody instanceof Response) {
      return rawBody;
    }
    const parsedResult = uploadBookmarkContentRequestSchema.safeParse(rawBody);
    if (!parsedResult.success) {
      return errorResponse("invalid_request", "Invalid request body", 400);
    }
    const parsed = parsedResult.data;

    const renderedHackmdHtml = isHackmdUrl(bookmark.url) && !hasHtmlMarkup(parsed.content_html)
      ? renderMarkdownToHtml(parsed.content_html)
      : null;
    const sanitized = sanitizeClientHtml(renderedHackmdHtml ?? parsed.content_html);
    const textOnly = stripTags(sanitized).trim();
    if (textOnly.length < 100) {
      return errorResponse(
        "no_content",
        "submitted HTML contained no readable content",
        422,
      );
    }
    if (utf8ByteLength(sanitized) > ARTICLE_CONTENT_MAX_BYTES) {
      return errorResponse(
        "stored_content_too_large",
        "Sanitized article exceeds the storage limit",
        422,
      );
    }

    const now = nowIso();
    const existing = await store.getArticleContentByBookmarkId(user.id, bookmark.id);
    const derivedHackmdTitle = renderedHackmdHtml ? extractMarkdownTitle(parsed.content_html) : null;
    const capturedTitle = parsed.title?.trim() || derivedHackmdTitle;
    const content: ArticleContentRecord = {
      id: makeId(),
      bookmarkId: bookmark.id,
      userId: user.id,
      title: capturedTitle ?? existing?.title ?? bookmark.title,
      contentHtml: sanitized,
      wordCount: countWords(textOnly),
      author: parsed.author ?? existing?.author ?? null,
      publishedDate: parsed.published_date ?? existing?.publishedDate ?? null,
      extractionStatus: "complete",
      extractionError: null,
      extractedAt: now,
      contentSource: "client",
      createdAt: now,
      updatedAt: now,
    };

    let bookmarkChanged = false;
    const nextBookmark = { ...bookmark };
    if (bookmark.titleSource !== "user" && capturedTitle) {
      nextBookmark.title = capturedTitle;
      nextBookmark.titleSource = "client";
      bookmarkChanged = nextBookmark.title !== bookmark.title
        || nextBookmark.titleSource !== bookmark.titleSource;
    }

    const capturedSiteName = parsed.site_name?.trim() || (renderedHackmdHtml ? "HackMD" : null);
    if (!bookmark.siteName && capturedSiteName) {
      nextBookmark.siteName = capturedSiteName;
      bookmarkChanged = true;
    }

    if (bookmarkChanged) {
      nextBookmark.updatedAt = now;
    }

    const write = await store.putClientArticleContent(
      content,
      bookmarkChanged ? nextBookmark : undefined,
    );
    if (write.written) {
      c.executionCtx.waitUntil(runOneNarrationCleanup(c.env));
    }
    return c.json({
      item: bookmarkMutationItem(bookmarkChanged ? nextBookmark : bookmark, content),
    });
  });

  app.get("/public/shares/:token", async (c) => {
    const shareId = parsePublicShareToken(c.req.param("token"));
    if (!shareId) {
      return errorResponse("not_found", "Share not found", 404);
    }

    const result = await c.get("store").getPublicShareById(shareId);
    if (!result || !result.content || validateShareableContent(result.content, false)) {
      return errorResponse("not_found", "Share not found", 404);
    }

    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    return c.json({
      item: publicShareArticleToApi(result.bookmark, result.content),
    });
  });

  app.get("/public/shares/:token/body", async (c) => {
    const shareId = parsePublicShareToken(c.req.param("token"));
    if (!shareId) return errorResponse("not_found", "Share not found", 404);
    const body = await c.get("store").getPublicShareBodyById(shareId);
    if (!body) return errorResponse("not_found", "Share not found", 404);
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "no-store");
    c.header("ETag", `"${body.articleId}"`);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Robots-Tag", "noindex, nofollow");
    return c.body(body.contentHtml);
  });

  app.get("/images/articles/:bookmarkId/:generationId/:hash", async (c) => {
    if (!c.env.IMAGES) {
      return errorResponse("not_found", "Image not found", 404);
    }

    const key = `articles/${c.req.param("bookmarkId")}/${c.req.param("generationId")}/${c.req.param("hash")}`;
    const object = await c.env.IMAGES.get(key);
    if (!object) {
      return errorResponse("not_found", "Image not found", 404);
    }

    return new Response(object.body, {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": object.httpMetadata?.contentType ?? "image/jpeg",
      },
    });
  });

  app.delete("/bookmarks/by-url", async (c) => {
    const rawUrl = c.req.query("url");
    if (!rawUrl) {
      return errorResponse("invalid_request", "url is required", 400);
    }

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeUrl(rawUrl);
    } catch (error) {
      return errorResponse(
        "invalid_request",
        error instanceof Error ? error.message : "Invalid URL",
        400,
      );
    }

    const deletedBookmark = await c
      .get("store")
      .deleteBookmarkByNormalizedUrl(c.get("auth").user.id, normalizedUrl);

    if (deletedBookmark) {
      c.executionCtx.waitUntil(runOneNarrationCleanup(c.env));
    }

    return c.body(null, 204);
  });

  return app;
}
