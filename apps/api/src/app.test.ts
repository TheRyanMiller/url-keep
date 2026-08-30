import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { MemoryStore } from "./memory-store";
import { hashPassword, nowIso } from "./utils";
import type { UserRecord } from "./types";

const TEST_ENV = {
  DB: {} as D1Database,
  TOKEN_PEPPER: "pepper",
  APP_ORIGIN: "http://localhost:5173",
  ALLOWED_EXTENSION_ORIGINS: "chrome-extension://test",
};

async function json<T>(response: Response) {
  return (await response.json()) as T;
}

describe("api", () => {
  let store: MemoryStore;
  let app: ReturnType<typeof createApp>;
  let user: UserRecord;
  let extractCalls: string[];

  function createExecutionContext() {
    const promises: Promise<unknown>[] = [];
    return {
      ctx: {
        passThroughOnException() {
          return undefined;
        },
        props: {},
        waitUntil(promise: Promise<unknown>) {
          promises.push(promise);
        },
      } as unknown as ExecutionContext,
      promises,
    };
  }

  async function request(
    input: string,
    init?: RequestInit,
    env: typeof TEST_ENV = TEST_ENV,
  ) {
    const execution = createExecutionContext();
    const response = await app.request(input, init, env, execution.ctx);
    await Promise.allSettled(execution.promises);
    return response;
  }

  async function requestObject(input: Request) {
    const execution = createExecutionContext();
    const response = await app.request(input, undefined, TEST_ENV, execution.ctx);
    await Promise.allSettled(execution.promises);
    return response;
  }

  beforeEach(async () => {
    store = new MemoryStore();
    extractCalls = [];
    app = createApp({
      store,
      extractBookmark: async ({ store: targetStore, bookmark }) => {
        extractCalls.push(bookmark.id);
        const now = nowIso();
        const content = {
          id: `content-${bookmark.id}`,
          bookmarkId: bookmark.id,
          userId: bookmark.userId,
          title: bookmark.title,
          contentHtml: "<article><p>offline article</p></article>",
          wordCount: 2,
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
        await targetStore.putServerArticleContent(
          content,
          undefined,
          existing?.id ?? null,
        );
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
    }, TEST_ENV);

    expect(response.status).toBe(200);
    return json<{ token: string }>(response);
  }

  async function createBookmark(
    token: string,
    url: string,
    savedVia: "web" | "extension" | "mobile_web" | "ios_shortcut" = "web",
  ) {
    const response = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        saved_via: savedVia,
      }),
    }, TEST_ENV);

    expect(response.status).toBe(201);
    return json<{ item: { id: string; url: string; title: string } }>(response);
  }

  it("logs in successfully and rejects bad credentials", async () => {
    const success = await login();
    expect(success.token.startsWith("uk_")).toBe(true);

    const failure = await app.request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: "wrong",
        client_name: "web app",
      }),
    }, TEST_ENV);

    expect(failure.status).toBe(401);
  });

  it("returns CORS headers for login preflight when origin is allowed", async () => {
    const response = await request(
      "http://localhost/auth/login",
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
      {
        ...TEST_ENV,
        APP_ORIGIN: '"http://localhost:5173", http://127.0.0.1:5173',
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173",
    );
  });

  it("supports auth/me with bearer auth", async () => {
    const { token } = await login();
    const response = await request("http://localhost/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = await json<{ user: { email: string } }>(response);
    expect(body.user.email).toBe(user.email);
  });

  it("creates bookmarks and upgrades fallback titles on duplicate save", async () => {
    const { token } = await login();

    const create = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/post",
        saved_via: "web",
      }),
    });

    expect(create.status).toBe(201);
    const created = await json<{ item: { title: string; bucket: string; extraction_status: string } }>(create);
    expect(created.item.title).toBe("example.com");
    expect(created.item.bucket).toBe("reading");
    expect(created.item.extraction_status).toBe("pending");

    const upgrade = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/post",
        title: "Real Title",
        saved_via: "extension",
      }),
    });

    expect(upgrade.status).toBe(200);
    const upgraded = await json<{ item: { title: string; saved_via: string } }>(upgrade);
    expect(upgraded.item.title).toBe("Real Title");
    expect(upgraded.item.saved_via).toBe("web");
  });

  it("returns a normal JSON response for ios shortcut saves", async () => {
    const { token } = await login();

    const response = await request(
      "http://localhost/bookmarks",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: "https://example.com/shortcut",
          saved_via: "ios_shortcut",
        }),
      },
      TEST_ENV,
    );

    expect(response.status).toBe(201);
    const body = await json<{ item: { url: string; saved_via: string } }>(response);
    expect(body.item.url).toBe("https://example.com/shortcut");
    expect(body.item.saved_via).toBe("ios_shortcut");
  });

  it("extracts and sanitizes a live captured page before server fallback", async () => {
    const { token } = await login();
    const response = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/live/article",
        title: "Browser title",
        saved_via: "extension",
        captured_page: {
          base_url: "https://example.com/live/article",
          html: `
            <html><head><title>Captured title</title></head><body><article>
              <h1>Captured title</h1>
              <p>This signed-in page contains enough readable words to make the browser capture
              canonical and prove the live document path works for private client-rendered pages.</p>
              <p>A second substantial paragraph keeps Readability above its threshold and includes
              a <a href="/relative" onclick="steal()">relative link</a>.</p>
              <script>steal()</script><iframe src="https://evil.example"></iframe>
            </article></body></html>
          `,
        },
      }),
    });

    expect(response.status).toBe(201);
    const created = await json<{ item: { id: string } }>(response);
    const stored = await store.getArticleContentByBookmarkId(user.id, created.item.id);
    expect(stored?.contentSource).toBe("client");
    expect(stored?.extractionStatus).toBe("complete");
    expect(stored?.contentHtml).toContain('href="https://example.com/relative"');
    expect(stored?.contentHtml).not.toContain("script");
    expect(stored?.contentHtml).not.toContain("iframe");
    expect(extractCalls).toHaveLength(0);
  });

  it("falls back to server extraction when a live capture is unreadable", async () => {
    const { token } = await login();
    const response = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/fallback",
        saved_via: "extension",
        captured_page: {
          base_url: "https://example.com/fallback",
          html: "<html><body><p>too short</p></body></html>",
        },
      }),
    });

    expect(response.status).toBe(201);
    expect(extractCalls).toHaveLength(1);
  });

  it("counts streamed request bytes even when content-length claims a smaller body", async () => {
    const { token } = await login();
    const response = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": "1",
      },
      body: JSON.stringify({
        url: "https://example.com/oversized",
        saved_via: "extension",
        captured_page: {
          base_url: "https://example.com/oversized",
          html: "x".repeat(5 * 1024 * 1024),
        },
      }),
    });

    expect(response.status).toBe(413);
    const body = await json<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("payload_too_large");
  });

  it("accepts small streamed bodies without length and ignores a false-high declaration", async () => {
    const { token } = await login();
    const body = JSON.stringify({
      url: "https://x.com/example/status/streamed",
      saved_via: "web",
    });
    const bytes = new TextEncoder().encode(body);
    const streamed = await requestObject(new Request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 10));
          controller.enqueue(bytes.slice(10));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" }));
    expect(streamed.status).toBe(201);

    const falseHigh = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": String(9 * 1024 * 1024),
      },
      body: JSON.stringify({
        url: "https://x.com/example/status/false-high",
        saved_via: "web",
      }),
    });
    expect(falseHigh.status).toBe(201);
  });

  it("rejects sanitized article content above the storage limit", async () => {
    const { token } = await login();
    const created = await createBookmark(token, "https://example.com/large-content");
    const response = await request(
      `http://localhost/bookmarks/${created.item.id}/content`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content_html: `<p>${"readable ".repeat(190_000)}</p>`,
        }),
      },
    );

    expect(response.status).toBe(422);
    const body = await json<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("stored_content_too_large");
  });

  it("classifies video bookmarks into videos and filters them server-side", async () => {
    const { token } = await login();

    const videoCreate = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://youtu.be/abc123",
        saved_via: "extension",
      }),
    }, TEST_ENV);

    expect(videoCreate.status).toBe(201);
    const video = await json<{
      item: {
        id: string;
        bucket: string;
        extraction_status: string | null;
      };
    }>(videoCreate);
    expect(video.item.bucket).toBe("videos");
    expect(video.item.extraction_status).toBeNull();
    expect(extractCalls).toHaveLength(0);

    const articleCreate = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/article",
        saved_via: "web",
      }),
    }, TEST_ENV);
    expect(articleCreate.status).toBe(201);
    expect(extractCalls).toHaveLength(1);

    const videosResponse = await request("http://localhost/bookmarks?bucket=videos", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(videosResponse.status).toBe(200);
    const videos = await json<{ items: Array<{ id: string; bucket: string }> }>(videosResponse);
    expect(videos.items).toHaveLength(1);
    expect(videos.items[0]?.id).toBe(video.item.id);
    expect(videos.items[0]?.bucket).toBe("videos");

    const readingResponse = await request("http://localhost/bookmarks?bucket=reading", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(readingResponse.status).toBe(200);
    const reading = await json<{ items: Array<{ bucket: string }> }>(readingResponse);
    expect(reading.items).toHaveLength(1);
    expect(reading.items[0]?.bucket).toBe("reading");
  });

  it("leaves extension article capture to the MV3 workflow", async () => {
    const { token } = await login();
    const response = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/extension-capture",
        saved_via: "extension",
      }),
    });

    expect(response.status).toBe(201);
    const body = await json<{ item: { extraction_status: string } }>(response);
    expect(body.item.extraction_status).toBe("pending");
    expect(extractCalls).toHaveLength(0);
  });

  it("does not auto-extract non-reader reading urls", async () => {
    const { token } = await login();

    const create = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://x.com/example/status/12345",
        saved_via: "web",
      }),
    }, TEST_ENV);

    expect(create.status).toBe(201);
    const created = await json<{
      item: {
        id: string;
        bucket: string;
        extraction_status: string | null;
      };
    }>(create);
    expect(created.item.bucket).toBe("reading");
    expect(created.item.extraction_status).toBeNull();
    expect(extractCalls).toHaveLength(0);

    const extract = await request(
      `http://localhost/bookmarks/${created.item.id}/extract`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );

    expect(extract.status).toBe(409);
    const error = await json<{ error: { code: string } }>(extract);
    expect(error.error.code).toBe("extraction_unavailable");
  });

  it("preserves user edited titles on later duplicate saves", async () => {
    const { token } = await login();

    const create = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/post",
        title: "Original",
        saved_via: "extension",
      }),
    }, TEST_ENV);
    const created = await json<{ item: { id: string } }>(create);

    const edit = await request(
      `http://localhost/bookmarks/${created.item.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "My Title" }),
      },
      TEST_ENV,
    );
    expect(edit.status).toBe(200);

    const duplicate = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/post",
        title: "New Remote Title",
        saved_via: "extension",
      }),
    }, TEST_ENV);

    const result = await json<{ item: { title: string } }>(duplicate);
    expect(result.item.title).toBe("My Title");
  });

  it("canonicalizes HackMD raw markdown URLs on save", async () => {
    const { token } = await login();

    const create = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://hackmd.io/@murderteeth/S1A4kz-9bg.md?no-meta",
        title: "https://hackmd.io/@murderteeth/S1A4kz-9bg.md?no-meta",
        saved_via: "extension",
      }),
    }, TEST_ENV);

    expect(create.status).toBe(201);
    const created = await json<{ item: { id: string; title: string; url: string } }>(create);
    expect(created.item.url).toBe("https://hackmd.io/@murderteeth/S1A4kz-9bg");
    expect(created.item.title).toBe("hackmd.io");

    const duplicate = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://hackmd.io/@murderteeth/S1A4kz-9bg?type=view",
        saved_via: "extension",
      }),
    }, TEST_ENV);

    expect(duplicate.status).toBe(200);
    const duplicated = await json<{ item: { id: string; url: string } }>(duplicate);
    expect(duplicated.item.id).toBe(created.item.id);
    expect(duplicated.item.url).toBe("https://hackmd.io/@murderteeth/S1A4kz-9bg");
  });

  it("renders uploaded HackMD markdown to HTML and upgrades fallback titles", async () => {
    const { token } = await login();

    const create = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://hackmd.io/@murderteeth/S1A4kz-9bg.md?no-meta",
        saved_via: "extension",
      }),
    }, TEST_ENV);
    const created = await json<{ item: { id: string } }>(create);

    const upload = await request(
      `http://localhost/bookmarks/${created.item.id}/content`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content_html: `
# My Shared Note
this is a paragraph with an [external link](https://example.com) that should render as html instead of being stored as raw markdown.

another paragraph keeps the content comfortably above the minimum length requirement for saved article content.
          `.trim(),
        }),
      },
      TEST_ENV,
    );

    expect(upload.status).toBe(200);
    const uploaded = await json<{ item: { content_html: string | null } }>(upload);
    expect(uploaded.item.content_html).toContain("<h1>My Shared Note</h1>");
    expect(uploaded.item.content_html).toContain(
      "<a href=\"https://example.com\" target=\"_blank\" rel=\"noopener noreferrer\">external link</a>",
    );
    expect(uploaded.item.content_html).not.toContain("[external link](");

    const bookmark = await store.getBookmarkById(user.id, created.item.id);
    expect(bookmark?.title).toBe("My Shared Note");
    expect(bookmark?.siteName).toBe("HackMD");
  });

  it("lets client recaptures refresh client metadata but never a user title", async () => {
    const { token } = await login();
    const created = await createBookmark(token, "https://example.com/metadata", "extension");
    const content = `<article><p>${"readable captured content ".repeat(8)}</p></article>`;

    await request(`http://localhost/bookmarks/${created.item.id}/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content_html: content, title: "First capture" }),
    });
    await request(`http://localhost/bookmarks/${created.item.id}/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content_html: content, title: "Fresh capture" }),
    });
    expect((await store.getBookmarkById(user.id, created.item.id))?.title)
      .toBe("Fresh capture");

    await request(`http://localhost/bookmarks/${created.item.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "My title" }),
    });
    await request(`http://localhost/bookmarks/${created.item.id}/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content_html: content, title: "Ignored capture" }),
    });
    const bookmark = await store.getBookmarkById(user.id, created.item.id);
    expect(bookmark?.title).toBe("My title");
    expect(bookmark?.titleSource).toBe("user");
  });

  it("deletes bookmarks idempotently by url", async () => {
    const { token } = await login();
    await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/post",
        saved_via: "web",
      }),
    }, TEST_ENV);

    const firstDelete = await request(
      "http://localhost/bookmarks/by-url?url=https://example.com/post",
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );
    expect(firstDelete.status).toBe(204);

    const secondDelete = await request(
      "http://localhost/bookmarks/by-url?url=https://example.com/post",
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );
    expect(secondDelete.status).toBe(204);
  });

  it("creates and revokes tokens", async () => {
    const { token } = await login();

    const create = await request("http://localhost/tokens", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "iphone shortcut" }),
    }, TEST_ENV);

    expect(create.status).toBe(200);
    const created = await json<{ item: { id: string; current: boolean }; token: string }>(
      create,
    );
    expect(created.item.current).toBe(false);
    expect(created.token.startsWith("uk_")).toBe(true);

    const revoke = await request(
      `http://localhost/tokens/${created.item.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );

    expect(revoke.status).toBe(204);
  });

  it("returns extracted content and offline bundle items", async () => {
    const { token } = await login();

    const create = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/article",
        saved_via: "web",
      }),
    });
    const created = await json<{ item: { id: string } }>(create);

    const contentResponse = await request(
      `http://localhost/bookmarks/${created.item.id}/content`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(contentResponse.status).toBe(200);
    const content = await json<{ item: { extraction_status: string; content_html: string | null } }>(
      contentResponse,
    );
    expect(content.item.extraction_status).toBe("complete");
    expect(content.item.content_html).toContain("offline article");

    const listResponse = await request("http://localhost/bookmarks", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = await json<{ items: Array<{ bucket: string; extraction_status: string | null }> }>(listResponse);
    expect(list.items[0]?.bucket).toBe("reading");
    expect(list.items[0]?.extraction_status).toBe("complete");

    const bundleResponse = await request("http://localhost/offline/bundle", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(bundleResponse.status).toBe(200);
    const bundle = await json<{
      items: Array<{
        bookmark: { id: string; bucket: string };
        content: { extraction_status: string } | null;
      }>;
      has_more: boolean;
    }>(bundleResponse);
    expect(bundle.items[0]?.bookmark.id).toBe(created.item.id);
    expect(bundle.items[0]?.bookmark.bucket).toBe("reading");
    expect(bundle.items[0]?.content?.extraction_status).toBe("complete");
    expect(bundle.has_more).toBe(false);
    expect(bundleResponse.headers.get("Cache-Control")).toBe("no-store");

    const invalidLimit = await request("http://localhost/offline/bundle?limit=11", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(invalidLimit.status).toBe(400);
  });

  it("uses monotonic offline revisions without bumping for share counters", async () => {
    const { token } = await login();
    const emptyResponse = await request("http://localhost/offline/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const empty = await json<{ bookmark_count: number; sync_revision: number }>(emptyResponse);
    expect(empty).toEqual({ bookmark_count: 0, sync_revision: 0 });
    expect(emptyResponse.headers.get("Cache-Control")).toBe("no-store");

    const created = await createBookmark(token, "https://example.com/revision");
    const afterSaveResponse = await request("http://localhost/offline/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const afterSave = await json<{ bookmark_count: number; sync_revision: number }>(afterSaveResponse);
    expect(afterSave.bookmark_count).toBe(1);
    expect(afterSave.sync_revision).toBeGreaterThan(0);

    const enable = await request(
      `http://localhost/bookmarks/${created.item.id}/share`,
      { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
    );
    const share = await json<{ item: { share_url: string } }>(enable);
    const shareToken = share.item.share_url.split("/s/")[1];
    await request(`http://localhost/public/shares/${shareToken}`);

    const afterShare = await request("http://localhost/offline/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await json(afterShare)).toEqual(afterSave);
  });

  it("supports manual extraction retries and content deletion", async () => {
    const { token } = await login();

    const create = await request("http://localhost/bookmarks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/retry",
        saved_via: "web",
      }),
    });
    const created = await json<{ item: { id: string } }>(create);

    expect(extractCalls).toHaveLength(1);

    const noForce = await request(
      `http://localhost/bookmarks/${created.item.id}/extract`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(noForce.status).toBe(200);
    expect(extractCalls).toHaveLength(1);

    const force = await request(
      `http://localhost/bookmarks/${created.item.id}/extract?force=true`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(force.status).toBe(202);
    expect(extractCalls).toHaveLength(2);

    const deleteContent = await request(
      `http://localhost/bookmarks/${created.item.id}/content`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(deleteContent.status).toBe(204);

    const afterDelete = await request(
      `http://localhost/bookmarks/${created.item.id}/content`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const deletedContent = await json<{ item: { extraction_status: string; content_html: string | null } }>(
      afterDelete,
    );
    expect(deletedContent.item.extraction_status).toBe("pending");
    expect(deletedContent.item.content_html).toBeNull();
  });

  it("creates idempotent public share links and tracks hit counts", async () => {
    const { token } = await login();
    const created = await createBookmark(token, "https://example.com/shareable");
    expect(created).not.toBeNull();

    const enable = await request(
      `http://localhost/bookmarks/${created!.item.id}/share`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      },
      {
        ...TEST_ENV,
        APP_ORIGIN: "http://localhost:5173, http://127.0.0.1:5173",
      },
    );
    expect(enable.status).toBe(200);
    const enabled = await json<{
      item: {
        enabled: boolean;
        share_url: string | null;
        hit_count: number;
        last_accessed_at: string | null;
      };
    }>(enable);
    expect(enabled.item.enabled).toBe(true);
    expect(enabled.item.share_url).toContain("http://localhost:5173/s/");
    expect(enabled.item.share_url).toMatch(/\/s\/[a-f0-9]{32}$/);
    expect(enabled.item.hit_count).toBe(0);
    expect(enabled.item.last_accessed_at).toBeNull();

    const secondEnable = await request(
      `http://localhost/bookmarks/${created!.item.id}/share`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      },
      {
        ...TEST_ENV,
        APP_ORIGIN: "http://localhost:5173, http://127.0.0.1:5173",
      },
    );
    const secondEnabled = await json<typeof enabled>(secondEnable);
    expect(secondEnabled.item.share_url).toBe(enabled.item.share_url);

    const publicToken = enabled.item.share_url!.split("/s/")[1];
    const publicRead = await request(
      `http://localhost/public/shares/${publicToken}`,
      undefined,
      TEST_ENV,
    );
    expect(publicRead.status).toBe(200);
    const publicBody = await json<{
      item: {
        title: string;
        url: string;
        content_html: string;
      };
    }>(publicRead);
    expect(publicBody.item.title).toBe("example.com");
    expect(publicBody.item.url).toBe("https://example.com/shareable");
    expect(publicBody.item.content_html).toContain("offline article");
    expect(publicRead.headers.get("Cache-Control")).toBe("no-store");
    expect(publicRead.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const publicReadWithInvalidAuth = await request(
      `http://localhost/public/shares/${publicToken}`,
      {
        headers: { Authorization: "Bearer invalid-token" },
      },
      TEST_ENV,
    );
    expect(publicReadWithInvalidAuth.status).toBe(200);

    const shareState = await request(
      `http://localhost/bookmarks/${created!.item.id}/share`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );
    const shareBody = await json<typeof enabled>(shareState);
    expect(shareBody.item.hit_count).toBe(2);
    expect(shareBody.item.last_accessed_at).not.toBeNull();
  });

  it("allows public sharing for client-captured content", async () => {
    const { token } = await login();
    const created = await createBookmark(token, "https://example.com/client-share");
    expect(created).not.toBeNull();

    const upload = await request(
      `http://localhost/bookmarks/${created!.item.id}/content`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content_html: `
            <article>
              <p>this client captured article has enough text to satisfy the validation rule.</p>
              <p>another paragraph keeps it comfortably above the minimum content threshold for the upload endpoint.</p>
            </article>
          `,
        }),
      },
      TEST_ENV,
    );
    expect(upload.status).toBe(200);

    const share = await request(
      `http://localhost/bookmarks/${created!.item.id}/share`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );
    expect(share.status).toBe(200);
    const body = await json<{ item: { enabled: boolean; share_url: string | null } }>(share);
    expect(body.item.enabled).toBe(true);
    expect(body.item.share_url).toMatch(/\/s\/[a-f0-9]{32}$/);

    const recapture = await request(
      `http://localhost/bookmarks/${created.item.id}/content`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content_html: `<article><p>${"replacement article text ".repeat(8)}</p></article>`,
        }),
      },
    );
    expect(recapture.status).toBe(200);

    const oldPublicToken = body.item.share_url!.split("/s/")[1];
    expect((await request(`http://localhost/public/shares/${oldPublicToken}`)).status).toBe(404);
    const state = await request(
      `http://localhost/bookmarks/${created.item.id}/share`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect((await json<{ item: { enabled: boolean } }>(state)).item.enabled).toBe(false);
  });

  it("returns 404 for revoked or invalid public share links", async () => {
    const { token } = await login();
    const created = await createBookmark(token, "https://example.com/revoked-share");
    expect(created).not.toBeNull();

    const enable = await request(
      `http://localhost/bookmarks/${created!.item.id}/share`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );
    const enabled = await json<{ item: { share_url: string | null } }>(enable);
    const publicToken = enabled.item.share_url!.split("/s/")[1];

    const disable = await request(
      `http://localhost/bookmarks/${created!.item.id}/share`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );
    expect(disable.status).toBe(204);

    const revokedRead = await request(
      `http://localhost/public/shares/${publicToken}`,
      undefined,
      TEST_ENV,
    );
    expect(revokedRead.status).toBe(404);

    const invalidRead = await request(
      "http://localhost/public/shares/not-a-real-token",
      undefined,
      TEST_ENV,
    );
    expect(invalidRead.status).toBe(404);
  });

});
