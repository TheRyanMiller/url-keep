import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import type { UrlKeepClient } from "@url-keep/api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOfflineData,
  getOfflineDb,
  getPrivateStorageGeneration,
} from "../offline/db";
import {
  downloadVerifiedAudio,
  getAudioSettings,
  getOfflineAudioUsage,
  persistVerifiedAudio,
  readVerifiedCachedAudio,
  updateAudioSettings,
} from "./offline-audio";

class TestCache {
  readonly rows = new Map<string, Response>();

  async match(input: RequestInfo | URL) {
    return this.rows.get(String(input instanceof Request ? input.url : input))?.clone();
  }

  async put(input: RequestInfo | URL, response: Response) {
    const barrier = cachePutBarrier;
    cachePutBarrier = null;
    if (barrier) {
      barrier.started();
      await barrier.wait;
    }
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
let cachePutBarrier: {
  started: () => void;
  wait: Promise<void>;
} | null = null;
const articleId = "00000000-0000-4000-8000-000000000002";
const narrationId = "00000000-0000-4000-8000-000000000001";

function audioFixture(value = "verified audio bytes") {
  const bytes = new TextEncoder().encode(value);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const summary = {
    id: narrationId,
    article_id: articleId,
    sha256,
    byte_size: bytes.byteLength,
    duration_ms: 1000,
  };
  const response = () => new Response(bytes, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(bytes.byteLength),
      "X-Content-SHA256": sha256,
    },
  });
  return { bytes, response, sha256, summary };
}

beforeEach(async () => {
  stores.clear();
  cachePutBarrier = null;
  vi.stubGlobal("location", { origin: "https://url-keep.test" });
  vi.stubGlobal("caches", {
    open: vi.fn(async (name: string) => {
      if (!stores.has(name)) stores.set(name, new TestCache());
      return stores.get(name)!;
    }),
    delete: vi.fn(async (name: string) => stores.delete(name)),
  });
  await clearOfflineData();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("offline narration audio", () => {
  it("downloads once, verifies the response, and persists the same bytes", async () => {
    const fixture = audioFixture();
    const client = {
      getNarrationAudio: vi.fn(async () => fixture.response()),
    } as unknown as UrlKeepClient;
    const controller = new AbortController();

    const bytes = await downloadVerifiedAudio(
      client,
      "bookmark-1",
      fixture.summary,
      controller.signal,
    );
    expect(client.getNarrationAudio).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(bytes)).toBe("verified audio bytes");

    expect((await getAudioSettings()).enabled).toBe(true);
    await updateAudioSettings({ enabled: false });
    expect(await persistVerifiedAudio(
      fixture.summary,
      bytes,
      controller.signal,
      getPrivateStorageGeneration(),
    )).toBe(false);
    await updateAudioSettings({ enabled: true });
    expect(await persistVerifiedAudio(
      fixture.summary,
      bytes,
      controller.signal,
      getPrivateStorageGeneration(),
    )).toBe(true);
    expect(client.getNarrationAudio).toHaveBeenCalledTimes(1);
    expect(await getOfflineAudioUsage()).toEqual({ bytes: fixture.bytes.byteLength, count: 1 });
    expect(new TextDecoder().decode(
      (await readVerifiedCachedAudio(fixture.summary))!,
    )).toBe("verified audio bytes");
  });

  it("rejects a response whose declared integrity does not match its body", async () => {
    const fixture = audioFixture("wrong audio");
    const client = {
      getNarrationAudio: vi.fn(async () => new Response(fixture.bytes, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(fixture.bytes.byteLength),
          "X-Content-SHA256": "0".repeat(64),
        },
      })),
    } as unknown as UrlKeepClient;

    await expect(downloadVerifiedAudio(client, "bookmark-1", {
      ...fixture.summary,
      sha256: "0".repeat(64),
    })).rejects.toThrow("invalid audio response");
    expect(await getOfflineAudioUsage()).toEqual({ bytes: 0, count: 0 });
  });

  it("removes invalid cached bytes and treats LRU updates as best effort", async () => {
    const fixture = audioFixture();
    const controller = new AbortController();
    await updateAudioSettings({ enabled: true });
    await persistVerifiedAudio(
      fixture.summary,
      fixture.bytes.buffer as ArrayBuffer,
      controller.signal,
      getPrivateStorageGeneration(),
    );

    const db = await getOfflineDb();
    vi.spyOn(db, "put").mockRejectedValueOnce(new Error("touch failed"));
    expect(await readVerifiedCachedAudio(fixture.summary)).not.toBeNull();

    const key = `https://url-keep.test/__audio/${narrationId}/${fixture.sha256}.mp3`;
    await stores.get("url-keep-audio")!.put(key, new Response("corrupt", {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": "7",
        "X-Content-SHA256": fixture.sha256,
      },
    }));
    expect(await readVerifiedCachedAudio(fixture.summary)).toBeNull();
    expect(await getOfflineAudioUsage()).toEqual({ bytes: 0, count: 0 });
  });

  it("cleans up a cache object when its ledger write fails", async () => {
    const fixture = audioFixture();
    const controller = new AbortController();
    await updateAudioSettings({ enabled: true });
    const db = await getOfflineDb();
    vi.spyOn(db, "put").mockRejectedValueOnce(new Error("ledger failed"));

    expect(await persistVerifiedAudio(
      fixture.summary,
      fixture.bytes.buffer as ArrayBuffer,
      controller.signal,
      getPrivateStorageGeneration(),
    )).toBe(false);
    expect(await stores.get("url-keep-audio")?.keys()).toEqual([]);
    expect(await getOfflineAudioUsage()).toEqual({ bytes: 0, count: 0 });
  });

  it("does not persist after the private-storage generation changes", async () => {
    const fixture = audioFixture();
    const controller = new AbortController();
    await updateAudioSettings({ enabled: true });
    const oldGeneration = getPrivateStorageGeneration();
    await clearOfflineData();

    expect(await persistVerifiedAudio(
      fixture.summary,
      fixture.bytes.buffer as ArrayBuffer,
      controller.signal,
      oldGeneration,
    )).toBe(false);
    expect(await getOfflineAudioUsage()).toEqual({ bytes: 0, count: 0 });
  });

  it("removes an in-flight cache write that loses a logout race", async () => {
    const fixture = audioFixture();
    const controller = new AbortController();
    await updateAudioSettings({ enabled: true });
    const oldGeneration = getPrivateStorageGeneration();
    let announcePut!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      announcePut = resolve;
    });
    let releasePut!: () => void;
    const waitForRelease = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    cachePutBarrier = { started: announcePut, wait: waitForRelease };

    const persistence = persistVerifiedAudio(
      fixture.summary,
      fixture.bytes.buffer as ArrayBuffer,
      controller.signal,
      oldGeneration,
    );
    await putStarted;
    const staleCache = stores.get("url-keep-audio")!;
    await clearOfflineData();
    releasePut();

    expect(await persistence).toBe(false);
    expect(await staleCache.keys()).toEqual([]);
    expect(await getOfflineAudioUsage()).toEqual({ bytes: 0, count: 0 });
  });
});
