import type { Bindings } from "./types";

export type ServiceJob =
  | { id: string; status: "queued" }
  | { id: string; status: "running" }
  | {
      id: string;
      status: "ready";
      engineFingerprint: string;
      audio: { sha256: string; byteSize: number; durationMs: number };
    }
  | { id: string; status: "failed"; errorCode: string };

export class NarrationServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly transient: boolean,
  ) {
    super("Narration service request failed");
    this.name = "NarrationServiceError";
  }
}

function requireConfig(env: Bindings): { origin: string; token: string } {
  const rawOrigin = env.NARRATION_SERVICE_ORIGIN?.trim().replace(/\/+$/, "");
  const token = env.NARRATION_SERVICE_TOKEN?.trim();
  if (!rawOrigin || !token) {
    throw new NarrationServiceError(0, "service_unavailable", true);
  }

  let origin: string;
  try {
    const url = new URL(rawOrigin);
    const localHttp = url.protocol === "http:"
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (
      (url.protocol !== "https:" && !localHttp)
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      throw new Error();
    }
    origin = url.toString().replace(/\/+$/, "");
  } catch {
    throw new NarrationServiceError(0, "service_unavailable", true);
  }
  return { origin, token };
}

function isHexSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function parseJob(value: unknown, expectedId: string): ServiceJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NarrationServiceError(502, "invalid_service_output", false);
  }
  const row = value as Record<string, unknown>;
  if (row.id !== expectedId) {
    throw new NarrationServiceError(502, "invalid_service_output", false);
  }
  if (row.status === "queued" || row.status === "running") {
    return { id: expectedId, status: row.status };
  }
  if (row.status === "failed" && typeof row.error_code === "string") {
    return { id: expectedId, status: "failed", errorCode: row.error_code };
  }
  if (
    row.status === "ready"
    && typeof row.engine_fingerprint === "string"
    && row.engine_fingerprint.length > 0
    && row.engine_fingerprint.length <= 200
    && row.audio
    && typeof row.audio === "object"
    && !Array.isArray(row.audio)
  ) {
    const audio = row.audio as Record<string, unknown>;
    if (
      isHexSha256(audio.sha256)
      && Number.isSafeInteger(audio.byte_size)
      && (audio.byte_size as number) > 0
      && Number.isSafeInteger(audio.duration_ms)
      && (audio.duration_ms as number) > 0
    ) {
      return {
        id: expectedId,
        status: "ready",
        engineFingerprint: row.engine_fingerprint,
        audio: {
          sha256: audio.sha256,
          byteSize: audio.byte_size as number,
          durationMs: audio.duration_ms as number,
        },
      };
    }
  }
  throw new NarrationServiceError(502, "invalid_service_output", false);
}

async function serviceRequest(
  env: Bindings,
  path: string,
  init: RequestInit = {},
  acceptedStatuses: ReadonlySet<number> = new Set(),
): Promise<Response> {
  const { origin, token } = requireConfig(env);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
  } catch {
    throw new NarrationServiceError(0, "service_unavailable", true);
  }

  if (!response.ok && !acceptedStatuses.has(response.status)) {
    let code = "service_error";
    try {
      const value = await response.json() as { error?: { code?: unknown } };
      if (typeof value.error?.code === "string") code = value.error.code;
    } catch {
      // The product exposes only its own allowlisted error codes.
    }
    throw new NarrationServiceError(
      response.status,
      code,
      response.status === 429 || response.status >= 500,
    );
  }
  return response;
}

export async function putServiceJob(
  env: Bindings,
  jobId: string,
  text: string,
  textSha256: string,
): Promise<ServiceJob> {
  const response = await serviceRequest(env, `/jobs/${encodeURIComponent(jobId)}`, {
    method: "PUT",
    body: JSON.stringify({ text, text_sha256: textSha256 }),
  });
  try {
    return parseJob(await response.json(), jobId);
  } catch (caught) {
    if (caught instanceof NarrationServiceError) throw caught;
    throw new NarrationServiceError(502, "invalid_service_output", false);
  }
}

export async function getServiceJob(env: Bindings, jobId: string): Promise<ServiceJob> {
  const response = await serviceRequest(env, `/jobs/${encodeURIComponent(jobId)}`);
  try {
    return parseJob(await response.json(), jobId);
  } catch (caught) {
    if (caught instanceof NarrationServiceError) throw caught;
    throw new NarrationServiceError(502, "invalid_service_output", false);
  }
}

export function getServiceAudio(
  env: Bindings,
  jobId: string,
  options: { method?: "GET" | "HEAD"; headers?: HeadersInit } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("Accept-Encoding", "identity");
  return serviceRequest(env, `/jobs/${encodeURIComponent(jobId)}/audio`, {
    method: options.method ?? "GET",
    headers,
    signal: AbortSignal.timeout(60_000),
  }, new Set([304, 416]));
}

export async function deleteServiceJob(env: Bindings, jobId: string): Promise<void> {
  try {
    await serviceRequest(env, `/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
  } catch (caught) {
    if (caught instanceof NarrationServiceError && caught.status === 404) return;
    throw caught;
  }
}
