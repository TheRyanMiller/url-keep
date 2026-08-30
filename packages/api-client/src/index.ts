import {
  bookmarkMutationResponseSchema,
  bookmarkShareResponseSchema,
  bookmarkResponseSchema,
  changePasswordRequestSchema,
  createBookmarkRequestSchema,
  createTokenRequestSchema,
  createTokenResponseSchema,
  errorResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  manifestResponseSchema,
  meResponseSchema,
  narrationResponseSchema,
  syncRevisionResponseSchema,
  publicShareArticleResponseSchema,
  tokenListResponseSchema,
  updateBookmarkTitleRequestSchema,
  uploadBookmarkContentRequestSchema,
  type BookmarkMutationResponse,
  type BookmarkShareResponse,
  type BookmarkResponse,
  type ChangePasswordRequest,
  type CreateBookmarkRequest,
  type CreateTokenRequest,
  type CreateTokenResponse,
  type LoginRequest,
  type LoginResponse,
  type ManifestResponse,
  type MeResponse,
  type NarrationResponse,
  type SyncRevisionResponse,
  type PublicShareArticleResponse,
  type TokenListResponse,
  type UpdateBookmarkTitleRequest,
  type UploadBookmarkContentRequest,
} from "@url-keep/shared";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function describeUnknownError(caught: unknown, fallback: string): string {
  if (caught instanceof Error && caught.message) {
    return caught.message;
  }

  return fallback;
}

function describeSchemaError(caught: unknown, fallback: string): string {
  if (
    caught &&
    typeof caught === "object" &&
    "issues" in caught &&
    Array.isArray((caught as { issues: unknown[] }).issues)
  ) {
    const issues = (caught as {
      issues: Array<{ path?: Array<string | number>; message?: string }>;
    }).issues;
    const first = issues[0];
    if (first) {
      const path = Array.isArray(first.path) && first.path.length > 0
        ? `${first.path.join(".")}: `
        : "";
      return `${fallback}: ${path}${first.message ?? "invalid payload"}`;
    }
  }

  return describeUnknownError(caught, fallback);
}

type ClientOptions = {
  baseUrl: string;
  getToken?: () => string | null;
  onUnauthorized?: () => void;
};

type RequestOptions<T = unknown> = {
  method?: string;
  body?: unknown;
  rawBody?: BodyInit;
  headers?: HeadersInit;
  token?: string | null;
  signal?: AbortSignal;
  cache?: RequestCache;
  schema?: { parse: (value: unknown) => T };
};

export class UrlKeepClient {
  private readonly baseUrl: string;
  private readonly getToken?: () => string | null;
  private readonly onUnauthorized?: () => void;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.getToken = options.getToken;
    this.onUnauthorized = options.onUnauthorized;
  }

  async health(signal?: AbortSignal): Promise<{ ok: boolean }> {
    return this.request("/health", undefined, signal);
  }

  async login(input: LoginRequest): Promise<LoginResponse> {
    const body = loginRequestSchema.parse(input);
    return this.request("/auth/login", {
      method: "POST",
      body,
      token: null,
      schema: loginResponseSchema,
    });
  }

  async logout(): Promise<void> {
    await this.request("/auth/logout", { method: "POST" });
  }

  async me(): Promise<MeResponse> {
    return this.request("/auth/me", { schema: meResponseSchema });
  }

  async listTokens(): Promise<TokenListResponse> {
    return this.request("/tokens", { schema: tokenListResponseSchema });
  }

  async createToken(input: CreateTokenRequest): Promise<CreateTokenResponse> {
    const body = createTokenRequestSchema.parse(input);
    return this.request("/tokens", {
      method: "POST",
      body,
      schema: createTokenResponseSchema,
    });
  }

  async revokeToken(id: string): Promise<void> {
    await this.request(`/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async getBookmarkByUrl(url: string): Promise<BookmarkResponse> {
    const search = new URLSearchParams({ url });
    return this.request(`/bookmarks/by-url?${search.toString()}`, {
      schema: bookmarkResponseSchema,
    });
  }

  async saveBookmark(input: CreateBookmarkRequest): Promise<BookmarkMutationResponse> {
    const body = createBookmarkRequestSchema.parse(input);
    return this.request("/bookmarks", {
      method: "POST",
      body,
      schema: bookmarkMutationResponseSchema,
    });
  }

  async updateBookmarkTitle(
    id: string,
    input: UpdateBookmarkTitleRequest,
  ): Promise<BookmarkMutationResponse> {
    const body = updateBookmarkTitleRequestSchema.parse(input);
    return this.request(`/bookmarks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
      schema: bookmarkMutationResponseSchema,
    });
  }

  async extractBookmark(
    id: string,
    force = false,
  ): Promise<BookmarkMutationResponse> {
    const search = new URLSearchParams();
    if (force) {
      search.set("force", "true");
    }

    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.request(`/bookmarks/${encodeURIComponent(id)}/extract${suffix}`, {
      method: "POST",
      schema: bookmarkMutationResponseSchema,
    });
  }

  async getBookmarkShare(id: string): Promise<BookmarkShareResponse> {
    return this.request(`/bookmarks/${encodeURIComponent(id)}/share`, {
      schema: bookmarkShareResponseSchema,
    });
  }

  async enableBookmarkShare(id: string): Promise<BookmarkShareResponse> {
    return this.request(`/bookmarks/${encodeURIComponent(id)}/share`, {
      method: "PUT",
      schema: bookmarkShareResponseSchema,
    });
  }

  async disableBookmarkShare(id: string): Promise<void> {
    await this.request(`/bookmarks/${encodeURIComponent(id)}/share`, {
      method: "DELETE",
    });
  }

  async getPublicShareArticle(token: string): Promise<PublicShareArticleResponse> {
    return this.request(`/public/shares/${encodeURIComponent(token)}`, {
      token: null,
      schema: publicShareArticleResponseSchema,
    });
  }

  async getSyncRevision(): Promise<SyncRevisionResponse> {
    return this.request("/sync/revision", {
      cache: "no-store",
      schema: syncRevisionResponseSchema,
    });
  }

  async getManifest(cursor?: string, limit?: number): Promise<ManifestResponse> {
    const search = new URLSearchParams();
    if (cursor) search.set("cursor", cursor);
    if (limit) search.set("limit", String(limit));
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.request(`/sync/manifest${suffix}`, {
      cache: "no-store",
      schema: manifestResponseSchema,
    });
  }

  async getArticleBody(articleId: string, signal?: AbortSignal): Promise<string> {
    const response = await this.fetchResponse(
      `/articles/${encodeURIComponent(articleId)}/body`,
      { cache: "no-store", signal },
    );
    if (!response.ok) await this.throwResponseError(response, true);
    return response.text();
  }

  async getPublicShareBody(token: string, signal?: AbortSignal): Promise<string> {
    const response = await this.fetchResponse(
      `/public/shares/${encodeURIComponent(token)}/body`,
      { cache: "no-store", signal, token: null },
    );
    if (!response.ok) await this.throwResponseError(response, false);
    return response.text();
  }

  async captureBookmark(id: string, html: string): Promise<BookmarkMutationResponse> {
    return this.request(`/bookmarks/${encodeURIComponent(id)}/capture`, {
      method: "PUT",
      rawBody: html,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      schema: bookmarkMutationResponseSchema,
    });
  }

  async requestNarration(id: string, signal?: AbortSignal): Promise<NarrationResponse> {
    return this.request(`/bookmarks/${encodeURIComponent(id)}/narration`, {
      method: "PUT",
      schema: narrationResponseSchema,
      signal,
    });
  }

  async getNarration(id: string, signal?: AbortSignal): Promise<NarrationResponse> {
    return this.request(`/bookmarks/${encodeURIComponent(id)}/narration`, {
      cache: "no-store",
      schema: narrationResponseSchema,
      signal,
    });
  }

  async retryNarration(id: string, signal?: AbortSignal): Promise<NarrationResponse> {
    return this.request(`/bookmarks/${encodeURIComponent(id)}/narration/retry`, {
      method: "POST",
      schema: narrationResponseSchema,
      signal,
    });
  }

  async getNarrationAudio(id: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.fetchResponse(
      `/bookmarks/${encodeURIComponent(id)}/narration/audio`,
      { cache: "no-store", signal },
    );
    if (!response.ok) await this.throwResponseError(response, true);
    return response;
  }

  async uploadBookmarkContent(
    id: string,
    input: UploadBookmarkContentRequest,
  ): Promise<BookmarkMutationResponse> {
    const body = uploadBookmarkContentRequestSchema.parse(input);
    return this.request(`/bookmarks/${encodeURIComponent(id)}/content`, {
      method: "PUT",
      body,
      schema: bookmarkMutationResponseSchema,
    });
  }

  async changePassword(input: ChangePasswordRequest): Promise<void> {
    const body = changePasswordRequestSchema.parse(input);
    await this.request("/auth/password", {
      method: "PATCH",
      body,
    });
  }

  async deleteBookmarkByUrl(url: string): Promise<void> {
    const search = new URLSearchParams({ url });
    await this.request(`/bookmarks/by-url?${search.toString()}`, {
      method: "DELETE",
    });
  }

  private async request<T>(
    path: string,
    options: RequestOptions<T> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchResponse(path, options, signal);
    const token = options.token !== undefined ? options.token : this.getToken?.() ?? null;

    if (response.status === 204) {
      return undefined as T;
    }

    const rawBody = await response.text();
    let data: unknown;
    try {
      data = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      const fallback = response.ok
        ? "Invalid JSON response from API"
        : rawBody.trim() || "Invalid response from API";
      throw new ApiError(response.status, "invalid_response", fallback);
    }

    if (!response.ok) {
      if (response.status === 401 && token) this.onUnauthorized?.();
      const parsedError = errorResponseSchema.safeParse(data);
      if (parsedError.success) {
        throw new ApiError(
          response.status,
          parsedError.data.error.code,
          parsedError.data.error.message,
          parsedError.data.error.retryable ?? false,
        );
      }
      throw new ApiError(response.status, "unknown_error", "Unknown API error");
    }

    if (!options.schema) return data as T;
    try {
      return options.schema.parse(data);
    } catch (caught) {
      throw new ApiError(
        response.status,
        "invalid_response",
        describeSchemaError(caught, "Invalid API response"),
      );
    }
  }

  private async fetchResponse(
    path: string,
    options: RequestOptions = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    const token = options.token !== undefined ? options.token : this.getToken?.() ?? null;
    try {
      const headers = new Headers(options.headers);
      if (options.body !== undefined && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      if (token) headers.set("Authorization", `Bearer ${token}`);
      return await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.rawBody ?? (options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined),
        cache: options.cache,
        signal: options.signal ?? signal,
      });
    } catch (caught) {
      throw new ApiError(
        0,
        "network_error",
        caught instanceof Error ? caught.message : "Network request failed",
      );
    }
  }

  private async throwResponseError(response: Response, authenticated: boolean): Promise<never> {
    if (response.status === 401 && authenticated) this.onUnauthorized?.();
    try {
      const parsed = errorResponseSchema.safeParse(await response.json());
      if (parsed.success) {
        throw new ApiError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.retryable ?? false,
        );
      }
    } catch (caught) {
      if (caught instanceof ApiError) throw caught;
    }
    throw new ApiError(response.status, "unknown_error", "Unknown API error");
  }
}
