import { deriveNarrationText, NarrationTextError } from "./narration-text";
import {
  getServiceAudio,
  getServiceJob,
  NarrationServiceError,
  putServiceJob,
  type ServiceJob,
} from "./narration-service";
import type { Bindings, NarrationRecord } from "./types";
import { makeId, nowIso } from "./utils";

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
  engine_fingerprint: string | null;
  error_code: string | null;
  audio_sha256: string | null;
  byte_size: number | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type NarrationContextRow = Partial<NarrationRow> & {
  bookmark_id: string;
  bucket: string;
  article_id: string | null;
  article_title: string | null;
  extraction_status: string | null;
};

type NarratableSource = {
  bookmarkId: string;
  articleId: string;
  title: string;
  contentHtml: string;
};

export class NarrationDomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryable = false,
  ) {
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
    engineFingerprint: row.engine_fingerprint,
    errorCode: row.error_code,
    audioSha256: row.audio_sha256,
    byteSize: row.byte_size,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function contextNarration(row: NarrationContextRow): NarrationRecord | null {
  if (!row.id || !row.service_job_id || !row.text_sha256 || !row.status) return null;
  return mapNarration(row as NarrationRow);
}

async function narrationContext(
  db: D1Database,
  userId: string,
  bookmarkId: string,
): Promise<NarrationContextRow> {
  const row = await db.prepare(
    `
      SELECT
        b.id AS bookmark_id,
        b.bucket,
        ac.id AS article_id,
        ac.title AS article_title,
        ac.extraction_status,
        n.id,
        n.service_job_id,
        n.text_sha256,
        n.status,
        n.retry_count,
        n.engine_fingerprint,
        n.error_code,
        n.audio_sha256,
        n.byte_size,
        n.duration_ms,
        n.created_at,
        n.updated_at,
        n.finished_at
      FROM bookmarks b
      LEFT JOIN article_content ac
        ON ac.bookmark_id = b.id AND ac.user_id = b.user_id
      LEFT JOIN narrations n ON n.article_id = ac.id
      WHERE b.id = ? AND b.user_id = ?
      LIMIT 1
    `,
  ).bind(bookmarkId, userId).first<NarrationContextRow>();
  if (!row) throw new NarrationDomainError("not_found", 404, "Bookmark not found");
  return row;
}

function requireNarratableContext(row: NarrationContextRow): { articleId: string } {
  if (
    row.bucket !== "reading"
    || !row.article_id
    || row.extraction_status !== "complete"
    || !row.article_title
  ) {
    throw new NarrationDomainError(
      "narration_unavailable",
      409,
      "Complete article content is required for narration",
    );
  }
  return { articleId: row.article_id };
}

async function narratableSource(
  db: D1Database,
  userId: string,
  bookmarkId: string,
  articleId: string,
): Promise<NarratableSource> {
  const row = await db.prepare(
    `
      SELECT b.id AS bookmark_id, ac.id AS article_id, ac.title, ac.content_html
      FROM bookmarks b
      JOIN article_content ac ON ac.bookmark_id = b.id AND ac.user_id = b.user_id
      WHERE b.id = ? AND b.user_id = ? AND ac.id = ?
        AND b.bucket = 'reading'
        AND ac.extraction_status = 'complete'
        AND ac.content_html IS NOT NULL
      LIMIT 1
    `,
  ).bind(bookmarkId, userId, articleId).first<{
    bookmark_id: string;
    article_id: string;
    title: string;
    content_html: string;
  }>();
  if (!row) {
    throw new NarrationDomainError(
      "article_changed",
      409,
      "Article content changed during narration submission.",
      true,
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

async function narrationById(db: D1Database, id: string): Promise<NarrationRecord | null> {
  const row = await db.prepare("SELECT * FROM narrations WHERE id = ? LIMIT 1")
    .bind(id)
    .first<NarrationRow>();
  return row ? mapNarration(row) : null;
}

async function upsertCleanupJob(db: D1Database, serviceJobId: string): Promise<void> {
  const now = nowIso();
  await db.prepare(
    `
      INSERT INTO narration_cleanup_jobs(
        service_job_id, attempt_count, next_attempt_at, created_at
      ) VALUES (?, 0, ?, ?)
      ON CONFLICT(service_job_id) DO UPDATE SET
        attempt_count = 0,
        next_attempt_at = excluded.next_attempt_at
    `,
  ).bind(serviceJobId, now, now).run();
}

async function submissionIsCurrent(
  db: D1Database,
  userId: string,
  bookmarkId: string,
  narration: NarrationRecord,
): Promise<boolean> {
  const row = await db.prepare(
    `
      SELECT 1 AS present
      FROM bookmarks b
      JOIN article_content ac
        ON ac.bookmark_id = b.id AND ac.user_id = b.user_id
      JOIN narrations n ON n.article_id = ac.id
      WHERE b.id = ? AND b.user_id = ? AND ac.id = ?
        AND n.id = ? AND n.service_job_id = ?
      LIMIT 1
    `,
  ).bind(
    bookmarkId,
    userId,
    narration.articleId,
    narration.id,
    narration.serviceJobId,
  ).first<{ present: number }>();
  return Boolean(row?.present);
}

function serviceFailureCode(job: Extract<ServiceJob, { status: "failed" }>): string {
  return SERVICE_FAILURES.has(job.errorCode) ? job.errorCode : "invalid_service_output";
}

async function markFailed(
  env: Bindings,
  narration: NarrationRecord,
  errorCode: string,
): Promise<NarrationRecord | null> {
  const now = nowIso();
  await env.DB.prepare(
    `
      UPDATE narrations
      SET status = 'failed', engine_fingerprint = NULL,
          error_code = ?, audio_sha256 = NULL, byte_size = NULL, duration_ms = NULL,
          updated_at = ?, finished_at = ?
      WHERE id = ? AND article_id = ? AND service_job_id = ? AND status = 'pending'
    `,
  ).bind(
    errorCode,
    now,
    now,
    narration.id,
    narration.articleId,
    narration.serviceJobId,
  ).run();
  return narrationById(env.DB, narration.id);
}

async function applyServiceJob(
  env: Bindings,
  narration: NarrationRecord,
  job: ServiceJob,
): Promise<NarrationRecord | null> {
  if (job.status === "queued" || job.status === "running") {
    return narrationById(env.DB, narration.id);
  }
  if (job.status === "failed") {
    return markFailed(env, narration, serviceFailureCode(job));
  }

  const now = nowIso();
  await env.DB.prepare(
    `
      UPDATE narrations
      SET status = 'ready', engine_fingerprint = ?,
          audio_sha256 = ?, byte_size = ?, duration_ms = ?, error_code = NULL,
          updated_at = ?, finished_at = ?
      WHERE id = ? AND article_id = ? AND service_job_id = ? AND status = 'pending'
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
  return narrationById(env.DB, narration.id);
}

async function articleChangedAfterSubmission(
  env: Bindings,
  narration: NarrationRecord,
): Promise<never> {
  await upsertCleanupJob(env.DB, narration.serviceJobId);
  throw new NarrationDomainError(
    "article_changed",
    409,
    "Article content changed during narration submission.",
    true,
  );
}

async function submitNarration(
  env: Bindings,
  userId: string,
  bookmarkId: string,
  narration: NarrationRecord,
  text: string,
): Promise<NarrationRecord> {
  let job: ServiceJob | null = null;
  let submissionError: unknown = null;
  try {
    job = await putServiceJob(env, narration.serviceJobId, text, narration.textSha256);
  } catch (caught) {
    submissionError = caught;
  }

  if (!await submissionIsCurrent(env.DB, userId, bookmarkId, narration)) {
    return articleChangedAfterSubmission(env, narration);
  }

  if (submissionError) {
    if (submissionError instanceof NarrationServiceError && !submissionError.transient) {
      const failed = await markFailed(env, narration, "invalid_service_output");
      if (!failed) return articleChangedAfterSubmission(env, narration);
      return failed;
    }
    throw new NarrationDomainError(
      "narration_service_unavailable",
      503,
      "Narration service is temporarily unavailable.",
      true,
    );
  }

  const result = await applyServiceJob(env, narration, job!);
  if (!result) return articleChangedAfterSubmission(env, narration);
  return result;
}

export async function requestNarration(
  env: Bindings,
  userId: string,
  bookmarkId: string,
): Promise<{ narration: NarrationRecord; created: boolean }> {
  const initial = await narrationContext(env.DB, userId, bookmarkId);
  const { articleId } = requireNarratableContext(initial);
  const existing = contextNarration(initial);
  if (existing && existing.status !== "pending") {
    return { narration: existing, created: false };
  }

  const source = await narratableSource(env.DB, userId, bookmarkId, articleId);
  const derived = deriveSourceText(source);
  let created = false;
  let narration = existing;
  if (!narration) {
    const now = nowIso();
    const id = makeId();
    const serviceJobId = makeId();
    const result = await env.DB.prepare(
      `
        INSERT INTO narrations(
          id, article_id, service_job_id, text_sha256, status, retry_count,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(article_id) DO NOTHING
      `,
    ).bind(id, articleId, serviceJobId, derived.sha256, now, now).run();
    created = (result.meta.changes ?? 0) === 1;
    const current = await narrationContext(env.DB, userId, bookmarkId);
    if (current.article_id !== articleId) {
      const inserted = await narrationById(env.DB, id);
      if (inserted) await upsertCleanupJob(env.DB, inserted.serviceJobId);
      throw new NarrationDomainError(
        "article_changed",
        409,
        "Article content changed during narration submission.",
        true,
      );
    }
    narration = contextNarration(current);
  }
  if (!narration) throw new Error("narration insert did not produce a row");
  if (narration.status !== "pending") return { narration, created: false };
  if (narration.textSha256 !== derived.sha256) {
    const failed = await markFailed(env, narration, "source_mismatch");
    if (!failed) return articleChangedAfterSubmission(env, narration);
    return { narration: failed, created };
  }
  return {
    narration: await submitNarration(env, userId, bookmarkId, narration, derived.text),
    created,
  };
}

export async function getBookmarkNarration(
  env: Bindings,
  userId: string,
  bookmarkId: string,
): Promise<NarrationRecord | null> {
  return contextNarration(await narrationContext(env.DB, userId, bookmarkId));
}

export async function pollBookmarkNarration(
  env: Bindings,
  userId: string,
  bookmarkId: string,
): Promise<NarrationRecord> {
  const narration = await getBookmarkNarration(env, userId, bookmarkId);
  if (!narration) throw new NarrationDomainError("not_found", 404, "Narration not found");
  if (narration.status !== "pending") return narration;

  let job: ServiceJob;
  try {
    job = await getServiceJob(env, narration.serviceJobId);
  } catch (caught) {
    if (caught instanceof NarrationServiceError && caught.status === 404) {
      throw new NarrationDomainError(
        "submission_required",
        409,
        "Narration must be submitted again.",
        true,
      );
    }
    if (caught instanceof NarrationServiceError && !caught.transient) {
      const failed = await markFailed(env, narration, "invalid_service_output");
      if (failed) return failed;
    }
    throw new NarrationDomainError(
      "narration_service_unavailable",
      503,
      "Narration service is temporarily unavailable.",
      true,
    );
  }

  const result = await applyServiceJob(env, narration, job);
  if (!result) {
    throw new NarrationDomainError(
      "article_changed",
      409,
      "Article content changed during narration submission.",
      true,
    );
  }
  return result;
}

export async function retryNarration(
  env: Bindings,
  userId: string,
  bookmarkId: string,
): Promise<NarrationRecord> {
  const initial = await narrationContext(env.DB, userId, bookmarkId);
  const { articleId } = requireNarratableContext(initial);
  const existing = contextNarration(initial);
  if (
    !existing
    || existing.status !== "failed"
    || existing.retryCount !== 0
    || !existing.errorCode
    || !RETRYABLE_FAILURES.has(existing.errorCode)
  ) {
    throw new NarrationDomainError(
      "retry_unavailable",
      409,
      "Narration cannot be retried.",
    );
  }

  const source = await narratableSource(env.DB, userId, bookmarkId, articleId);
  const derived = deriveSourceText(source);
  const now = nowIso();
  const serviceJobId = makeId();
  const results = await env.DB.batch([
    env.DB.prepare(
      `
        INSERT INTO narration_cleanup_jobs(
          service_job_id, attempt_count, next_attempt_at, created_at
        ) VALUES (?, 0, ?, ?)
        ON CONFLICT(service_job_id) DO NOTHING
      `,
    ).bind(existing.serviceJobId, now, now),
    env.DB.prepare(
      `
        UPDATE narrations
        SET service_job_id = ?, text_sha256 = ?, status = 'pending', retry_count = 1,
            engine_fingerprint = NULL, error_code = NULL,
            audio_sha256 = NULL, byte_size = NULL, duration_ms = NULL,
            updated_at = ?, finished_at = NULL
        WHERE id = ? AND article_id = ? AND status = 'failed' AND retry_count = 0
      `,
    ).bind(serviceJobId, derived.sha256, now, existing.id, articleId),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1) {
    throw new NarrationDomainError(
      "retry_unavailable",
      409,
      "Narration cannot be retried.",
    );
  }
  const narration = await narrationById(env.DB, existing.id);
  if (!narration) {
    await upsertCleanupJob(env.DB, serviceJobId);
    throw new NarrationDomainError(
      "article_changed",
      409,
      "Article content changed during narration submission.",
      true,
    );
  }
  return submitNarration(env, userId, bookmarkId, narration, derived.text);
}

export function narrationToApi(narration: NarrationRecord) {
  const status = narration.status;
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

function forwardedAudioRequestHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of ["range", "if-range", "if-none-match"] as const) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function verifiedAudioResponse(
  narration: NarrationRecord,
  upstream: Response,
  method: "GET" | "HEAD",
): Response {
  const passthrough = new Headers();
  for (const name of ["accept-ranges", "content-length", "content-range", "etag"]) {
    const value = upstream.headers.get(name);
    if (value) passthrough.set(name, value);
  }
  passthrough.set("Content-Type", "audio/mpeg");
  passthrough.set("X-Content-SHA256", narration.audioSha256!);
  passthrough.set("X-Audio-Duration-Ms", String(narration.durationMs));
  passthrough.set("X-Engine-Fingerprint", narration.engineFingerprint!);
  if (!passthrough.has("ETag")) passthrough.set("ETag", `"${narration.audioSha256}"`);
  passthrough.set("Cache-Control", "private, no-store, no-transform");
  passthrough.set("X-Content-Type-Options", "nosniff");
  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: passthrough,
  });
}

async function failReadyAudio(env: Bindings, narration: NarrationRecord): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `
      UPDATE narrations
      SET status = 'failed', engine_fingerprint = NULL, error_code = 'audio_missing',
          audio_sha256 = NULL, byte_size = NULL, duration_ms = NULL,
          updated_at = ?, finished_at = ?
      WHERE id = ? AND article_id = ? AND service_job_id = ? AND status = 'ready'
    `,
  ).bind(
    now,
    now,
    narration.id,
    narration.articleId,
    narration.serviceJobId,
  ).run();
}

function audioMissingError(): NarrationDomainError {
  return new NarrationDomainError(
    "audio_missing",
    409,
    "Narration audio is missing and can be retried.",
    true,
  );
}

export async function authorizedNarrationAudio(
  env: Bindings,
  userId: string,
  bookmarkId: string,
  requestHeaders: Headers,
  method: "GET" | "HEAD",
): Promise<Response> {
  const narration = await getBookmarkNarration(env, userId, bookmarkId);
  if (
    !narration
    || narration.status !== "ready"
    || !narration.audioSha256
    || !narration.byteSize
  ) {
    throw new NarrationDomainError("not_found", 404, "Narration audio not found");
  }

  let upstream: Response;
  try {
    upstream = await getServiceAudio(env, narration.serviceJobId, {
      method,
      headers: forwardedAudioRequestHeaders(requestHeaders),
    });
  } catch (caught) {
    if (caught instanceof NarrationServiceError && caught.status === 404) {
      await failReadyAudio(env, narration);
      throw audioMissingError();
    }
    throw new NarrationDomainError(
      "narration_service_unavailable",
      503,
      "Narration service is temporarily unavailable.",
      true,
    );
  }
  if (upstream.status === 304 || upstream.status === 416) {
    return verifiedAudioResponse(narration, upstream, method);
  }

  const contentType = upstream.headers.get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  const checksum = upstream.headers.get("x-content-sha256");
  const fingerprint = upstream.headers.get("x-engine-fingerprint");
  const durationMs = Number(upstream.headers.get("x-audio-duration-ms"));
  const valid = (upstream.status === 200 || upstream.status === 206)
    && contentType === "audio/mpeg"
    && checksum === narration.audioSha256
    && fingerprint === narration.engineFingerprint
    && durationMs === narration.durationMs
    && (upstream.status !== 200
      || Number(upstream.headers.get("content-length")) === narration.byteSize);
  if (!valid) {
    await upstream.body?.cancel();
    await failReadyAudio(env, narration);
    throw audioMissingError();
  }
  return verifiedAudioResponse(narration, upstream, method);
}
