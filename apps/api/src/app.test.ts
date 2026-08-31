import { beforeEach, describe, expect, it } from "vitest";
import type { BookmarkMutationResponse, ManifestResponse } from "@url-keep/shared";
import { createApp } from "./app";
import { MemoryStore } from "./memory-store";
import { hashPassword, makeId, nowIso } from "./utils";
import type { BookmarkRecord, UserRecord } from "./types";

const TEST_ENV = {
  DB: {} as D1Database,
  TOKEN_PEPPER: "pepper",
  APP_ORIGIN: "http://localhost:5173",
  ALLOWED_EXTENSION_ORIGINS: "chrome-extension://test",
};

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

describe("api", () => {
  let store: MemoryStore;
  let app: ReturnType<typeof createApp>;
  let user: UserRecord;
  let extractCalls: Array<{ id: string; force: boolean }>;

  function executionContext() {
    const promises: Promise<unknown>[] = [];
    return {
      context: {
        passThroughOnException() {},
        props: {},
        waitUntil(promise: Promise<unknown>) {
          promises.push(promise);
        },
      } as unknown as ExecutionContext,
      promises,
    };
  }

  async function request(
    input: string | Request,
    init?: RequestInit,
    env: typeof TEST_ENV = TEST_ENV,
  ) {
    const execution = executionContext();
    const response = input instanceof Request
      ? await app.request(input, undefined, env, execution.context)
      : await app.request(input, init, env, execution.context);
    await Promise.allSettled(execution.promises);
    return response;
  }

  beforeEach(async () => {
    store = new MemoryStore();
    extractCalls = [];
    app = createApp({
      store,
      extractBookmark: async ({ store: targetStore, bookmark, force = false }) => {
        extractCalls.push({ id: bookmark.id, force });
        const now = nowIso();
        const content = {
          id: makeId(),
          bookmarkId: bookmark.id,
          userId: bookmark.userId,
          title: bookmark.title,
          contentHtml: `<article><p>${"offline article text ".repeat(8)}</p></article>`,
          wordCount: 24,
          author: "Jane Doe",
          publishedDate: "2026-03-10",
          extractionStatus: "complete" as const,
          extractionError: null,
          extractedAt: now,
          contentSource: "server" as const,
          createdAt: now,
          updatedAt: now,
        };
        const existing = await targetStore.getArticleContentByBookmarkId(
          bookmark.userId,
          bookmark.id,
        );
        await targetStore.putServerArticleContent(content, undefined, existing?.id ?? null);
        return content;
      },
    });
    user = {
      id: "user-1",
      email: "me@example.com",
      passwordHash: await hashPassword("secret"),
      createdAt: nowIso(),
    };
    await store.insertUser(user);
  });

  async function login(clientName = "web app") {
    const response = await request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: "secret",
        client_name: clientName,
      }),
    });
    expect(response.status).toBe(200);
    return json<{ token: string }>(response);
  }

  async function createBookmark(
    token: string,
    url: string,
    options: Partial<{
      image_url: string;
      title: string;
      saved_via: "web" | "extension" | "mobile_web" | "ios_shortcut";
    }> = {},
  ) {
    const response = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        saved_via: options.saved_via ?? "web",
        ...(options.image_url ? { image_url: options.image_url } : {}),
        ...(options.title ? { title: options.title } : {}),
      }),
    });
    expect(response.status).toBe(201);
    return json<BookmarkMutationResponse>(response);
  }

  async function extractBookmark(token: string, bookmarkId: string, force = false) {
    const suffix = force ? "?force=true" : "";
    return request(`http://localhost/bookmarks/${bookmarkId}/extract${suffix}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("authenticates, exposes the current session, and rejects bad credentials", async () => {
    const { token } = await login();
    expect(token.startsWith("uk_")).toBe(true);

    const me = await request("http://localhost/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    expect((await json<{ user: { email: string } }>(me)).user.email).toBe(user.email);

    const failure = await request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: "wrong",
        client_name: "web app",
      }),
    });
    expect(failure.status).toBe(401);
  });

  it("returns the configured CORS and narration range capabilities", async () => {
    const loginPreflight = await request("http://localhost/auth/login", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }, { ...TEST_ENV, APP_ORIGIN: '"http://localhost:5173", http://127.0.0.1:5173' });
    expect(loginPreflight.status).toBe(204);
    expect(loginPreflight.headers.get("Access-Control-Allow-Origin"))
      .toBe("http://localhost:5173");

    const audioPreflight = await request(
      "http://localhost/bookmarks/example/narration/audio",
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "HEAD",
          "Access-Control-Request-Headers": "authorization,range,if-range",
        },
      },
    );
    expect(audioPreflight.headers.get("Access-Control-Allow-Methods")).toContain("HEAD");
    expect(audioPreflight.headers.get("Access-Control-Allow-Headers")).toContain("Range");
    expect(audioPreflight.headers.get("Access-Control-Expose-Headers")).toContain("Content-Range");
  });

  it("creates metadata only and returns authoritative mutation patches", async () => {
    const { token } = await login();
    const created = await createBookmark(token, "https://example.com/post");

    expect(created.item.bookmark).toMatchObject({
      url: "https://example.com/post",
      title: "example.com",
      title_source: "fallback",
      bucket: "reading",
      extraction_status: null,
    });
    expect(created.item.article).toBeNull();
    expect(extractCalls).toHaveLength(0);

    const duplicateResponse = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/post",
        title: "Real title",
        saved_via: "extension",
      }),
    });
    expect(duplicateResponse.status).toBe(200);
    const duplicate = await json<BookmarkMutationResponse>(duplicateResponse);
    expect(duplicate.item.bookmark.title).toBe("Real title");
    expect(duplicate.item.bookmark.title_source).toBe("client");
    expect(duplicate.item.bookmark.saved_via).toBe("web");
  });

  it("preserves user titles and canonicalizes special bookmark URLs", async () => {
    const { token } = await login();
    const created = await createBookmark(token, "https://example.com/title", {
      title: "Client title",
      saved_via: "extension",
    });
    const id = created.item.bookmark.id;
    const edit = await request(`http://localhost/bookmarks/${id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "My title" }),
    });
    expect((await json<BookmarkMutationResponse>(edit)).item.bookmark.title_source).toBe("user");

    const duplicate = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/title",
        title: "Remote title",
        saved_via: "extension",
      }),
    });
    expect((await json<BookmarkMutationResponse>(duplicate)).item.bookmark.title).toBe("My title");

    const hackmd = await createBookmark(
      token,
      "https://hackmd.io/@murderteeth/S1A4kz-9bg.md?no-meta",
      { title: "raw URL", saved_via: "extension" },
    );
    expect(hackmd.item.bookmark.url).toBe("https://hackmd.io/@murderteeth/S1A4kz-9bg");
    expect(hackmd.item.bookmark.title).toBe("hackmd.io");

    const video = await createBookmark(token, "https://youtu.be/abc123");
    expect(video.item.bookmark.bucket).toBe("videos");
    expect(video.item.bookmark.extraction_status).toBeNull();
  });

  it("accepts bounded raw capture and exposes body only by immutable article id", async () => {
    const { token } = await login();
    const created = await createBookmark(token, "https://example.com/live/article", {
      saved_via: "ios_shortcut",
    });
    const id = created.item.bookmark.id;
    const capture = await request(`http://localhost/bookmarks/${id}/capture`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/html; charset=utf-8",
      },
      body: `
        <html><head>
          <title>Captured title</title>
          <meta property="og:image" content="/captured-lead.jpg">
        </head><body><article>
          <h1>Captured title</h1>
          <p>${"Private client-rendered article content remains available offline. ".repeat(8)}</p>
          <a href="/relative" onclick="steal()">relative link</a>
          <script>steal()</script><iframe src="https://evil.example"></iframe>
        </article></body></html>
      `,
    });
    expect(capture.status).toBe(200);
    const mutation = await json<BookmarkMutationResponse>(capture);
    expect(mutation.item.bookmark.title).toBe("Captured title");
    expect(mutation.item.bookmark.title_source).toBe("client");
    expect(mutation.item.bookmark.image_url)
      .toBe("https://example.com/captured-lead.jpg");
    expect(mutation.item.article).toMatchObject({ status: "complete", content_source: "client" });
    expect(mutation.item.article).not.toHaveProperty("content_html");

    const body = await request(
      `http://localhost/articles/${mutation.item.article!.id}/body`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(body.status).toBe(200);
    expect(body.headers.get("Content-Type")).toContain("text/html");
    expect(body.headers.get("Cache-Control")).toBe("private, no-store");
    expect(body.headers.get("ETag")).toBe(`"${mutation.item.article!.id}"`);
    const html = await body.text();
    expect(html).toContain('href="https://example.com/relative"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");

    expect((await request(`http://localhost/bookmarks/${id}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(404);
  });

  it("preserves a complete generation when a later client capture fails", async () => {
    const { token } = await login();
    const created = await createBookmark(token, "https://example.com/preserve", {
      saved_via: "extension",
    });
    const id = created.item.bookmark.id;
    const good = await request(`http://localhost/bookmarks/${id}/capture`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/html",
      },
      body: `<article><p>${"complete private article content ".repeat(10)}</p></article>`,
    });
    const generation = (await json<BookmarkMutationResponse>(good)).item.article!.id;

    const failed = await request(`http://localhost/bookmarks/${id}/capture`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/html",
      },
      body: "<p>too short</p>",
    });
    const result = await json<BookmarkMutationResponse>(failed);
    expect(result.item.article).toMatchObject({ id: generation, status: "complete" });
    expect((await store.getArticleContentByBookmarkId(user.id, id))?.id).toBe(generation);
  });

  it("enforces raw capture content type and streamed byte limits", async () => {
    const { token } = await login();
    const created = await createBookmark(token, "https://example.com/limits");
    const id = created.item.bookmark.id;

    const wrongType = await request(`http://localhost/bookmarks/${id}/capture`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);

    const bytes = new TextEncoder().encode("x".repeat(5 * 1024 * 1024 + 1));
    const oversized = await request(new Request(
      `http://localhost/bookmarks/${id}/capture`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "text/html",
          "Content-Length": "1",
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    ));
    expect(oversized.status).toBe(413);
    expect((await json<{ error: { code: string } }>(oversized)).error.code)
      .toBe("payload_too_large");
  });

  it("supports client uploads, title precedence, and bounded stored content", async () => {
    const { token } = await login();
    const created = await createBookmark(
      token,
      "https://hackmd.io/@team/note.md?no-meta",
      { saved_via: "extension" },
    );
    const id = created.item.bookmark.id;
    const upload = await request(`http://localhost/bookmarks/${id}/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content_html: `# Shared note\n\n${"Readable markdown paragraph with an external [link](https://example.com). ".repeat(5)}`,
      }),
    });
    const mutation = await json<BookmarkMutationResponse>(upload);
    expect(mutation.item.bookmark).toMatchObject({ title: "Shared note", title_source: "client" });
    const stored = await store.getArticleContentByBookmarkId(user.id, id);
    expect(stored?.contentHtml).toContain("<h1>Shared note</h1>");
    expect(stored?.contentHtml).toContain('href="https://example.com"');

    await request(`http://localhost/bookmarks/${id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "My note" }),
    });
    await request(`http://localhost/bookmarks/${id}/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content_html: `<p>${"another readable client capture ".repeat(8)}</p>`,
        title: "Ignored title",
      }),
    });
    expect((await store.getBookmarkById(user.id, id))?.title).toBe("My note");

    const large = await createBookmark(token, "https://example.com/large");
    const tooLarge = await request(
      `http://localhost/bookmarks/${large.item.bookmark.id}/content`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content_html: `<p>${"readable ".repeat(190_000)}</p>` }),
      },
    );
    expect(tooLarge.status).toBe(422);
    expect((await json<{ error: { code: string } }>(tooLarge)).error.code)
      .toBe("stored_content_too_large");
  });

  it("runs server extraction synchronously, skips complete content, and honors force", async () => {
    const { token } = await login();
    const created = await createBookmark(token, "https://example.com/extract");
    const id = created.item.bookmark.id;
    expect(extractCalls).toHaveLength(0);

    const first = await extractBookmark(token, id);
    expect(first.status).toBe(200);
    expect((await json<BookmarkMutationResponse>(first)).item.article?.status).toBe("complete");
    expect(extractCalls).toEqual([{ id, force: false }]);

    await extractBookmark(token, id);
    expect(extractCalls).toHaveLength(1);
    await extractBookmark(token, id, true);
    expect(extractCalls).toEqual([{ id, force: false }, { id, force: true }]);

    const client = await createBookmark(token, "https://example.com/client");
    const clientId = client.item.bookmark.id;
    await request(`http://localhost/bookmarks/${clientId}/capture`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/html" },
      body: `<article><p>${"client content remains authoritative ".repeat(8)}</p></article>`,
    });
    const forceClient = await extractBookmark(token, clientId, true);
    expect(forceClient.status).toBe(409);
    expect((await json<{ error: { code: string } }>(forceClient)).error.code)
      .toBe("client_content_exists");

    const social = await createBookmark(token, "https://x.com/example/status/12345");
    const unavailable = await extractBookmark(token, social.item.bookmark.id);
    expect(unavailable.status).toBe(409);
    expect((await json<{ error: { code: string } }>(unavailable)).error.code)
      .toBe("extraction_unavailable");
  });

  it("serves a paginated metadata manifest with a separate monotonic revision", async () => {
    const { token } = await login();
    const initialRevision = await request("http://localhost/sync/revision", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await json(initialRevision)).toEqual({ revision: 0 });
    expect(initialRevision.headers.get("Cache-Control")).toBe("no-store");

    const first = await createBookmark(token, "https://example.com/one");
    await createBookmark(token, "https://example.com/two");
    await createBookmark(token, "https://example.com/three");
    await extractBookmark(token, first.item.bookmark.id);

    const pageOneResponse = await request("http://localhost/sync/manifest?limit=2", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const pageOne = await json<ManifestResponse>(pageOneResponse);
    expect(pageOne.items).toHaveLength(2);
    expect(pageOne.next_cursor).not.toBeNull();
    expect(pageOne.items.every((item) => !Object.hasOwn(item.article ?? {}, "content_html")))
      .toBe(true);

    const pageTwo = await json<ManifestResponse>(await request(
      `http://localhost/sync/manifest?limit=2&cursor=${encodeURIComponent(pageOne.next_cursor!)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ));
    expect(pageTwo.items).toHaveLength(1);
    expect(pageTwo.next_cursor).toBeNull();

    const revision = await json<{ revision: number }>(await request(
      "http://localhost/sync/revision",
      { headers: { Authorization: `Bearer ${token}` } },
    ));
    expect(revision.revision).toBeGreaterThan(0);
    expect((await request("http://localhost/sync/manifest?cursor=invalid", {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(400);
    expect((await request("http://localhost/sync/manifest?limit=101", {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(400);
  });

  it("removes the legacy list, status, bundle, and JSON body read routes", async () => {
    const { token } = await login();
    const headers = { Authorization: `Bearer ${token}` };
    expect((await request("http://localhost/bookmarks", { headers })).status).toBe(404);
    expect((await request("http://localhost/offline/status", { headers })).status).toBe(404);
    expect((await request("http://localhost/offline/bundle", { headers })).status).toBe(404);
    expect((await request("http://localhost/bookmarks/unknown/content", { headers })).status)
      .toBe(404);
  });

  it("publishes metadata and HTML separately, idempotently, and revokes on replacement", async () => {
    const { token } = await login();
    const created = await createBookmark(token, "https://example.com/shareable", {
      image_url: "https://cdn.example.com/shareable.jpg",
    });
    const id = created.item.bookmark.id;
    await extractBookmark(token, id);
    const revisionBeforeShare = (await json<{ revision: number }>(await request(
      "http://localhost/sync/revision",
      { headers: { Authorization: `Bearer ${token}` } },
    ))).revision;

    const enabledResponse = await request(`http://localhost/bookmarks/${id}/share`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(enabledResponse.status).toBe(200);
    const enabled = await json<{
      item: { enabled: boolean; share_url: string; created_at: string };
    }>(enabledResponse);
    const tokenPart = enabled.item.share_url.split("/s/")[1];
    const second = await json<typeof enabled>(await request(
      `http://localhost/bookmarks/${id}/share`,
      { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
    ));
    expect(second.item.share_url).toBe(enabled.item.share_url);

    const metadataResponse = await request(`http://localhost/public/shares/${tokenPart}`);
    const metadata = await json<{
      item: {
        article_id: string;
        title: string;
        url: string;
        image_url: string | null;
        content_html?: string;
      };
    }>(metadataResponse);
    expect(metadata.item).toMatchObject({
      title: "example.com",
      url: "https://example.com/shareable",
      image_url: "https://cdn.example.com/shareable.jpg",
    });
    expect(metadata.item.content_html).toBeUndefined();
    expect(metadataResponse.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const bodyResponse = await request(`http://localhost/public/shares/${tokenPart}/body`);
    expect(bodyResponse.status).toBe(200);
    expect(await bodyResponse.text()).toContain("offline article text");
    expect(bodyResponse.headers.get("ETag")).toBe(`"${metadata.item.article_id}"`);

    const revisionAfterRead = (await json<{ revision: number }>(await request(
      "http://localhost/sync/revision",
      { headers: { Authorization: `Bearer ${token}` } },
    ))).revision;
    expect(revisionAfterRead).toBe(revisionBeforeShare);

    await extractBookmark(token, id, true);
    expect((await request(`http://localhost/public/shares/${tokenPart}`)).status).toBe(404);
    expect((await json<{ item: { enabled: boolean } }>(await request(
      `http://localhost/bookmarks/${id}/share`,
      { headers: { Authorization: `Bearer ${token}` } },
    ))).item.enabled).toBe(false);
  });

  it("deletes bookmarks idempotently and creates revocable access tokens", async () => {
    const { token } = await login();
    await createBookmark(token, "https://example.com/delete");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const deleted = await request(
        "http://localhost/bookmarks/by-url?url=https://example.com/delete",
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );
      expect(deleted.status).toBe(204);
    }

    const created = await json<{
      item: { id: string; current: boolean };
      token: string;
    }>(await request("http://localhost/tokens", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "iphone shortcut" }),
    }));
    expect(created.item.current).toBe(false);
    expect(created.token.startsWith("uk_")).toBe(true);
    expect((await request(`http://localhost/tokens/${created.item.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(204);
  });

  it("rejects unauthorized immutable body reads", async () => {
    const { token } = await login();
    const created = await createBookmark(token, "https://example.com/private");
    await extractBookmark(token, created.item.bookmark.id);
    const article = await store.getArticleContentByBookmarkId(
      user.id,
      created.item.bookmark.id,
    );
    expect((await request(`http://localhost/articles/${article!.id}/body`)).status).toBe(401);
    expect((await request(`http://localhost/articles/${article!.id}/body`, {
      headers: { Authorization: "Bearer invalid" },
    })).status).toBe(401);
  });

  it("keeps manifest records scoped to their owner", async () => {
    const { token } = await login();
    const other: BookmarkRecord = {
      id: makeId(),
      userId: "other-user",
      url: "https://example.com/other",
      normalizedUrl: "https://example.com/other",
      bucket: "reading",
      title: "other",
      titleSource: "fallback",
      imageUrl: null,
      siteName: null,
      savedVia: "web",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await store.insertBookmark(other);
    await createBookmark(token, "https://example.com/mine");

    const manifest = await json<ManifestResponse>(await request(
      "http://localhost/sync/manifest",
      { headers: { Authorization: `Bearer ${token}` } },
    ));
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]?.bookmark.url).toBe("https://example.com/mine");
  });
});
