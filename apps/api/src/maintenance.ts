import { reconcileNarration } from "./narration";
import { deleteServiceJob } from "./narration-service";
import { deliverNotification, dueNotifications } from "./push";
import type { Bindings } from "./types";
import { nowIso } from "./utils";

const RECONCILE_LIMIT = 10;
const NOTIFICATION_LIMIT = 25;
const CLEANUP_LIMIT = 25;

async function inParallel<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index++];
        await work(item);
      }
    }),
  );
}

async function reconcileBatch(env: Bindings): Promise<void> {
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const result = await env.DB.prepare(
    `
      SELECT id
      FROM narrations
      WHERE status = 'pending'
         OR (status = 'publishing' AND publish_started_at <= ?)
      ORDER BY updated_at, id
      LIMIT ?
    `,
  ).bind(staleBefore, RECONCILE_LIMIT).all<{ id: string }>();
  await inParallel(result.results ?? [], 2, async ({ id }) => {
    try {
      await reconcileNarration(env, id);
    } catch {
      // The row remains durable for the next scheduled pass.
    }
  });
}

async function notificationBatch(env: Bindings): Promise<void> {
  const rows = await dueNotifications(env, NOTIFICATION_LIMIT);
  await inParallel(rows, 5, async (row) => {
    try {
      await deliverNotification(env, row);
    } catch {
      // The outbox row remains durable for the next scheduled pass.
    }
  });
}

type CleanupRow = {
  service_job_id: string;
  audio_key: string;
  attempt_count: number;
};

async function cleanupBatch(env: Bindings): Promise<void> {
  const result = await env.DB.prepare(
    `
      SELECT service_job_id, audio_key, attempt_count
      FROM narration_cleanup_jobs
      WHERE next_attempt_at <= ?
      ORDER BY next_attempt_at, service_job_id
      LIMIT ?
    `,
  ).bind(nowIso(), CLEANUP_LIMIT).all<CleanupRow>();

  await inParallel(result.results ?? [], 5, async (row) => {
    try {
      if (!env.NARRATIONS) throw new Error("narration bucket unavailable");
      await env.NARRATIONS.delete(row.audio_key);
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
  });
}

export async function runMaintenance(env: Bindings): Promise<void> {
  await Promise.all([
    reconcileBatch(env),
    notificationBatch(env),
    cleanupBatch(env),
  ]);
}
