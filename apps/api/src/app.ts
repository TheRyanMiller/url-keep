import { cors } from "hono/cors";
import { Hono, type Context } from "hono";
import {
  canonicalizeBookmarkUrl,
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
import {
  countWords,
  pendingArticleContent,
  removeBookmarkImages,
  runBookmarkExtraction,
} from "./extraction";
import type { Store } from "./store";
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
): Response {
  return Response.json({ error: { code, message } }, { status });
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
    return {
      kind: "string",
      value,
    };
  }

  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
      first: value[0] ?? null,
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
    email: typeof record.email === "string" ? record.email : typeof record.email,
    password_present: typeof record.password === "string" ? record.password.length > 0 : false,
    client_name:
      typeof record.client_name === "string" ? record.client_name : typeof record.client_name,
  };
}

function summarizeAuthHeader(value: string | undefined) {
  if (!value) {
    return {
      present: false,
    };
  }

  const [scheme, token] = value.split(/\s+/, 2);
  return {
    present: true,
    scheme: scheme ?? null,
    token_present: Boolean(token),
    token_length: token?.length ?? 0,
  };
}

function summarizeTokenHash(value: string) {
  return value.slice(0, 12);
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

function parseListQuery(c: Context<AppEnv>) {
  const q = c.req.query("q")?.trim() || undefined;
  const cursor = c.req.query("cursor")?.trim() || undefined;
  const rawLimit = c.req.query("limit");
  const parsedLimit = rawLimit ? Number(rawLimit) : 50;

  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    return errorResponse("invalid_request", "limit must be an integer between 1 and 100", 400);
  }

  return { q, cursor, limit: parsedLimit };
}

function bookmarkSaveResponse(
  c: Context<AppEnv>,
  savedVia: string,
  bookmark: ReturnType<typeof bookmarkToApi>,
  status: 200 | 201,
) {
  if (savedVia === "ios_shortcut") {
    return c.body(null, 204);
  }

  return c.json({ item: bookmark }, status);
}

function articleContentToApi(content: ArticleContentRecord) {
  return {
    bookmark_id: content.bookmarkId,
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

function timingSafeEqualStrings(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}

function getAppOrigin(c: Context<AppEnv>): string {
  const configured = c.env.APP_ORIGIN?.trim().replace(/\/+$/, "");
  if (configured) {
    return configured;
  }
  return new URL(c.req.url).origin.replace(/\/+$/, "");
}

function buildPublicShareToken(shareId: string, pepper: string): string {
  return `${shareId}.${hashToken(shareId, pepper)}`;
}

function parsePublicShareToken(value: string): { shareId: string; signature: string } | null {
  const trimmed = value.trim();
  const separator = trimmed.indexOf(".");
  if (separator <= 0 || separator >= trimmed.length - 1) {
    return null;
  }

  return {
    shareId: trimmed.slice(0, separator),
    signature: trimmed.slice(separator + 1),
  };
}

function bookmarkShareToApi(
  c: Context<AppEnv>,
  share: BookmarkShareRecord | null,
  pepper: string,
) {
  if (!share) {
    return {
      enabled: false,
      share_url: null,
      hit_count: 0,
      created_at: null,
      last_accessed_at: null,
    };
  }

  return {
    enabled: true,
    share_url: `${getAppOrigin(c)}/s/${buildPublicShareToken(share.shareId, pepper)}`,
    hit_count: share.viewCount,
    created_at: share.enabledAt,
    last_accessed_at: share.lastAccessedAt,
  };
}

function publicShareArticleToApi(bookmark: BookmarkRecord, content: ArticleContentRecord) {
  return {
    title: bookmark.title,
    url: bookmark.url,
    site_name: bookmark.siteName,
    author: content.author,
    published_date: content.publishedDate,
    word_count: content.wordCount,
    content_html: content.contentHtml ?? "",
  };
}

function validateShareableContent(content: ArticleContentRecord | null): Response | null {
  if (!content || content.extractionStatus !== "complete") {
    return errorResponse(
      "share_unavailable",
      "article extraction must be complete before sharing",
      409,
    );
  }

  if (content.contentSource !== "server") {
    return errorResponse(
      "share_unavailable",
      "only server-extracted articles can be shared publicly",
      409,
    );
  }

  if (!content.contentHtml) {
    return errorResponse("share_unavailable", "article content is not available for sharing", 409);
  }

  return null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

async function queueBookmarkExtraction(
  c: Context<AppEnv>,
  bookmark: BookmarkRecord,
  extractBookmark: BookmarkExtractor,
  force = false,
) {
  const store = c.get("store");
  const existing = await store.getArticleContentByBookmarkId(bookmark.userId, bookmark.id);
  if (!force && existing?.extractionStatus === "complete") {
    return existing.extractionStatus;
  }

  await store.upsertArticleContent(pendingArticleContent(bookmark, existing));
  c.executionCtx.waitUntil(
    extractBookmark({
      env: c.env,
      store,
      bookmark,
      force,
    }),
  );

  return "pending";
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
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 86400,
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/v1/auth/login", async (c) => {
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
      : { valid: false, needsRehash: false };
    if (!user || !passwordCheck.valid) {
      debugLog(c, "auth.login.rejected", {
        email: parsed.email,
      });
      return errorResponse("unauthorized", "Invalid email or password", 401);
    }

    if (passwordCheck.needsRehash) {
      const passwordHash = await hashPassword(parsed.password);
      await store.updateUserPasswordHash(user.id, passwordHash);
      user.passwordHash = passwordHash;
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
      email: user.email,
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

  app.use("/v1/*", async (c, next) => {
    if (
      c.req.path === "/v1/auth/login" ||
      c.req.path.startsWith("/v1/images/") ||
      c.req.path.startsWith("/v1/public/shares/")
    ) {
      return next();
    }

    const pepper = c.env.TOKEN_PEPPER;
    if (!pepper) {
      return errorResponse("server_error", "TOKEN_PEPPER is not configured", 500);
    }

    const bearer = parseBearerToken(c.req.header("authorization"));
    if (!bearer) {
      debugLog(c, "auth.missing_bearer", {
        auth_header: summarizeAuthHeader(c.req.header("authorization")),
      });
      return errorResponse("unauthorized", "Missing bearer token", 401);
    }

    const store = c.get("store");
    const tokenHash = hashToken(bearer, pepper);
    const token = await store.getAccessTokenByHash(tokenHash);
    if (!token || token.revokedAt) {
      debugLog(c, "auth.invalid_bearer", {
        auth_header: summarizeAuthHeader(c.req.header("authorization")),
        token_hash_prefix: summarizeTokenHash(tokenHash),
        revoked: Boolean(token?.revokedAt),
      });
      return errorResponse("unauthorized", "Invalid bearer token", 401);
    }

    const user = await store.getUserById(token.userId);
    if (!user) {
      debugLog(c, "auth.missing_user_for_token", {
        token_id: token.id,
      });
      return errorResponse("unauthorized", "Invalid bearer token", 401);
    }

    const now = nowIso();
    if (shouldRefreshLastUsed(token.lastUsedAt, now)) {
      await store.updateAccessTokenLastUsed(token.id, now);
      token.lastUsedAt = now;
    }

    debugLog(c, "auth.valid_bearer", {
      auth_header: summarizeAuthHeader(c.req.header("authorization")),
      token_hash_prefix: summarizeTokenHash(tokenHash),
      token_id: token.id,
      token_name: token.name,
      auth_user_id: user.id,
    });

    c.set("auth", { user, token });
    await next();
  });

  app.post("/v1/auth/logout", async (c) => {
    const { token } = c.get("auth");
    await c.get("store").revokeAccessToken(token.id, nowIso());
    return c.body(null, 204);
  });

  app.get("/v1/auth/me", (c) => {
    const { user, token } = c.get("auth");
    return c.json({
      user: { id: user.id, email: user.email },
      token_info: { id: token.id, name: token.name },
    });
  });

  app.patch("/v1/auth/password", async (c) => {
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

  app.get("/v1/tokens", async (c) => {
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

  app.post("/v1/tokens", async (c) => {
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

  app.delete("/v1/tokens/:id", async (c) => {
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

  app.get("/v1/bookmarks", async (c) => {
    const parsed = parseListQuery(c);
    if (parsed instanceof Response) {
      return parsed;
    }

    const { user } = c.get("auth");
    const result = await c.get("store").listBookmarks(user.id, parsed);
    return c.json({
      items: result.items.map(bookmarkToApi),
      next_cursor: result.nextCursor,
    });
  });

  app.get("/v1/offline/status", async (c) => {
    const { user } = c.get("auth");
    const status = await c.get("store").getOfflineStatus(user.id);
    return c.json({
      bookmark_count: status.bookmarkCount,
      latest_updated_at: status.latestUpdatedAt,
    });
  });

  app.get("/v1/offline/bundle", async (c) => {
    const parsed = parseListQuery(c);
    if (parsed instanceof Response) {
      return parsed;
    }

    const { user } = c.get("auth");
    const result = await c.get("store").listOfflineBundle(user.id, {
      cursor: parsed.cursor,
      limit: parsed.limit,
    });

    return c.json({
      items: result.items.map((item) => ({
        bookmark: bookmarkToApi(item.bookmark),
        content: item.content ? articleContentToApi(item.content) : null,
      })),
      next_cursor: result.nextCursor,
      has_more: result.hasMore,
    });
  });

  app.get("/v1/bookmarks/by-url", async (c) => {
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

  app.post("/v1/bookmarks", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      debugLog(c, "bookmark.save.invalid_json");
      return errorResponse("invalid_request", "Invalid JSON body", 400);
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

    if (!existing) {
      const title = trimmedTitle || deriveFallbackTitle(normalizedUrl);
      const titleSource = trimmedTitle ? "client" : "fallback";
      const bookmark = {
        id: makeId(),
        userId: user.id,
        url: canonicalUrl,
        normalizedUrl,
        title,
        titleSource,
        imageUrl,
        siteName: parsed.site_name?.trim() || null,
        savedVia: parsed.saved_via,
        createdAt: now,
        updatedAt: now,
      } as const;

      await store.insertBookmark(bookmark);
      let extractionStatus: BookmarkRecord["extractionStatus"];
      if (parsed.saved_via === "extension") {
        // Extension owns the capture lifecycle. Create a pending row so the
        // bookmark shows "pending" in the UI, but do NOT waitUntil() a server
        // fetch. The extension service worker will either upload content or
        // explicitly trigger server extraction as fallback.
        await store.upsertArticleContent(pendingArticleContent(bookmark, null));
        extractionStatus = "pending";
      } else {
        extractionStatus = await queueBookmarkExtraction(c, bookmark, extractBookmark);
      }
      const responseStatus = bookmark.savedVia === "ios_shortcut" ? 204 : 201;
      debugLog(c, "bookmark.save.created", {
        auth_user_id: user.id,
        bookmark_id: bookmark.id,
        normalized_url: normalizedUrl,
        saved_via: bookmark.savedVia,
        status: responseStatus,
      });
      return bookmarkSaveResponse(
        c,
        bookmark.savedVia,
        bookmarkToApi({ ...bookmark, extractionStatus }),
        201,
      );
    }

    const nextBookmark = { ...existing, updatedAt: now };

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
    let extractionStatus: BookmarkRecord["extractionStatus"];
    if (parsed.saved_via === "extension") {
      const existingContent = await store.getArticleContentByBookmarkId(user.id, nextBookmark.id);
      if (!existingContent || existingContent.extractionStatus === "failed" || existingContent.extractionStatus === "skipped") {
        await store.upsertArticleContent(pendingArticleContent(nextBookmark, existingContent));
        extractionStatus = "pending";
      } else {
        extractionStatus = existingContent.extractionStatus;
      }
    } else {
      extractionStatus = await queueBookmarkExtraction(c, nextBookmark, extractBookmark);
    }
    const responseStatus = nextBookmark.savedVia === "ios_shortcut" ? 204 : 200;
    debugLog(c, "bookmark.save.updated_existing", {
      auth_user_id: user.id,
      bookmark_id: nextBookmark.id,
      normalized_url: normalizedUrl,
      saved_via: nextBookmark.savedVia,
      status: responseStatus,
    });
    return bookmarkSaveResponse(
      c,
      nextBookmark.savedVia,
      bookmarkToApi({ ...nextBookmark, extractionStatus }),
      200,
    );
  });

  app.patch("/v1/bookmarks/:id", async (c) => {
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

    return c.json({ item: bookmarkToApi(bookmark) });
  });

  app.get("/v1/bookmarks/:id/share", async (c) => {
    const { user } = c.get("auth");
    const pepper = c.env.TOKEN_PEPPER;
    if (!pepper) {
      return errorResponse("server_error", "TOKEN_PEPPER is not configured", 500);
    }

    const bookmark = await c.get("store").getBookmarkById(user.id, c.req.param("id"));
    if (!bookmark) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    const share = await c.get("store").getBookmarkShare(user.id, bookmark.id);
    return c.json({ item: bookmarkShareToApi(c, share, pepper) });
  });

  app.put("/v1/bookmarks/:id/share", async (c) => {
    const { user } = c.get("auth");
    const pepper = c.env.TOKEN_PEPPER;
    if (!pepper) {
      return errorResponse("server_error", "TOKEN_PEPPER is not configured", 500);
    }

    const store = c.get("store");
    const bookmark = await store.getBookmarkById(user.id, c.req.param("id"));
    if (!bookmark) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    const existingShare = await store.getBookmarkShare(user.id, bookmark.id);
    if (existingShare) {
      return c.json({ item: bookmarkShareToApi(c, existingShare, pepper) });
    }

    const content = await store.getArticleContentByBookmarkId(user.id, bookmark.id);
    const shareableError = validateShareableContent(content);
    if (shareableError) {
      return shareableError;
    }

    const share = await store.enableBookmarkShare(
      user.id,
      bookmark.id,
      makeOpaqueToken(),
      nowIso(),
    );

    if (!share) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    return c.json({ item: bookmarkShareToApi(c, share, pepper) });
  });

  app.delete("/v1/bookmarks/:id/share", async (c) => {
    const { user } = c.get("auth");
    const bookmark = await c.get("store").getBookmarkById(user.id, c.req.param("id"));
    if (!bookmark) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    await c.get("store").disableBookmarkShare(user.id, bookmark.id, nowIso());
    return c.body(null, 204);
  });

  app.post("/v1/bookmarks/:id/extract", async (c) => {
    const { user } = c.get("auth");
    const bookmark = await c.get("store").getBookmarkById(user.id, c.req.param("id"));
    if (!bookmark) {
      return errorResponse("not_found", "Bookmark not found", 404);
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
      return c.json({ extraction_status: existing.extractionStatus });
    }

    if (existing?.extractionStatus === "complete" && !force) {
      return c.json({ extraction_status: existing.extractionStatus });
    }

    const extractionStatus = await queueBookmarkExtraction(
      c,
      bookmark,
      extractBookmark,
      force,
    );

    return c.json({ extraction_status: extractionStatus }, 202);
  });

  app.put("/v1/bookmarks/:id/content", async (c) => {
    const { user } = c.get("auth");
    const store = c.get("store");
    const bookmark = await store.getBookmarkById(user.id, c.req.param("id"));
    if (!bookmark) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    const contentLength = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > 5 * 1024 * 1024) {
      return errorResponse("payload_too_large", "Request body exceeds 5MB limit", 413);
    }

    const parsed = await parseJsonBody(c, uploadBookmarkContentRequestSchema);
    if (parsed instanceof Response) {
      return parsed;
    }

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

    const now = nowIso();
    const existing = await store.getArticleContentByBookmarkId(user.id, bookmark.id);
    const content: ArticleContentRecord = {
      id: existing?.id ?? makeId(),
      bookmarkId: bookmark.id,
      userId: user.id,
      contentHtml: sanitized,
      wordCount: countWords(textOnly),
      author: parsed.author ?? existing?.author ?? null,
      publishedDate: parsed.published_date ?? existing?.publishedDate ?? null,
      extractionStatus: "complete",
      extractionError: null,
      extractedAt: now,
      contentSource: "client",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // If existing content came from server extraction, clean up R2 images
    // before overwriting with client HTML (which uses original image URLs).
    if (existing?.contentSource === "server" && existing.contentHtml) {
      c.executionCtx.waitUntil(removeBookmarkImages(bookmark.id, c.env.IMAGES));
    }

    await store.upsertArticleContent(content);
    const activeShare = await store.getBookmarkShare(user.id, bookmark.id);
    if (activeShare) {
      await store.disableBookmarkShare(user.id, bookmark.id, now);
    }

    let bookmarkChanged = false;
    const nextBookmark = { ...bookmark };
    const derivedHackmdTitle = renderedHackmdHtml ? extractMarkdownTitle(parsed.content_html) : null;

    if (bookmark.titleSource === "fallback" && (parsed.title || derivedHackmdTitle)) {
      nextBookmark.title = parsed.title ?? derivedHackmdTitle ?? bookmark.title;
      nextBookmark.titleSource = "client";
      bookmarkChanged = true;
    }

    if (!bookmark.siteName && (parsed.site_name || (renderedHackmdHtml ? "HackMD" : null))) {
      nextBookmark.siteName = parsed.site_name ?? "HackMD";
      bookmarkChanged = true;
    }

    if (bookmarkChanged) {
      nextBookmark.updatedAt = now;
      await store.updateBookmark(nextBookmark);
    }

    return c.json({ item: articleContentToApi(content) });
  });

  app.get("/v1/bookmarks/:id/content", async (c) => {
    const { user } = c.get("auth");
    const bookmark = await c.get("store").getBookmarkById(user.id, c.req.param("id"));
    if (!bookmark) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    const content = await c.get("store").getArticleContentByBookmarkId(user.id, bookmark.id);
    if (!content) {
      return c.json({
        item: articleContentToApi(pendingArticleContent(bookmark, null)),
      });
    }

    return c.json({ item: articleContentToApi(content) });
  });

  app.delete("/v1/bookmarks/:id/content", async (c) => {
    const { user } = c.get("auth");
    const store = c.get("store");
    const bookmark = await store.getBookmarkById(user.id, c.req.param("id"));
    if (!bookmark) {
      return errorResponse("not_found", "Bookmark not found", 404);
    }

    const activeShare = await store.getBookmarkShare(user.id, bookmark.id);
    await store.deleteBookmarkContent(user.id, bookmark.id);
    if (activeShare) {
      await store.disableBookmarkShare(user.id, bookmark.id, nowIso());
    }
    c.executionCtx.waitUntil(removeBookmarkImages(bookmark.id, c.env.IMAGES));
    return c.body(null, 204);
  });

  app.get("/v1/public/shares/:token", async (c) => {
    const pepper = c.env.TOKEN_PEPPER;
    if (!pepper) {
      return errorResponse("server_error", "TOKEN_PEPPER is not configured", 500);
    }

    const parsed = parsePublicShareToken(c.req.param("token"));
    if (!parsed) {
      return errorResponse("not_found", "Share not found", 404);
    }

    const expectedSignature = hashToken(parsed.shareId, pepper);
    if (!timingSafeEqualStrings(parsed.signature, expectedSignature)) {
      return errorResponse("not_found", "Share not found", 404);
    }

    const result = await c.get("store").getPublicShareById(parsed.shareId);
    if (!result || !result.content || validateShareableContent(result.content)) {
      return errorResponse("not_found", "Share not found", 404);
    }

    const accessedAt = nowIso();
    await c.get("store").recordBookmarkShareHit(result.bookmark.id, accessedAt);

    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    return c.json({
      item: publicShareArticleToApi(result.bookmark, result.content),
    });
  });

  app.get("/v1/images/articles/:bookmarkId/:hash", async (c) => {
    if (!c.env.IMAGES) {
      return errorResponse("not_found", "Image not found", 404);
    }

    const key = `articles/${c.req.param("bookmarkId")}/${c.req.param("hash")}`;
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

  app.delete("/v1/bookmarks/by-url", async (c) => {
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
      c.executionCtx.waitUntil(removeBookmarkImages(deletedBookmark.id, c.env.IMAGES));
    }

    return c.body(null, 204);
  });

  return app;
}
