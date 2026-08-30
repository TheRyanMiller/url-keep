import { readFileSync } from "node:fs";
import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { D1Store } from "./d1-store";
import { runMaintenance } from "./maintenance";
import {
  getBookmarkNarration,
  reconcileNarration,
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

class TestFixedLengthStream {
  readonly readable: ReadableStream;
  readonly writable: WritableStream;

  constructor(_length: number) {
    const transform = new TransformStream();
    this.readable = transform.readable;
    this.writable = transform.writable;
  }
}

class TestBucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly operations: string[] = [];

  async put(key: string, value: ReadableStream, options: R2PutOptions) {
    this.operations.push(`put:${key}`);
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    const digest = sha256(bytes);
    const expected = new Uint8Array(options.sha256 as ArrayBuffer);
    expect(bytesToHex(digest)).toBe(bytesToHex(expected));
    this.objects.set(key, bytes);
    return {
      key,
      size: bytes.byteLength,
      checksums: { sha256: digest.buffer as ArrayBuffer },
    } as R2Object;
  }

  async head(key: string) {
    this.operations.push(`head:${key}`);
    const bytes = this.objects.get(key);
    return bytes ? { key, size: bytes.byteLength } as R2Object : null;
  }

  async delete(key: string) {
    this.operations.push(`delete:${key}`);
    this.objects.delete(key);
  }
}

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
  const bucket = new TestBucket();
  const schema = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
  await db.batch(schemaStatements(schema).map((statement) => db.prepare(statement)));
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
    NARRATIONS: bucket as unknown as R2Bucket,
    NARRATION_SERVICE_ORIGIN: "https://narration.example.test",
    NARRATION_SERVICE_TOKEN: "service-token",
  };
}

describe("URL Keep narration domain", () => {
  it("publishes once, invalidates with immutable article replacement, and cleans both stores", async () => {
    const env = await environment();
    vi.stubGlobal("FixedLengthStream", TestFixedLengthStream);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      const jobId = new URL(url).pathname.split("/").at(-1)!;
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/audio")) {
        return new Response(AUDIO, {
          headers: {
            "Content-Type": "audio/mpeg",
            "Content-Length": String(AUDIO.byteLength),
            "X-Content-SHA256": AUDIO_SHA256,
            "X-Audio-Duration-Ms": "1234",
            "X-Engine-Fingerprint": "sha256:engine",
          },
        });
      }
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

    const requested = await requestNarration(env, USER_ID, TOKEN_ID, BOOKMARK_ID);
    const duplicate = await requestNarration(env, USER_ID, TOKEN_ID, BOOKMARK_ID);
    expect(duplicate.narration.id).toBe(requested.narration.id);

    await reconcileNarration(env, requested.narration.id);
    const ready = await getBookmarkNarration(env, USER_ID, BOOKMARK_ID);
    expect({ ready, calls }).toMatchObject({
      ready: { status: "ready", audioSha256: AUDIO_SHA256 },
    });
    const testBucket = env.NARRATIONS as unknown as TestBucket;
    expect({ keys: [...testBucket.objects.keys()], operations: testBucket.operations })
      .toMatchObject({ keys: [ready!.audioKey] });
    expect(calls.filter((call) => call.startsWith("PUT "))).toHaveLength(1);

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

    await runMaintenance(env);
    expect(await env.NARRATIONS!.head(ready!.audioKey)).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM narration_cleanup_jobs")
      .first<{ count: number }>()).toEqual({ count: 0 });
  });
});
