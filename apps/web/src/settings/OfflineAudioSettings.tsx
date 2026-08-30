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

  if (!settings) return <p className="muted">loading audio settings</p>;
  return (
    <section className="profile-section">
      <h2 className="section-title">offline audio</h2>
      <label className="settings-row">
        <span>download requested audio on this device</span>
        <input
          checked={settings.enabled}
          onChange={async (event) => {
            setSettings(await updateAudioSettings({ enabled: event.target.checked }));
            await refresh();
          }}
          type="checkbox"
        />
      </label>
      <p className="muted">
        {megabytes(usage.bytes)} of {megabytes(settings.byte_limit)} · {usage.count} audio
      </p>
      <label className="field settings-limit">
        <span>storage limit</span>
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
      <button
        className={clearArmed ? "text-action danger" : "text-action"}
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
        {clearArmed ? "confirm clear offline audio" : "clear offline audio"}
      </button>
    </section>
  );
}
