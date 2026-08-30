import type { UrlKeepClient } from "@url-keep/api-client";
import type { ReadyNarrationSummary } from "@url-keep/shared";
import {
  getOfflineDb,
  OFFLINE_AUDIO_LIMITS,
  type AudioSettings,
  type OfflineAudioRecord,
} from "../offline/db";

const AUDIO_CACHE = "url-keep-audio";
const DEFAULT_SETTINGS: AudioSettings = {
  key: "audio",
  enabled: false,
  byte_limit: OFFLINE_AUDIO_LIMITS[1],
};

function cacheKey(narrationId: string, sha256: string): string {
  return `${location.origin}/__audio/${narrationId}/${sha256}.mp3`;
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function getAudioSettings(): Promise<AudioSettings> {
  return (await (await getOfflineDb()).get("audio_settings", "audio")) ?? DEFAULT_SETTINGS;
}

export async function updateAudioSettings(
  changes: Partial<Pick<AudioSettings, "enabled" | "byte_limit">>,
): Promise<AudioSettings> {
  const current = await getAudioSettings();
  const next = { ...current, ...changes };
  if (!OFFLINE_AUDIO_LIMITS.includes(next.byte_limit as never)) {
    throw new Error("invalid audio storage limit");
  }
  await (await getOfflineDb()).put("audio_settings", next);
  if (!next.enabled) await clearOfflineAudio();
  else await enforceAudioLimit(next.byte_limit);
  return next;
}

async function deleteRecord(record: OfflineAudioRecord): Promise<void> {
  await (await caches.open(AUDIO_CACHE)).delete(record.cache_key);
  await (await getOfflineDb()).delete("offline_audio", record.narration_id);
}

export async function clearOfflineAudio(): Promise<void> {
  await caches.delete(AUDIO_CACHE);
  await (await getOfflineDb()).clear("offline_audio");
}

export async function getOfflineAudioUsage(): Promise<{
  bytes: number;
  count: number;
}> {
  const rows = await (await getOfflineDb()).getAll("offline_audio");
  return {
    bytes: rows.reduce((total, row) => total + row.byte_size, 0),
    count: rows.length,
  };
}

async function enforceAudioLimit(limit: number, incomingBytes = 0): Promise<boolean> {
  if (incomingBytes > limit) return false;
  const db = await getOfflineDb();
  const rows = (await db.getAllFromIndex("offline_audio", "by-accessed"));
  let total = rows.reduce((sum, row) => sum + row.byte_size, 0);
  for (const row of rows) {
    if (total + incomingBytes <= limit) break;
    await deleteRecord(row);
    total -= row.byte_size;
  }
  return total + incomingBytes <= limit;
}

export async function getCachedAudio(
  narrationId: string,
  sha256: string,
): Promise<Response | null> {
  const db = await getOfflineDb();
  const record = await db.get("offline_audio", narrationId);
  if (!record) return null;
  if (record.sha256 !== sha256) {
    await deleteRecord(record);
    return null;
  }
  const response = await (await caches.open(AUDIO_CACHE)).match(record.cache_key);
  if (!response) {
    await db.delete("offline_audio", narrationId);
    return null;
  }
  record.last_accessed_at = new Date().toISOString();
  await db.put("offline_audio", record);
  return response;
}

export async function getCachedAudioForArticle(articleId: string): Promise<{
  record: OfflineAudioRecord;
  response: Response;
} | null> {
  const db = await getOfflineDb();
  const record = await db.getFromIndex("offline_audio", "by-article", articleId);
  if (!record) return null;
  const response = await getCachedAudio(record.narration_id, record.sha256);
  return response ? { record, response } : null;
}

export async function cacheNarrationAudio(
  client: UrlKeepClient,
  bookmarkId: string,
  narration: ReadyNarrationSummary,
): Promise<boolean> {
  const settings = await getAudioSettings();
  if (!settings.enabled) return false;

  const existing = await getCachedAudio(narration.id, narration.sha256);
  if (existing) return true;
  if (!(await enforceAudioLimit(settings.byte_limit, narration.byte_size))) return false;

  const response = await client.getNarrationAudio(bookmarkId);
  const declaredSize = Number(response.headers.get("content-length"));
  if (
    response.status !== 200
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "audio/mpeg"
    || declaredSize !== narration.byte_size
    || response.headers.get("x-content-sha256") !== narration.sha256
  ) {
    return false;
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== narration.byte_size || await sha256Hex(bytes) !== narration.sha256) {
    return false;
  }

  const key = cacheKey(narration.id, narration.sha256);
  const cache = await caches.open(AUDIO_CACHE);
  await cache.put(key, new Response(bytes, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(bytes.byteLength),
      "X-Content-SHA256": narration.sha256,
    },
  }));
  await (await getOfflineDb()).put("offline_audio", {
    narration_id: narration.id,
    article_id: narration.article_id,
    cache_key: key,
    sha256: narration.sha256,
    byte_size: narration.byte_size,
    last_accessed_at: new Date().toISOString(),
  });
  return true;
}

export async function auditOfflineAudio(): Promise<void> {
  const db = await getOfflineDb();
  const rows = await db.getAll("offline_audio");
  const cache = await caches.open(AUDIO_CACHE);
  const retainedKeys = new Set<string>();
  for (const row of rows) {
    if (await cache.match(row.cache_key)) retainedKeys.add(row.cache_key);
    else await db.delete("offline_audio", row.narration_id);
  }
  for (const request of await cache.keys()) {
    if (!retainedKeys.has(request.url)) await cache.delete(request);
  }
}

export async function retainCurrentNarrations(
  narrations: ReadyNarrationSummary[],
): Promise<void> {
  const current = new Set(narrations.map((item) => `${item.id}:${item.sha256}`));
  const rows = await (await getOfflineDb()).getAll("offline_audio");
  for (const row of rows) {
    if (!current.has(`${row.narration_id}:${row.sha256}`)) await deleteRecord(row);
  }
}
