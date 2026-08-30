import { deriveNarrationText, NarrationTextError } from "./narration-text";
import {
  deleteServiceJob,
  getServiceAudio,
  NarrationServiceError,
  putServiceJob,
  type ServiceJob,
} from "./narration-service";
import type { Bindings, NarrationRecord } from "./types";
import { makeId, nowIso } from "./utils";

const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const PUBLISH_CLAIM_MAX_AGE_MS = 5 * 60 * 1000;
const SERVICE_FAILURES = new Set([
  "input_mismatch",
  "encoder_failed",
  "storage_full",
  "file_too_large",
  "generation_failed",
  "storage_io",
  "worker_interrupted",
]);
const RETRYABLE_FAILURES = new Set([
  "encoder_failed",
  "storage_full",
  "generation_failed",
  "storage_io",
  "worker_interrupted",
  "audio_missing",
]);

type NarrationRow = {
  id: string;
  article_id: string;
  service_job_id: string;
  text_sha256: string;
  status: NarrationRecord["status"];
  retry_count: 0 | 1;
  publish_started_at: string | null;
  engine_fingerprint: string | null;
  error_code: string | null;
  audio_key: string;
  audio_sha256: string | null;
  byte_size: number | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type NarratableSource = {
  bookmarkId: string;
  articleId: string;
  title: string;
  contentHtml: string;
};

export class NarrationDomainError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "NarrationDomainError";
  }
}

function mapNarration(row: NarrationRow): NarrationRecord {
  return {
    id: row.id,
    articleId: row.article_id,
    serviceJobId: row.service_job_id,
    textSha256: row.text_sha256,
    status: row.status,
    retryCount: row.retry_count,
    publishStartedAt: row.publish_started_at,
    engineFingerprint: row.engine_fingerprint,
    errorCode: row.error_code,
    audioKey: row.audio_key,
    audioSha256: row.audio_sha256,
    byteSize: row.byte_size,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

async function narrationById(db: D1Database, id: string): Promise<NarrationRecord | null> {
  const row = await db.prepare("SELECT * FROM narrations WHERE id = ? LIMIT 1")
    .bind(id)
    .first<NarrationRow>();
  return row ? mapNarration(row) : null;
}

async function narrationByArticle(
  db: D1Database,
  articleId: string,
): Promise<NarrationRecord | null> {
  const row = await db.prepare("SELECT * FROM narrations WHERE article_id = ? LIMIT 1")
    .bind(articleId)
    .first<NarrationRow>();
  return row ? mapNarration(row) : null;
}

async function narratableSource(
  db: D1Database,
  userId: string,
  bookmarkId: string,
): Promise<NarratableSource> {
  const row = await db.prepare(
    `
      SELECT
        b.id AS bookmark_id,
        b.bucket,
        ac.id AS article_id,
        ac.title,
        ac.content_html,
        ac.extraction_status
      FROM bookmarks b
      LEFT JOIN article_content ac ON ac.bookmark_id = b.id AND ac.user_id = b.user_id
      WHERE b.id = ? AND b.user_id = ?
      LIMIT 1
    `,
  ).bind(bookmarkId, userId).first<{
    bookmark_id: string;
    bucket: string;
    article_id: string | null;
    title: string | null;
    content_html: string | null;
    extraction_status: string | null;
  }>();

  if (!row) {
    throw new NarrationDomainError("not_found", 404, "Bookmark not found");
  }
  if (
    row.bucket !== "reading"
    || !row.article_id
    || row.extraction_status !== "complete"
    || !row.title
    || !row.content_html
  ) {
    throw new NarrationDomainError(
      "narration_unavailable",
      409,
      "Complete article content is required for narration",
    );
  }
  return {
    bookmarkId: row.bookmark_id,
    articleId: row.article_id,
    title: row.title,
    contentHtml: row.content_html,
  };
}

function deriveSourceText(source: NarratableSource) {
  try {
    return deriveNarrationText({ title: source.title, contentHtml: source.contentHtml });
  } catch (caught) {
    if (caught instanceof NarrationTextError) {
      throw new NarrationDomainError(caught.code, 422, caught.message);
    }
    throw caught;
  }
}

async function attachNotification(
  db: D1Database,
  narrationId: string,
  accessTokenId: string,
  now: string,
): Promise<void> {
  await db.prepare(
    `
      INSERT INTO narration_notifications(
        narration_id, subscription_id, attempt_count, next_attempt_at, created_at
      )
      SELECT ?, ps.id, 0, ?, ?
      FROM push_subscriptions ps
      JOIN narrations n ON n.id = ? AND n.status IN ('pending', 'publishing')
      WHERE ps.access_token_id = ?
      ON CONFLICT(narration_id, subscription_id) DO NOTHING
    `,
  ).bind(narrationId, now, now, narrationId, accessTokenId).run();
}

export async function requestNarration(
  env: Bindings,
  userId: string,
  accessTokenId: string,
  bookmarkId: string,
): Promise<{ narration: NarrationRecord; created: boolean }> {
  const source = await narratableSource(env.DB, userId, bookmarkId);
  const derived = deriveSourceText(source);
  const existing = await narrationByArticle(env.DB, source.articleId);
  if (existing) {
    if (existing.status === "pending" || existing.status === "publishing") {
      await attachNotification(env.DB, existing.id, accessTokenId, nowIso());
    }
    return { narration: existing, created: false };
  }

  const now = nowIso();
  const id = makeId();
  const serviceJobId = makeId();
  const audioKey = `narrations/${id}/${serviceJobId}.mp3`;
  await env.DB.batch([
    env.DB.prepare(
      `
        INSERT INTO narrations(
          id, article_id, service_job_id, text_sha256, status, retry_count,
          audio_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(article_id) DO NOTHING
      `,
    ).bind(id, source.articleId, serviceJobId, derived.sha256, audioKey, now, now),
    env.DB.prepare(
      `
        INSERT INTO narration_notifications(
          narration_id, subscription_id, attempt_count, next_attempt_at, created_at
        )
        SELECT n.id, ps.id, 0, ?, ?
        FROM narrations n
        JOIN push_subscriptions ps ON ps.access_token_id = ?
        WHERE n.article_id = ? AND n.status IN ('pending', 'publishing')
        ON CONFLICT(narration_id, subscription_id) DO NOTHING
      `,
    ).bind(now, now, accessTokenId, source.articleId),
  ]);

  const narration = await narrationByArticle(env.DB, source.articleId);
  if (!narration) throw new Error("narration insert did not produce a row");
  return { narration, created: narration.serviceJobId === serviceJobId };
}

export async function getBookmarkNarration(
  env: Bindings,
  userId: string,
  bookmarkId: string,
): Promise<NarrationRecord | null> {
  const source = await narratableSource(env.DB, userId, bookmarkId);
  return narrationByArticle(env.DB, source.articleId);
}

export async function retryNarration(
  env: Bindings,
  userId: string,
  accessTokenId: string,
  bookmarkId: string,
): Promise<NarrationRecord> {
  const source = await narratableSource(env.DB, userId, bookmarkId);
  const existing = await narrationByArticle(env.DB, source.articleId);
  if (!existing) {
    throw new NarrationDomainError("not_found", 404, "Narration not found");
  }
  if (
    existing.status !== "failed"
    || existing.retryCount !== 0
    || !existing.errorCode
    || !RETRYABLE_FAILURES.has(existing.errorCode)
  ) {
    throw new NarrationDomainError("retry_unavailable", 409, "Narration cannot be retried");
  }

  const derived = deriveSourceText(source);
  const now = nowIso();
  const serviceJobId = makeId();
  const audioKey = `narrations/${existing.id}/${serviceJobId}.mp3`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `
        INSERT INTO narration_cleanup_jobs(
          service_job_id, audio_key, attempt_count, next_attempt_at, created_at
        )
        SELECT service_job_id, audio_key, 0, ?, ?
        FROM narrations
        WHERE id = ? AND article_id = ? AND status = 'failed' AND retry_count = 0
        ON CONFLICT(service_job_id) DO NOTHING
      `,
    ).bind(now, now, existing.id, source.articleId),
    env.DB.prepare("DELETE FROM narration_notifications WHERE narration_id = ?")
      .bind(existing.id),
    env.DB.prepare(
      `
        UPDATE narrations
        SET service_job_id = ?, text_sha256 = ?, status = 'pending', retry_count = 1,
            publish_started_at = NULL, engine_fingerprint = NULL, error_code = NULL,
            audio_key = ?, audio_sha256 = NULL, byte_size = NULL, duration_ms = NULL,
            updated_at = ?, finished_at = NULL
        WHERE id = ? AND article_id = ? AND status = 'failed' AND retry_count = 0
      `,
    ).bind(serviceJobId, derived.sha256, audioKey, now, existing.id, source.articleId),
    env.DB.prepare(
      `
        INSERT INTO narration_notifications(
          narration_id, subscription_id, attempt_count, next_attempt_at, created_at
        )
        SELECT n.id, ps.id, 0, ?, ?
        FROM narrations n
        JOIN push_subscriptions ps ON ps.access_token_id = ?
        WHERE n.id = ? AND n.service_job_id = ? AND n.status = 'pending'
        ON CONFLICT(narration_id, subscription_id) DO NOTHING
      `,
    ).bind(now, now, accessTokenId, existing.id, serviceJobId),
  ]);
  if ((results[2]?.meta.changes ?? 0) !== 1) {
    throw new NarrationDomainError("retry_unavailable", 409, "Narration cannot be retried");
  }
  return (await narrationById(env.DB, existing.id))!;
}

export function narrationToApi(narration: NarrationRecord) {
  const status = narration.status === "publishing" ? "pending" : narration.status;
  return {
    id: narration.id,
    status,
    retryable: status === "failed"
      && narration.retryCount === 0
      && Boolean(narration.errorCode && RETRYABLE_FAILURES.has(narration.errorCode)),
    error_code: status === "failed" ? narration.errorCode : null,
    audio: status === "ready"
      && narration.audioSha256
      && narration.byteSize
      && narration.durationMs
        ? {
            sha256: narration.audioSha256,
            byte_size: narration.byteSize,
            duration_ms: narration.durationMs,
          }
        : null,
  };
}

async function markFailed(env: Bindings, narration: NarrationRecord, errorCode: string) {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `
        UPDATE narrations
        SET status = 'failed', publish_started_at = NULL, engine_fingerprint = NULL,
            error_code = ?, audio_sha256 = NULL, byte_size = NULL, duration_ms = NULL,
            updated_at = ?, finished_at = ?
        WHERE id = ? AND article_id = ? AND service_job_id = ?
          AND status IN ('pending', 'publishing')
      `,
    ).bind(errorCode, now, now, narration.id, narration.articleId, narration.serviceJobId),
    env.DB.prepare(
      `
        DELETE FROM narration_notifications
        WHERE narration_id = ?
          AND EXISTS (SELECT 1 FROM narrations WHERE id = ? AND status = 'failed')
      `,
    ).bind(narration.id, narration.id),
  ]);
}

function serviceFailureCode(job: Extract<ServiceJob, { status: "failed" }>): string {
  return SERVICE_FAILURES.has(job.errorCode) ? job.errorCode : "invalid_service_output";
}

function bytesFromHex(value: string): ArrayBuffer {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes.buffer as ArrayBuffer;
}

function hexFromBytes(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function resetPublishingClaim(env: Bindings, narration: NarrationRecord): Promise<void> {
  await env.DB.prepare(
    `
      UPDATE narrations
      SET status = 'pending', publish_started_at = NULL, updated_at = ?
      WHERE id = ? AND service_job_id = ? AND status = 'publishing'
    `,
  ).bind(nowIso(), narration.id, narration.serviceJobId).run();
}

async function publishReadyAudio(
  env: Bindings,
  narration: NarrationRecord,
  job: Extract<ServiceJob, { status: "ready" }>,
): Promise<void> {
  if (!env.NARRATIONS || job.audio.byteSize > MAX_AUDIO_BYTES) {
    await markFailed(env, narration, "invalid_service_output");
    return;
  }

  const claimed = await env.DB.prepare(
    `
      UPDATE narrations
      SET status = 'publishing', publish_started_at = ?, updated_at = ?
      WHERE id = ? AND article_id = ? AND service_job_id = ? AND status = 'pending'
    `,
  ).bind(nowIso(), nowIso(), narration.id, narration.articleId, narration.serviceJobId).run();
  if ((claimed.meta.changes ?? 0) !== 1) return;

  try {
    const response = await getServiceAudio(env, narration.serviceJobId);
    const contentLength = Number(response.headers.get("content-length"));
    const durationMs = Number(response.headers.get("x-audio-duration-ms"));
    const sha256 = response.headers.get("x-content-sha256");
    const fingerprint = response.headers.get("x-engine-fingerprint");
    if (
      response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "audio/mpeg"
      || !response.body
      || contentLength !== job.audio.byteSize
      || durationMs !== job.audio.durationMs
      || sha256 !== job.audio.sha256
      || fingerprint !== job.engineFingerprint
    ) {
      throw new NarrationServiceError(502, "invalid_service_output", false);
    }

    const fixedLength = new FixedLengthStream(contentLength);
    const put = env.NARRATIONS.put(narration.audioKey, fixedLength.readable, {
      sha256: bytesFromHex(job.audio.sha256),
      httpMetadata: { contentType: "audio/mpeg" },
    });
    const [object] = await Promise.all([
      put,
      response.body.pipeTo(fixedLength.writable),
    ]);
    if (
      object.size !== job.audio.byteSize
      || !object.checksums.sha256
      || hexFromBytes(object.checksums.sha256) !== job.audio.sha256
    ) {
      await env.NARRATIONS.delete(narration.audioKey);
      throw new NarrationServiceError(502, "invalid_service_output", false);
    }

    const now = nowIso();
    await env.DB.prepare(
      `
        UPDATE narrations
        SET status = 'ready', publish_started_at = NULL, engine_fingerprint = ?,
            audio_sha256 = ?, byte_size = ?, duration_ms = ?, error_code = NULL,
            updated_at = ?, finished_at = ?
        WHERE id = ? AND article_id = ? AND service_job_id = ? AND status = 'publishing'
      `,
    ).bind(
      job.engineFingerprint,
      job.audio.sha256,
      job.audio.byteSize,
      job.audio.durationMs,
      now,
      now,
      narration.id,
      narration.articleId,
      narration.serviceJobId,
    ).run();
    const committed = await narrationById(env.DB, narration.id);
    if (
      !committed
      || committed.status !== "ready"
      || committed.articleId !== narration.articleId
      || committed.serviceJobId !== narration.serviceJobId
    ) {
      await env.NARRATIONS.delete(narration.audioKey);
      return;
    }
    try {
      await deleteServiceJob(env, narration.serviceJobId);
    } catch {
      // Service expiry is the acknowledgement fallback.
    }
  } catch (caught) {
    if (caught instanceof NarrationServiceError && !caught.transient) {
      await env.NARRATIONS.delete(narration.audioKey);
      await markFailed(env, narration, "invalid_service_output");
      return;
    }
    await resetPublishingClaim(env, narration);
  }
}

export async function reconcileNarration(env: Bindings, narrationId: string): Promise<void> {
  let narration = await narrationById(env.DB, narrationId);
  if (!narration || narration.status === "ready" || narration.status === "failed") return;

  if (narration.status === "publishing") {
    const claimAge = narration.publishStartedAt
      ? Date.now() - Date.parse(narration.publishStartedAt)
      : Number.POSITIVE_INFINITY;
    if (claimAge < PUBLISH_CLAIM_MAX_AGE_MS) return;
    await resetPublishingClaim(env, narration);
    narration = await narrationById(env.DB, narrationId);
    if (!narration || narration.status !== "pending") return;
  }

  const sourceRow = await env.DB.prepare(
    `
      SELECT ac.id, ac.title, ac.content_html
      FROM article_content ac
      WHERE ac.id = ? AND ac.extraction_status = 'complete' AND ac.content_html IS NOT NULL
      LIMIT 1
    `,
  ).bind(narration.articleId).first<{
    id: string;
    title: string;
    content_html: string;
  }>();
  if (!sourceRow) return;

  let derived: { text: string; sha256: string };
  try {
    derived = deriveNarrationText({ title: sourceRow.title, contentHtml: sourceRow.content_html });
  } catch {
    await markFailed(env, narration, "source_mismatch");
    return;
  }
  if (derived.sha256 !== narration.textSha256) {
    await markFailed(env, narration, "source_mismatch");
    return;
  }

  let job: ServiceJob;
  try {
    job = await putServiceJob(
      env,
      narration.serviceJobId,
      derived.text,
      narration.textSha256,
    );
  } catch (caught) {
    if (caught instanceof NarrationServiceError && !caught.transient) {
      await markFailed(env, narration, "invalid_service_output");
    }
    return;
  }

  if (job.status === "queued" || job.status === "running") return;
  if (job.status === "failed") {
    await markFailed(env, narration, serviceFailureCode(job));
    return;
  }
  await publishReadyAudio(env, narration, job);
}

export async function authorizedNarrationAudio(
  env: Bindings,
  userId: string,
  bookmarkId: string,
): Promise<{ narration: NarrationRecord; object: R2ObjectBody }> {
  const narration = await getBookmarkNarration(env, userId, bookmarkId);
  if (!narration || narration.status !== "ready" || !narration.audioSha256 || !env.NARRATIONS) {
    throw new NarrationDomainError("not_found", 404, "Narration audio not found");
  }
  const object = await env.NARRATIONS.get(narration.audioKey);
  if (!object || object.size !== narration.byteSize) {
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare(
        `
          INSERT INTO narration_cleanup_jobs(
            service_job_id, audio_key, attempt_count, next_attempt_at, created_at
          ) VALUES (?, ?, 0, ?, ?)
          ON CONFLICT(service_job_id) DO NOTHING
        `,
      ).bind(narration.serviceJobId, narration.audioKey, now, now),
      env.DB.prepare(
        `
          UPDATE narrations
          SET status = 'failed', engine_fingerprint = NULL, error_code = 'audio_missing',
              audio_sha256 = NULL, byte_size = NULL, duration_ms = NULL,
              updated_at = ?, finished_at = ?
          WHERE id = ? AND status = 'ready'
        `,
      ).bind(now, now, narration.id),
      env.DB.prepare("DELETE FROM narration_notifications WHERE narration_id = ?")
        .bind(narration.id),
    ]);
    throw new NarrationDomainError("not_found", 404, "Narration audio not found");
  }
  return { narration, object };
}
