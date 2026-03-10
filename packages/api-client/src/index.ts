import {
  bookmarkListResponseSchema,
  bookmarkResponseSchema,
  createBookmarkRequestSchema,
  createTokenRequestSchema,
  createTokenResponseSchema,
  errorResponseSchema,
  listBookmarksRequestSchema,
  loginRequestSchema,
  loginResponseSchema,
  meResponseSchema,
  tokenListResponseSchema,
  updateBookmarkTitleRequestSchema,
  type BookmarkListResponse,
  type BookmarkResponse,
  type CreateBookmarkRequest,
  type CreateTokenRequest,
  type CreateTokenResponse,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type TokenListResponse,
  type UpdateBookmarkTitleRequest,
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

type ClientOptions = {
  baseUrl: string;
  getToken?: () => string | null;
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
  schema?: { parse: (value: unknown) => any };
};

export class UrlKeepClient {
  private readonly baseUrl: string;
  private readonly getToken?: () => string | null;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.getToken = options.getToken;
  }

  async health(signal?: AbortSignal): Promise<{ ok: boolean }> {
    return this.request("/health", undefined, signal);
  }

  async login(input: LoginRequest): Promise<LoginResponse> {
    const body = loginRequestSchema.parse(input);
    return this.request("/v1/auth/login", {
      method: "POST",
      body,
      token: null,
      schema: loginResponseSchema,
    });
  }

  async logout(): Promise<void> {
    await this.request("/v1/auth/logout", { method: "POST" });
  }

  async me(): Promise<MeResponse> {
    return this.request("/v1/auth/me", { schema: meResponseSchema });
  }

  async listTokens(): Promise<TokenListResponse> {
    return this.request("/v1/tokens", { schema: tokenListResponseSchema });
  }

  async createToken(input: CreateTokenRequest): Promise<CreateTokenResponse> {
    const body = createTokenRequestSchema.parse(input);
    return this.request("/v1/tokens", {
      method: "POST",
      body,
      schema: createTokenResponseSchema,
    });
  }

  async revokeToken(id: string): Promise<void> {
    await this.request(`/v1/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async listBookmarks(
    query: Partial<{ q: string; limit: number; cursor: string }> = {},
  ): Promise<BookmarkListResponse> {
    const parsed = listBookmarksRequestSchema.parse(query);
    const search = new URLSearchParams();

    if (parsed.q) {
      search.set("q", parsed.q);
    }
    if (parsed.limit) {
      search.set("limit", String(parsed.limit));
    }
    if (parsed.cursor) {
      search.set("cursor", parsed.cursor);
    }

    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.request(`/v1/bookmarks${suffix}`, {
      schema: bookmarkListResponseSchema,
    });
  }

  async getBookmarkByUrl(url: string): Promise<BookmarkResponse> {
    const search = new URLSearchParams({ url });
    return this.request(`/v1/bookmarks/by-url?${search.toString()}`, {
      schema: bookmarkResponseSchema,
    });
  }

  async saveBookmark(input: CreateBookmarkRequest): Promise<BookmarkResponse> {
    const body = createBookmarkRequestSchema.parse(input);
    return this.request("/v1/bookmarks", {
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
    return this.request(`/v1/bookmarks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
      schema: bookmarkResponseSchema,
    });
  }

  async deleteBookmarkByUrl(url: string): Promise<void> {
    const search = new URLSearchParams({ url });
    await this.request(`/v1/bookmarks/by-url?${search.toString()}`, {
      method: "DELETE",
    });
  }

  private async request<T>(
    path: string,
    options: RequestOptions = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const token =
      options.token !== undefined ? options.token : this.getToken?.() ?? null;
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal ?? signal,
      });
    } catch (caught) {
      throw new ApiError(
        0,
        "network_error",
        caught instanceof Error ? caught.message : "Network request failed",
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const data = await response.json();

    if (!response.ok) {
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

    return options.schema ? options.schema.parse(data) : (data as T);
  }
}
