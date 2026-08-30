import type { UrlKeepClient } from "@url-keep/api-client";
import { useEffect, useState } from "react";
import { disablePush, enablePush, pushSupported } from "../push";

export function NotificationSettings({
  client,
  online,
}: {
  client: UrlKeepClient;
  online: boolean;
}) {
  const [available, setAvailable] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    if (!online) return;
    try {
      const config = await client.getPushConfig();
      setAvailable(config.available && pushSupported());
      setPublicKey(config.public_key);
      setSubscribed(config.subscribed);
    } catch {
      setMessage("notification status is unavailable");
    }
  };

  useEffect(() => {
    void refresh();
  }, [client, online]);

  const toggle = async () => {
    if (!online || !publicKey) return;
    setBusy(true);
    setMessage(null);
    try {
      if (subscribed) await disablePush(client);
      else await enablePush(client, publicKey);
      await refresh();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "notification update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="profile-section">
      <h2 className="section-title">notifications</h2>
      <div className="settings-row">
        <span>this browser</span>
        {available ? (
          <button className="text-action" disabled={!online || busy} onClick={() => void toggle()} type="button">
            {subscribed ? "disable" : "enable"}
          </button>
        ) : <span className="muted">unsupported or blocked</span>}
      </div>
      {message ? <p className="muted">{message}</p> : null}
    </section>
  );
}
