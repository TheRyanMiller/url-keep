import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import type { UrlKeepClient } from "@url-keep/api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearOfflineData } from "../offline/db";
import {
  cacheNarrationAudio,
  getCachedAudio,
  getOfflineAudioUsage,
  updateAudioSettings,
} from "./offline-audio";

class TestCache {
  private rows = new Map<string, Response>();

  async match(input: RequestInfo | URL) {
    return this.rows.get(String(input instanceof Request ? input.url : input))?.clone();
  }

  async put(input: RequestInfo | URL, response: Response) {
    this.rows.set(String(input instanceof Request ? input.url : input), response.clone());
  }

  async delete(input: RequestInfo | URL) {
    return this.rows.delete(String(input instanceof Request ? input.url : input));
  }

  async keys() {
    return [...this.rows.keys()].map((url) => new Request(url));
  }
}

const stores = new Map<string, TestCache>();

beforeEach(async () => {
  stores.clear();
  vi.stubGlobal("location", { origin: "https://url-keep.test" });
  vi.stubGlobal("caches", {
    open: vi.fn(async (name: string) => {
      if (!stores.has(name)) stores.set(name, new TestCache());
      return stores.get(name)!;
    }),
    delete: vi.fn(async (name: string) => stores.delete(name)),
  });
  await clearOfflineData();
  await updateAudioSettings({ enabled: false });
});

afterEach(() => vi.unstubAllGlobals());

describe("offline narration audio", () => {
  it("commits only a size-and-hash verified response", async () => {
    const bytes = new TextEncoder().encode("verified audio bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const client = {
      getNarrationAudio: vi.fn(async () => new Response(bytes, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(bytes.byteLength),
          "X-Content-SHA256": digest,
        },
      })),
    } as unknown as UrlKeepClient;
    const summary = {
      id: "00000000-0000-4000-8000-000000000001",
      article_id: "00000000-0000-4000-8000-000000000002",
      sha256: digest,
      byte_size: bytes.byteLength,
      duration_ms: 1000,
    };

    expect(await cacheNarrationAudio(client, "bookmark-1", summary)).toBe(false);
    expect(client.getNarrationAudio).not.toHaveBeenCalled();
    await updateAudioSettings({ enabled: true });
    expect(await cacheNarrationAudio(client, "bookmark-1", summary)).toBe(true);
    expect(await getOfflineAudioUsage()).toEqual({ bytes: bytes.byteLength, count: 1 });
    expect(await (await getCachedAudio(summary.id, digest))?.text())
      .toBe("verified audio bytes");
  });

  it("does not create a ledger row for mismatched content", async () => {
    const bytes = new TextEncoder().encode("wrong audio");
    const client = {
      getNarrationAudio: vi.fn(async () => new Response(bytes, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(bytes.byteLength),
          "X-Content-SHA256": "0".repeat(64),
        },
      })),
    } as unknown as UrlKeepClient;
    await updateAudioSettings({ enabled: true });
    expect(await cacheNarrationAudio(client, "bookmark-1", {
      id: "00000000-0000-4000-8000-000000000001",
      article_id: "00000000-0000-4000-8000-000000000002",
      sha256: "0".repeat(64),
      byte_size: bytes.byteLength,
      duration_ms: 1000,
    })).toBe(false);
    expect(await getOfflineAudioUsage()).toEqual({ bytes: 0, count: 0 });
  });
});
