import {
  articleContentResponseSchema,
  bookmarkShareResponseSchema,
  bookmarkListResponseSchema,
  bookmarkResponseSchema,
  changePasswordRequestSchema,
  createBookmarkRequestSchema,
  createTokenRequestSchema,
  createTokenResponseSchema,
  errorResponseSchema,
  extractBookmarkResponseSchema,
  listBookmarksRequestSchema,
  loginRequestSchema,
  loginResponseSchema,
  meResponseSchema,
  offlineBundleResponseSchema,
  offlineStatusResponseSchema,
  narrationResponseSchema,
  pushConfigResponseSchema,
  pushSubscriptionRequestSchema,
  publicShareArticleResponseSchema,
  tokenListResponseSchema,
  updateBookmarkTitleRequestSchema,
  uploadBookmarkContentRequestSchema,
  type ArticleContentResponse,
  type BookmarkShareResponse,
  type BookmarkListResponse,
  type BookmarkResponse,
  type ChangePasswordRequest,
  type CreateBookmarkRequest,
  type CreateTokenRequest,
  type CreateTokenResponse,
  type ExtractBookmarkResponse,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type OfflineBundleResponse,
  type OfflineStatusResponse,
  type NarrationResponse,
  type PushConfigResponse,
  type PushSubscriptionRequest,
  type PublicShareArticleResponse,
  type TokenListResponse,
  type UpdateBookmarkTitleRequest,
  type UploadBookmarkContentRequest,
} from "@url-keep/shared";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
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

type RequestOptions = {
  method?: string;
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
  cache?: RequestCache;
  schema?: { parse: (value: unknown) => any };
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

  async listBookmarks(
    query: Partial<{ q: string; bucket: "reading" | "videos"; limit: number; cursor: string }> = {},
  ): Promise<BookmarkListResponse> {
    const parsed = listBookmarksRequestSchema.parse(query);
    const search = new URLSearchParams();

    if (parsed.q) {
      search.set("q", parsed.q);
    }
    if (parsed.bucket) {
      search.set("bucket", parsed.bucket);
    }
    if (parsed.limit) {
      search.set("limit", String(parsed.limit));
    }
    if (parsed.cursor) {
      search.set("cursor", parsed.cursor);
    }

    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.request(`/bookmarks${suffix}`, {
      schema: bookmarkListResponseSchema,
    });
  }

  async getBookmarkByUrl(url: string): Promise<BookmarkResponse> {
    const search = new URLSearchParams({ url });
    return this.request(`/bookmarks/by-url?${search.toString()}`, {
      schema: bookmarkResponseSchema,
    });
  }

  async saveBookmark(input: CreateBookmarkRequest): Promise<BookmarkResponse> {
    const body = createBookmarkRequestSchema.parse(input);
    return this.request("/bookmarks", {
      method: "POST",
      body,
      schema: bookmarkResponseSchema,
    });
  }

  async updateBookmarkTitle(
    id: string,
    input: UpdateBookmarkTitleRequest,
  ): Promise<BookmarkResponse> {
    const body = updateBookmarkTitleRequestSchema.parse(input);
    return this.request(`/bookmarks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
      schema: bookmarkResponseSchema,
    });
  }

  async extractBookmark(
    id: string,
    force = false,
  ): Promise<ExtractBookmarkResponse> {
    const search = new URLSearchParams();
    if (force) {
      search.set("force", "true");
    }

    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.request(`/bookmarks/${encodeURIComponent(id)}/extract${suffix}`, {
      method: "POST",
      schema: extractBookmarkResponseSchema,
    });
  }

  async getBookmarkContent(id: string): Promise<ArticleContentResponse> {
    return this.request(`/bookmarks/${encodeURIComponent(id)}/content`, {
      cache: "no-store",
      schema: articleContentResponseSchema,
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

  async getOfflineStatus(): Promise<OfflineStatusResponse> {
    return this.request("/offline/status", {
      cache: "no-store",
      schema: offlineStatusResponseSchema,
    });
  }

  async getOfflineBundle(
    cursor?: string,
    limit?: number,
  ): Promise<OfflineBundleResponse> {
    const search = new URLSearchParams();
    if (cursor) {
      search.set("cursor", cursor);
    }
    if (limit) {
      search.set("limit", String(limit));
    }

    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.request(`/offline/bundle${suffix}`, {
      cache: "no-store",
      schema: offlineBundleResponseSchema,
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

  async getPushConfig(): Promise<PushConfigResponse> {
    return this.request("/push/config", {
      cache: "no-store",
      schema: pushConfigResponseSchema,
    });
  }

  async putPushSubscription(input: PushSubscriptionRequest): Promise<void> {
    const body = pushSubscriptionRequestSchema.parse(input);
    await this.request("/push/subscription", { method: "PUT", body });
  }

  async deletePushSubscription(): Promise<void> {
    await this.request("/push/subscription", { method: "DELETE" });
  }

  async uploadBookmarkContent(
    id: string,
    input: UploadBookmarkContentRequest,
  ): Promise<ArticleContentResponse> {
    const body = uploadBookmarkContentRequestSchema.parse(input);
    return this.request(`/bookmarks/${encodeURIComponent(id)}/content`, {
      method: "PUT",
      body,
      schema: articleContentResponseSchema,
    });
  }

  async deleteBookmarkContent(id: string): Promise<void> {
    await this.request(`/bookmarks/${encodeURIComponent(id)}/content`, {
      method: "DELETE",
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
    options: RequestOptions = {},
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
        );
      }
      throw new ApiError(response.status, "unknown_error", "Unknown API error");
    }

    if (!options.schema) return data as T;
    try {
      return options.schema.parse(data) as T;
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
      return await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
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
        throw new ApiError(response.status, parsed.data.error.code, parsed.data.error.message);
      }
    } catch (caught) {
      if (caught instanceof ApiError) throw caught;
    }
    throw new ApiError(response.status, "unknown_error", "Unknown API error");
  }
}
