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
      } satisfies ExecutionContext,
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
        await targetStore.upsertArticleContent(content);
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
    const response = await request("http://localhost/v1/auth/login", {
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

  it("logs in successfully and rejects bad credentials", async () => {
    const success = await login();
    expect(success.token.startsWith("uk_")).toBe(true);

    const failure = await app.request("http://localhost/v1/auth/login", {
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

  it("migrates legacy scrypt password hashes after a successful login", async () => {
    const legacyUser = {
      id: "user-legacy",
      email: "legacy@example.com",
      passwordHash:
        "scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f$9544e48979da3c896dfb7f7f5bc015fb320e810f8372f88d66d9921da5a2aa65",
      createdAt: nowIso(),
    };
    await store.insertUser(legacyUser);

    const response = await app.request(
      "http://localhost/v1/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: legacyUser.email,
          password: "secret",
          client_name: "mobile web",
        }),
      },
      TEST_ENV,
    );

    expect(response.status).toBe(200);
    const migrated = await store.getUserById(legacyUser.id);
    expect(migrated?.passwordHash.startsWith("pbkdf2_sha256$")).toBe(true);
  });

  it("returns CORS headers for login preflight when origin is allowed", async () => {
    const response = await request(
      "http://localhost/v1/auth/login",
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
    const response = await request("http://localhost/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = await json<{ user: { email: string } }>(response);
    expect(body.user.email).toBe(user.email);
  });

  it("creates bookmarks and upgrades fallback titles on duplicate save", async () => {
    const { token } = await login();

    const create = await request("http://localhost/v1/bookmarks", {
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
    const created = await json<{ item: { title: string; extraction_status: string } }>(create);
    expect(created.item.title).toBe("example.com");
    expect(created.item.extraction_status).toBe("pending");

    const upgrade = await request("http://localhost/v1/bookmarks", {
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

  it("returns no content for ios shortcut saves", async () => {
    const { token } = await login();

    const response = await request(
      "http://localhost/v1/bookmarks",
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

    expect(response.status).toBe(204);
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("preserves user edited titles on later duplicate saves", async () => {
    const { token } = await login();

    const create = await request("http://localhost/v1/bookmarks", {
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
      `http://localhost/v1/bookmarks/${created.item.id}`,
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

    const duplicate = await request("http://localhost/v1/bookmarks", {
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

    const create = await request("http://localhost/v1/bookmarks", {
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

    const duplicate = await request("http://localhost/v1/bookmarks", {
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

    const create = await request("http://localhost/v1/bookmarks", {
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
      `http://localhost/v1/bookmarks/${created.item.id}/content`,
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
      "<a href=\"https://example.com\">external link</a>",
    );
    expect(uploaded.item.content_html).not.toContain("[external link](");

    const bookmark = await store.getBookmarkById(user.id, created.item.id);
    expect(bookmark?.title).toBe("My Shared Note");
    expect(bookmark?.siteName).toBe("HackMD");
  });

  it("deletes bookmarks idempotently by url", async () => {
    const { token } = await login();
    await request("http://localhost/v1/bookmarks", {
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
      "http://localhost/v1/bookmarks/by-url?url=https://example.com/post",
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );
    expect(firstDelete.status).toBe(204);

    const secondDelete = await request(
      "http://localhost/v1/bookmarks/by-url?url=https://example.com/post",
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

    const create = await request("http://localhost/v1/tokens", {
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
      `http://localhost/v1/tokens/${created.item.id}`,
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

    const create = await request("http://localhost/v1/bookmarks", {
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
      `http://localhost/v1/bookmarks/${created.item.id}/content`,
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

    const listResponse = await request("http://localhost/v1/bookmarks", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = await json<{ items: Array<{ extraction_status: string | null }> }>(listResponse);
    expect(list.items[0]?.extraction_status).toBe("complete");

    const bundleResponse = await request("http://localhost/v1/offline/bundle", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(bundleResponse.status).toBe(200);
    const bundle = await json<{
      items: Array<{
        bookmark: { id: string };
        content: { extraction_status: string } | null;
      }>;
      has_more: boolean;
    }>(bundleResponse);
    expect(bundle.items[0]?.bookmark.id).toBe(created.item.id);
    expect(bundle.items[0]?.content?.extraction_status).toBe("complete");
    expect(bundle.has_more).toBe(false);
  });

  it("supports manual extraction retries and content deletion", async () => {
    const { token } = await login();

    const create = await request("http://localhost/v1/bookmarks", {
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
      `http://localhost/v1/bookmarks/${created.item.id}/extract`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(noForce.status).toBe(200);
    expect(extractCalls).toHaveLength(1);

    const force = await request(
      `http://localhost/v1/bookmarks/${created.item.id}/extract?force=true`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(force.status).toBe(202);
    expect(extractCalls).toHaveLength(2);

    const deleteContent = await request(
      `http://localhost/v1/bookmarks/${created.item.id}/content`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(deleteContent.status).toBe(204);

    const afterDelete = await request(
      `http://localhost/v1/bookmarks/${created.item.id}/content`,
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
});
