import type { UrlKeepClient } from "@url-keep/api-client";

function applicationServerKey(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function enablePush(client: UrlKeepClient, publicKey: string): Promise<void> {
  if (!pushSupported()) throw new Error("notifications are not supported");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("notification permission was not granted");
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey),
  });
  const value = subscription.toJSON();
  if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth) {
    await subscription.unsubscribe();
    throw new Error("browser returned an invalid subscription");
  }
  try {
    await client.putPushSubscription({
      endpoint: value.endpoint,
      expirationTime: value.expirationTime ?? null,
      keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
    });
  } catch (caught) {
    await subscription.unsubscribe();
    throw caught;
  }
}

export async function disablePush(client: UrlKeepClient): Promise<void> {
  await client.deletePushSubscription();
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  await (await registration.pushManager.getSubscription())?.unsubscribe();
}
