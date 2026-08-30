import { deleteServiceJob } from "./narration-service";
import type { Bindings } from "./types";
import { nowIso } from "./utils";

type CleanupRow = {
  service_job_id: string;
  attempt_count: number;
};

export async function runOneNarrationCleanup(env: Bindings): Promise<boolean> {
  const row = await env.DB.prepare(
    `
      SELECT service_job_id, attempt_count
      FROM narration_cleanup_jobs
      WHERE next_attempt_at <= ?
      ORDER BY next_attempt_at, service_job_id
      LIMIT 1
    `,
  ).bind(nowIso()).first<CleanupRow>();
  if (!row) return false;

  try {
    await deleteServiceJob(env, row.service_job_id);
    await env.DB.prepare(
      "DELETE FROM narration_cleanup_jobs WHERE service_job_id = ?",
    ).bind(row.service_job_id).run();
  } catch {
    const delaySeconds = Math.min(60 * 60, 30 * 2 ** Math.min(row.attempt_count, 7));
    await env.DB.prepare(
      `
        UPDATE narration_cleanup_jobs
        SET attempt_count = attempt_count + 1, next_attempt_at = ?
        WHERE service_job_id = ?
      `,
    ).bind(
      new Date(Date.now() + delaySeconds * 1000).toISOString(),
      row.service_job_id,
    ).run();
  }
  return true;
}
