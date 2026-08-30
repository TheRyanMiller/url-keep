import {
  buildPushPayload,
  type PushSubscription,
  type VapidKeys,
} from "@block65/webcrypto-web-push";
import type { PushSubscriptionRequest } from "@url-keep/shared";
import type { Bindings } from "./types";
import { makeId, nowIso } from "./utils";

const NOTIFICATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const RETRY_SECONDS = [30, 120, 600, 3600] as const;

function pushAvailable(env: Bindings): boolean {
  return Boolean(
    env.VAPID_PUBLIC_KEY?.trim()
    && env.VAPID_PRIVATE_KEY?.trim()
    && env.VAPID_SUBJECT?.trim(),
  );
}

function allowedProviderHosts(env: Bindings): Set<string> {
  return new Set(
    (env.PUSH_PROVIDER_HOSTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function validatePushSubscription(
  env: Bindings,
  value: PushSubscriptionRequest,
): PushSubscription {
  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    throw new Error("invalid push endpoint");
  }
  if (
    endpoint.protocol !== "https:"
    || endpoint.username
    || endpoint.password
    || endpoint.hash
    || endpoint.port
    || !allowedProviderHosts(env).has(endpoint.hostname.toLowerCase())
  ) {
    throw new Error("invalid push endpoint");
  }

  const p256dh = decodeBase64Url(value.keys.p256dh);
  const auth = decodeBase64Url(value.keys.auth);
  if (p256dh?.length !== 65 || p256dh[0] !== 4 || auth?.length !== 16) {
    throw new Error("invalid push keys");
  }
  return {
    endpoint: endpoint.toString(),
    expirationTime: value.expirationTime ?? null,
    keys: value.keys,
  };
}

export async function getPushConfig(
  env: Bindings,
  accessTokenId: string,
): Promise<{ available: boolean; public_key: string | null; subscribed: boolean }> {
  const available = pushAvailable(env);
  const row = await env.DB.prepare(
    "SELECT 1 AS present FROM push_subscriptions WHERE access_token_id = ? LIMIT 1",
  ).bind(accessTokenId).first<{ present: number }>();
  return {
    available,
    public_key: available ? env.VAPID_PUBLIC_KEY!.trim() : null,
    subscribed: Boolean(row),
  };
}

export async function putPushSubscription(
  env: Bindings,
  userId: string,
  accessTokenId: string,
  subscription: PushSubscription,
): Promise<void> {
  if (!pushAvailable(env)) throw new Error("push unavailable");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM push_subscriptions WHERE access_token_id = ? OR endpoint = ?",
    ).bind(accessTokenId, subscription.endpoint),
    env.DB.prepare(
      `
        INSERT INTO push_subscriptions(
          id, user_id, access_token_id, endpoint, p256dh, auth, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).bind(
      makeId(),
      userId,
      accessTokenId,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      now,
      now,
    ),
  ]);
}

export async function deletePushSubscription(
  env: Bindings,
  accessTokenId: string,
): Promise<void> {
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE access_token_id = ?")
    .bind(accessTokenId)
    .run();
}

type DueNotification = {
  narration_id: string;
  subscription_id: string;
  attempt_count: number;
  created_at: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  bookmark_id: string;
  title: string;
};

function retryDelaySeconds(response: Response | null, attemptCount: number): number {
  const fallback = RETRY_SECONDS[Math.min(attemptCount, RETRY_SECONDS.length - 1)];
  const raw = response?.headers.get("retry-after")?.trim();
  if (!raw) return fallback;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds, 24 * 60 * 60);
  }
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(0, (date - Date.now()) / 1000), 24 * 60 * 60);
  }
  return fallback;
}

export async function deliverNotification(
  env: Bindings,
  row: DueNotification,
): Promise<void> {
  if (Date.now() - Date.parse(row.created_at) >= NOTIFICATION_LIFETIME_MS || !pushAvailable(env)) {
    await env.DB.prepare(
      "DELETE FROM narration_notifications WHERE narration_id = ? AND subscription_id = ?",
    ).bind(row.narration_id, row.subscription_id).run();
    return;
  }

  const subscription: PushSubscription = {
    endpoint: row.endpoint,
    expirationTime: null,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
  const vapid: VapidKeys = {
    subject: env.VAPID_SUBJECT!.trim(),
    publicKey: env.VAPID_PUBLIC_KEY!.trim(),
    privateKey: env.VAPID_PRIVATE_KEY!.trim(),
  };

  let response: Response | null = null;
  try {
    const payload = await buildPushPayload({
      data: JSON.stringify({
        type: "narration.ready",
        title: "audio ready",
        body: row.title.slice(0, 200),
        path: `/read/${row.bookmark_id}#audio`,
        tag: `narration:${row.narration_id}`,
      }),
      options: { ttl: 24 * 60 * 60, urgency: "normal" },
    }, subscription, vapid);
    response = await fetch(subscription.endpoint, {
      ...payload,
      body: new Uint8Array(payload.body).buffer as ArrayBuffer,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Retry transient encryption, network, and provider failures within the lifetime.
  }

  if (response?.ok) {
    await env.DB.prepare(
      "DELETE FROM narration_notifications WHERE narration_id = ? AND subscription_id = ?",
    ).bind(row.narration_id, row.subscription_id).run();
    return;
  }
  if (response?.status === 404 || response?.status === 410) {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?")
      .bind(row.subscription_id)
      .run();
    return;
  }

  const retryable = !response
    || response.status === 401
    || response.status === 403
    || response.status === 429
    || response.status >= 500;
  if (!retryable) {
    await env.DB.prepare(
      "DELETE FROM narration_notifications WHERE narration_id = ? AND subscription_id = ?",
    ).bind(row.narration_id, row.subscription_id).run();
    return;
  }

  const nextAttempt = new Date(
    Date.now() + retryDelaySeconds(response, row.attempt_count) * 1000,
  ).toISOString();
  await env.DB.prepare(
    `
      UPDATE narration_notifications
      SET attempt_count = attempt_count + 1, next_attempt_at = ?
      WHERE narration_id = ? AND subscription_id = ?
    `,
  ).bind(nextAttempt, row.narration_id, row.subscription_id).run();
}

export async function dueNotifications(
  env: Bindings,
  limit: number,
): Promise<DueNotification[]> {
  const result = await env.DB.prepare(
    `
      SELECT
        nn.narration_id, nn.subscription_id, nn.attempt_count, nn.created_at,
        ps.endpoint, ps.p256dh, ps.auth,
        b.id AS bookmark_id, ac.title
      FROM narration_notifications nn
      JOIN narrations n ON n.id = nn.narration_id AND n.status = 'ready'
      JOIN article_content ac ON ac.id = n.article_id
      JOIN bookmarks b ON b.id = ac.bookmark_id AND b.user_id = ac.user_id
      JOIN push_subscriptions ps ON ps.id = nn.subscription_id AND ps.user_id = ac.user_id
      WHERE nn.next_attempt_at <= ?
      ORDER BY nn.next_attempt_at, nn.narration_id, nn.subscription_id
      LIMIT ?
    `,
  ).bind(nowIso(), limit).all<DueNotification>();
  return result.results ?? [];
}
