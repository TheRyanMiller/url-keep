import { useEffect, useState } from "react";
import {
  clearOfflineAudio,
  getAudioSettings,
  getOfflineAudioUsage,
  updateAudioSettings,
} from "../audio/offline-audio";
import { OFFLINE_AUDIO_LIMITS, type AudioSettings } from "../offline/db";

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function OfflineAudioSettings() {
  const [settings, setSettings] = useState<AudioSettings | null>(null);
  const [usage, setUsage] = useState({ bytes: 0, count: 0 });
  const [clearArmed, setClearArmed] = useState(false);

  const refresh = async () => {
    setSettings(await getAudioSettings());
    setUsage(await getOfflineAudioUsage());
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (!settings) {
    return (
      <section aria-busy="true" className="profile-section offline-audio-settings">
        <h2 className="section-title">offline audio</h2>
      </section>
    );
  }
  return (
    <section className="profile-section offline-audio-settings">
      <h2 className="section-title">offline audio</h2>
      <div className="settings-section-body">
        <label className="settings-row">
          <span>keep requested audio on this device</span>
          <input
            checked={settings.enabled}
            onChange={async (event) => {
              setSettings(await updateAudioSettings({ enabled: event.target.checked }));
              await refresh();
            }}
            type="checkbox"
          />
        </label>
        <div className="settings-inline-row">
          <p className="muted settings-note">
            {megabytes(usage.bytes)} used of {megabytes(settings.byte_limit)} · {usage.count} files
          </p>
          <label className="settings-inline-field">
            <span>limit</span>
            <select
              value={settings.byte_limit}
              onChange={async (event) => {
                setSettings(await updateAudioSettings({ byte_limit: Number(event.target.value) }));
                await refresh();
              }}
            >
              {OFFLINE_AUDIO_LIMITS.map((limit) => (
                <option key={limit} value={limit}>{megabytes(limit)}</option>
              ))}
            </select>
          </label>
        </div>
        {usage.count > 0 ? (
          <button
            className={`button secondary-button settings-button${clearArmed ? " button-danger" : ""}`}
            onClick={async () => {
              if (!clearArmed) {
                setClearArmed(true);
                window.setTimeout(() => setClearArmed(false), 3_000);
                return;
              }
              await clearOfflineAudio();
              setClearArmed(false);
              await refresh();
            }}
            type="button"
          >
            {clearArmed ? "confirm clear" : "clear audio"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
