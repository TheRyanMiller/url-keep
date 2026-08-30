import { readdirSync, readFileSync } from "node:fs";
import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { D1Store } from "./d1-store";
import { runOneNarrationCleanup } from "./cleanup";
import {
  authorizedNarrationAudio,
  getBookmarkNarration,
  requestNarration,
} from "./narration";
import type { ArticleContentRecord, Bindings } from "./types";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const TOKEN_ID = "00000000-0000-4000-8000-000000000002";
const BOOKMARK_ID = "00000000-0000-4000-8000-000000000003";
const ARTICLE_ID = "00000000-0000-4000-8000-000000000004";
const AUDIO = new TextEncoder().encode("not a real mp3, but integrity-valid test bytes");
const AUDIO_SHA256 = bytesToHex(sha256(AUDIO));

let miniflare: Miniflare | null = null;

function schemaStatements(sql: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  let trigger = false;
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed && current.length === 0) continue;
    current.push(line);
    if (current.length === 1 && trimmed.startsWith("CREATE TRIGGER")) trigger = true;
    if ((trigger && trimmed === "END;") || (!trigger && trimmed.endsWith(";"))) {
      statements.push(current.join("\n"));
      current = [];
      trigger = false;
    }
  }
  if (current.some((line) => line.trim())) throw new Error("incomplete test schema");
  return statements;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await miniflare?.dispose();
  miniflare = null;
});

async function environment(): Promise<Bindings> {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["DB"],
  }));
  const db = await miniflare.getD1Database("DB") as unknown as D1Database;
  const migrations = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(filename, migrations), "utf8");
    await db.batch(schemaStatements(sql).map((statement) => db.prepare(statement)));
  }
  const now = "2026-08-30T12:00:00.000Z";
  await db.batch([
    db.prepare("INSERT INTO users(id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "reader@example.com", "unused", now),
    db.prepare(
      `INSERT INTO access_tokens(
        id, user_id, name, token_hash, created_at, last_used_at, revoked_at
      ) VALUES (?, ?, 'web app', 'hash', ?, ?, NULL)`,
    ).bind(TOKEN_ID, USER_ID, now, now),
    db.prepare(
      `INSERT INTO bookmarks(
        id, user_id, url, normalized_url, bucket, title, title_source,
        image_url, site_name, saved_via, created_at, updated_at
      ) VALUES (?, ?, 'https://example.com/article', 'https://example.com/article',
        'reading', 'Library label', 'user', NULL, 'Example', 'web', ?, ?)`,
    ).bind(BOOKMARK_ID, USER_ID, now, now),
    db.prepare(
      `INSERT INTO article_content(
        id, bookmark_id, user_id, title, content_html, word_count,
        author, published_date, extraction_status, extraction_error,
        extracted_at, content_source, created_at, updated_at
      ) VALUES (?, ?, ?, 'Document title', ?, 16, NULL, NULL, 'complete', NULL,
        ?, 'server', ?, ?)`,
    ).bind(
      ARTICLE_ID,
      BOOKMARK_ID,
      USER_ID,
      `<h1>Document title</h1><p>${"Narratable article sentence ".repeat(8)}</p>`,
      now,
      now,
      now,
    ),
  ]);
  return {
    DB: db,
    NARRATION_SERVICE_ORIGIN: "https://narration.example.test",
    NARRATION_SERVICE_TOKEN: "service-token",
  };
}

describe("URL Keep narration domain", () => {
  it("publishes once, invalidates with immutable article replacement, and cleans the service", async () => {
    const env = await environment();
    const columns = await env.DB.prepare("PRAGMA table_info(narrations)")
      .all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).not.toContain("audio_key");
    expect(columns.results.map(({ name }) => name)).not.toContain("publish_started_at");
    const schema = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'narrations'",
    ).first<{ sql: string }>();
    expect(schema?.sql).not.toContain("publishing");
    const calls: string[] = [];
    let serviceJobExists = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${new URL(url).pathname}`);
      const jobId = new URL(url).pathname.split("/").at(-1)!;
      if (method === "DELETE") {
        serviceJobExists = false;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/audio")) {
        const requestHeaders = new Headers(init?.headers);
        expect(requestHeaders.has("Cookie")).toBe(false);
        expect(requestHeaders.get("Accept-Encoding")).toBe("identity");
        const requestedRange = requestHeaders.get("Range");
        const ranged = requestedRange === "bytes=4-10";
        const body = ranged ? AUDIO.slice(4, 11) : AUDIO;
        return new Response(body, {
          status: ranged ? 206 : 200,
          headers: {
            "Content-Type": "audio/mpeg",
            "Content-Length": String(body.byteLength),
            "Accept-Ranges": "bytes",
            ...(ranged ? { "Content-Range": `bytes 4-10/${AUDIO.byteLength}` } : {}),
            "X-Content-SHA256": AUDIO_SHA256,
            "X-Audio-Duration-Ms": "1234",
            "X-Engine-Fingerprint": "sha256:engine",
          },
        });
      }
      if (method === "GET" && !serviceJobExists) {
        return Response.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        );
      }
      if (method === "PUT") serviceJobExists = true;
      return Response.json({
        id: jobId,
        status: "ready",
        engine_fingerprint: "sha256:engine",
        audio: {
          sha256: AUDIO_SHA256,
          byte_size: AUDIO.byteLength,
          duration_ms: 1234,
        },
      });
    }));

    const requested = await requestNarration(env, USER_ID, BOOKMARK_ID);
    const duplicate = await requestNarration(env, USER_ID, BOOKMARK_ID);
    expect(duplicate.narration.id).toBe(requested.narration.id);

    const ready = await getBookmarkNarration(env, USER_ID, BOOKMARK_ID);
    expect({ ready, calls }).toMatchObject({
      ready: { status: "ready", audioSha256: AUDIO_SHA256 },
    });
    expect(calls.filter((call) => call.startsWith("PUT "))).toHaveLength(1);
    const audio = await authorizedNarrationAudio(
      env,
      USER_ID,
      BOOKMARK_ID,
      new Headers(),
      "GET",
    );
    expect(audio.headers.get("X-Content-SHA256")).toBe(AUDIO_SHA256);
    expect(audio.headers.get("X-Audio-Duration-Ms")).toBe("1234");
    expect(audio.headers.get("X-Engine-Fingerprint")).toBe("sha256:engine");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(AUDIO);
    const partial = await authorizedNarrationAudio(
      env,
      USER_ID,
      BOOKMARK_ID,
      new Headers({ Range: "bytes=4-10", Cookie: "not-forwarded" }),
      "GET",
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe(`bytes 4-10/${AUDIO.byteLength}`);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(AUDIO.slice(4, 11));

    const replacementId = "00000000-0000-4000-8000-000000000005";
    const now = "2026-08-30T12:05:00.000Z";
    const replacement: ArticleContentRecord = {
      id: replacementId,
      bookmarkId: BOOKMARK_ID,
      userId: USER_ID,
      title: "Replacement title",
      contentHtml: `<p>${"Replacement article sentence ".repeat(8)}</p>`,
      wordCount: 24,
      author: null,
      publishedDate: null,
      extractionStatus: "complete",
      extractionError: null,
      extractedAt: now,
      contentSource: "server",
      createdAt: now,
      updatedAt: now,
    };
    const write = await new D1Store(env.DB).putServerArticleContent(
      replacement,
      undefined,
      ARTICLE_ID,
    );
    expect(write.written).toBe(true);
    expect(await env.DB.prepare("SELECT id FROM article_content WHERE bookmark_id = ?")
      .bind(BOOKMARK_ID).first<{ id: string }>()).toEqual({ id: replacementId });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM narrations")
      .first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM narration_cleanup_jobs")
      .first<{ count: number }>()).toEqual({ count: 1 });

    await runOneNarrationCleanup(env);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM narration_cleanup_jobs")
      .first<{ count: number }>()).toEqual({ count: 0 });
    expect(calls.filter((call) => call.startsWith("DELETE "))).toHaveLength(1);
  });

  it("requeues a submitted job when article replacement wins the submission race", async () => {
    const env = await environment();
    let releasePut!: () => void;
    let markPutStarted!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = resolve;
    });
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    let serviceJobExists = false;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      if (method === "PUT") {
        markPutStarted();
        await putGate;
        serviceJobExists = true;
        return Response.json({ id: url.pathname.split("/").at(-1), status: "queued" });
      }
      if (method === "DELETE") {
        if (!serviceJobExists) {
          return Response.json({ error: { code: "not_found" } }, { status: 404 });
        }
        serviceJobExists = false;
        return new Response(null, { status: 204 });
      }
      throw new Error("unexpected service request");
    }));

    const request = requestNarration(env, USER_ID, BOOKMARK_ID);
    await putStarted;
    const pending = await env.DB.prepare(
      "SELECT service_job_id FROM narrations WHERE article_id = ?",
    ).bind(ARTICLE_ID).first<{ service_job_id: string }>();
    expect(pending?.service_job_id).toBeTruthy();

    const now = "2026-08-30T12:05:00.000Z";
    const replacement: ArticleContentRecord = {
      id: "00000000-0000-4000-8000-000000000006",
      bookmarkId: BOOKMARK_ID,
      userId: USER_ID,
      title: "Replacement title",
      contentHtml: `<p>${"Replacement article sentence ".repeat(8)}</p>`,
      wordCount: 24,
      author: null,
      publishedDate: null,
      extractionStatus: "complete",
      extractionError: null,
      extractedAt: now,
      contentSource: "server",
      createdAt: now,
      updatedAt: now,
    };
    expect((await new D1Store(env.DB).putServerArticleContent(
      replacement,
      undefined,
      ARTICLE_ID,
    )).written).toBe(true);

    expect(await runOneNarrationCleanup(env)).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM narration_cleanup_jobs")
      .first<{ count: number }>()).toEqual({ count: 0 });

    releasePut();
    await expect(request).rejects.toMatchObject({
      code: "article_changed",
      status: 409,
      retryable: true,
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM narrations")
      .first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT service_job_id FROM narration_cleanup_jobs")
      .first<{ service_job_id: string }>()).toEqual({ service_job_id: pending!.service_job_id });

    expect(await runOneNarrationCleanup(env)).toBe(true);
    expect(serviceJobExists).toBe(false);
    expect(calls.filter((call) => call.startsWith("DELETE "))).toHaveLength(2);
  });
});
