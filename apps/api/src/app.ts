import { cors } from "hono/cors";
import { Hono, type Context } from "hono";
import {
  createBookmarkRequestSchema,
  createTokenRequestSchema,
  loginRequestSchema,
  updateBookmarkTitleRequestSchema,
} from "@url-keep/shared";
import { D1Store } from "./d1-store";
import type { Store } from "./store";
import type { AuthContext, Bindings } from "./types";
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

function getAllowedOrigins(env: Bindings): string[] {
  const values = [env.APP_ORIGIN, env.ALLOWED_EXTENSION_ORIGINS]
    .flatMap((value) => (value ? value.split(",") : []))
    .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
  return [...new Set(values)];
}

export function createApp(options: { store?: Store } = {}) {
  const app = new Hono<AppEnv>();

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
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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
    if (c.req.path === "/v1/auth/login") {
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
    let imageUrl: string | null;

    try {
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

    if (!existing) {
      const title = parsed.title?.trim() || deriveFallbackTitle(normalizedUrl);
      const titleSource = parsed.title?.trim() ? "client" : "fallback";
      const bookmark = {
        id: makeId(),
        userId: user.id,
        url: parsed.url.trim(),
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
        bookmarkToApi(bookmark),
        201,
      );
    }

    const nextBookmark = { ...existing, updatedAt: now };
    const trimmedTitle = parsed.title?.trim();

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
      bookmarkToApi(nextBookmark),
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

    await c
      .get("store")
      .deleteBookmarkByNormalizedUrl(c.get("auth").user.id, normalizedUrl);

    return c.body(null, 204);
  });

  return app;
}
