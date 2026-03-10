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

  beforeEach(async () => {
    store = new MemoryStore();
    app = createApp({ store });
    user = {
      id: "user-1",
      email: "me@example.com",
      passwordHash: hashPassword("secret"),
      createdAt: nowIso(),
    };
    await store.insertUser(user);
  });

  async function login(clientName = "web app") {
    const response = await app.request("http://localhost/v1/auth/login", {
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

  it("returns CORS headers for login preflight when origin is allowed", async () => {
    const response = await app.request(
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
    const response = await app.request("http://localhost/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    }, TEST_ENV);

    expect(response.status).toBe(200);
    const body = await json<{ user: { email: string } }>(response);
    expect(body.user.email).toBe(user.email);
  });

  it("creates bookmarks and upgrades fallback titles on duplicate save", async () => {
    const { token } = await login();

    const create = await app.request("http://localhost/v1/bookmarks", {
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

    expect(create.status).toBe(201);
    const created = await json<{ item: { title: string } }>(create);
    expect(created.item.title).toBe("example.com");

    const upgrade = await app.request("http://localhost/v1/bookmarks", {
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
    }, TEST_ENV);

    expect(upgrade.status).toBe(200);
    const upgraded = await json<{ item: { title: string; saved_via: string } }>(upgrade);
    expect(upgraded.item.title).toBe("Real Title");
    expect(upgraded.item.saved_via).toBe("web");
  });

  it("preserves user edited titles on later duplicate saves", async () => {
    const { token } = await login();

    const create = await app.request("http://localhost/v1/bookmarks", {
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

    const edit = await app.request(
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

    const duplicate = await app.request("http://localhost/v1/bookmarks", {
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

  it("deletes bookmarks idempotently by url", async () => {
    const { token } = await login();
    await app.request("http://localhost/v1/bookmarks", {
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

    const firstDelete = await app.request(
      "http://localhost/v1/bookmarks/by-url?url=https://example.com/post",
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );
    expect(firstDelete.status).toBe(204);

    const secondDelete = await app.request(
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

    const create = await app.request("http://localhost/v1/tokens", {
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

    const revoke = await app.request(
      `http://localhost/v1/tokens/${created.item.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );

    expect(revoke.status).toBe(204);
  });
});
