import {
  Check,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

const PLAYBACK_RATE_STORAGE_KEY = "url_keep_audio_rate";
const POSITION_SAVE_INTERVAL_SECONDS = 5;
const POSITION_END_THRESHOLD_SECONDS = 10;

type NavigatorWithAudioSession = Navigator & {
  audioSession?: { type: string };
};

export function formatPlaybackRate(rate: number) {
  return `${rate.toFixed(rate % 1 === 0 ? 0 : 2).replace(/0$/, "")}×`;
}

export function formatPlaybackTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function isPlaybackRate(value: number): value is (typeof PLAYBACK_RATES)[number] {
  return PLAYBACK_RATES.some((rate) => rate === value);
}

function readStoredPlaybackRate() {
  try {
    const value = Number(window.localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY));
    return isPlaybackRate(value) ? value : 1;
  } catch {
    return 1;
  }
}

function requestPlaybackAudioSession() {
  const audioSession = (navigator as NavigatorWithAudioSession).audioSession;
  if (!audioSession) return;
  try {
    audioSession.type = "playback";
  } catch {
    // Audio Session is still experimental outside WebKit.
  }
}

export function AudioPlayer({
  audioUrl,
  identity,
  title,
  artist,
  playOnMount = false,
  reveal = false,
}: {
  audioUrl: string;
  identity: string;
  title: string;
  artist?: string | null;
  playOnMount?: boolean;
  reveal?: boolean;
}) {
  const [playerOpen, setPlayerOpen] = useState(reveal || playOnMount);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(readStoredPlaybackRate);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [message, setMessage] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSavedTimeRef = useRef(0);
  const restoredPositionRef = useRef(false);
  const attemptedInitialPlayRef = useRef(false);
  const speedControlRef = useRef<HTMLSpanElement | null>(null);
  const speedButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerId = useId();
  const speedOptionsId = useId();
  const positionKey = `url_keep_audio_position:${identity}`;

  function clearStoredPosition() {
    try {
      window.localStorage.removeItem(positionKey);
    } catch {
      // Playback position is best effort.
    }
  }

  function persistPosition(force = false) {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.currentTime)) return;
    if (audio.currentTime <= 0.5) {
      clearStoredPosition();
      lastSavedTimeRef.current = 0;
      return;
    }
    if (
      Number.isFinite(audio.duration)
      && audio.duration - audio.currentTime <= POSITION_END_THRESHOLD_SECONDS
    ) {
      clearStoredPosition();
      return;
    }
    if (
      !force
      && Math.abs(audio.currentTime - lastSavedTimeRef.current)
        < POSITION_SAVE_INTERVAL_SECONDS
    ) return;
    try {
      window.localStorage.setItem(positionKey, JSON.stringify({
        position: Math.round(audio.currentTime * 10) / 10,
      }));
      lastSavedTimeRef.current = audio.currentTime;
    } catch {
      // Playback position is best effort.
    }
  }

  function restorePosition(audio: HTMLAudioElement) {
    if (restoredPositionRef.current) return;
    restoredPositionRef.current = true;
    try {
      const stored = JSON.parse(window.localStorage.getItem(positionKey) ?? "null") as {
        position?: unknown;
      } | null;
      const position = Number(stored?.position);
      if (
        Number.isFinite(position)
        && position > 0
        && position < audio.duration - POSITION_END_THRESHOLD_SECONDS
      ) {
        audio.currentTime = position;
        setCurrentTime(position);
        lastSavedTimeRef.current = position;
      } else if (stored) {
        clearStoredPosition();
      }
    } catch {
      clearStoredPosition();
    }
  }

  function seek(nextTime: number) {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(nextTime)) return;
    const maximum = Number.isFinite(audio.duration) ? audio.duration : Infinity;
    const clamped = Math.min(maximum, Math.max(0, nextTime));
    audio.currentTime = clamped;
    setCurrentTime(clamped);
  }

  function skip(seconds: number) {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.currentTime)) return;
    seek(audio.currentTime + seconds);
    persistPosition(true);
  }

  async function playAudio(failureMessage = "Audio could not be played.") {
    const audio = audioRef.current;
    if (!audio) return;
    requestPlaybackAudioSession();
    audio.playbackRate = playbackRate;
    try {
      await audio.play();
      setMessage("");
    } catch {
      setMessage(failureMessage);
    }
  }

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      persistPosition(true);
      return;
    }
    await playAudio();
  }

  function togglePlayer() {
    if (playerOpen) {
      audioRef.current?.pause();
      persistPosition(true);
      setSpeedMenuOpen(false);
      setPlayerOpen(false);
      return;
    }
    setMessage("");
    setPlayerOpen(true);
    void playAudio();
  }

  function selectPlaybackRate(rate: (typeof PLAYBACK_RATES)[number]) {
    setPlaybackRate(rate);
    if (audioRef.current) audioRef.current.playbackRate = rate;
    try {
      window.localStorage.setItem(PLAYBACK_RATE_STORAGE_KEY, String(rate));
    } catch {
      // Playback rate is best effort.
    }
    setSpeedMenuOpen(false);
    window.requestAnimationFrame(() => speedButtonRef.current?.focus());
  }

  useEffect(() => {
    if (reveal) setPlayerOpen(true);
  }, [reveal]);

  useEffect(() => {
    if (!playOnMount || attemptedInitialPlayRef.current) return;
    attemptedInitialPlayRef.current = true;
    setPlayerOpen(true);
    void playAudio("Ready—press play.");
  }, [playOnMount]);

  useEffect(() => {
    if (!speedMenuOpen) return;
    const closeFromPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && !speedControlRef.current?.contains(event.target)
      ) setSpeedMenuOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSpeedMenuOpen(false);
        speedButtonRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", closeFromPointer);
    window.addEventListener("keydown", closeFromKeyboard);
    return () => {
      window.removeEventListener("pointerdown", closeFromPointer);
      window.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [speedMenuOpen]);

  useEffect(() => {
    const savePosition = () => persistPosition(true);
    window.addEventListener("pagehide", savePosition);
    return () => {
      savePosition();
      window.removeEventListener("pagehide", savePosition);
    };
  }, [positionKey]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    if ("MediaMetadata" in window) {
      session.metadata = new MediaMetadata({
        title: title.trim() || "Article audio",
        artist: artist?.trim() || "url-keep",
        album: "url-keep",
        artwork: [
          {
            src: new URL("/icons/icon-192.png", window.location.origin).href,
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: new URL("/icons/icon-512.png", window.location.origin).href,
            sizes: "512x512",
            type: "image/png",
          },
        ],
      });
    }
    const actions: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => void playAudio()],
      ["pause", () => {
        audioRef.current?.pause();
        persistPosition(true);
      }],
      ["seekbackward", (details) => skip(-(details.seekOffset ?? 10))],
      ["seekforward", (details) => skip(details.seekOffset ?? 10)],
      ["seekto", (details) => {
        if (typeof details.seekTime === "number") {
          seek(details.seekTime);
          persistPosition(true);
        }
      }],
    ];
    const installed: MediaSessionAction[] = [];
    for (const [action, handler] of actions) {
      try {
        session.setActionHandler(action, handler);
        installed.push(action);
      } catch {
        // Media Session actions vary by browser and Safari release.
      }
    }
    return () => {
      for (const action of installed) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // The action may no longer be supported.
        }
      }
      session.metadata = null;
      session.playbackState = "none";
    };
  }, [audioUrl, artist, playbackRate, positionKey, title]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    session.playbackState = playing ? "playing" : "paused";
    if (duration <= 0) return;
    try {
      session.setPositionState({
        duration,
        playbackRate,
        position: Math.min(duration, Math.max(0, currentTime)),
      });
    } catch {
      // Position state is optional on older Safari releases.
    }
  }, [currentTime, duration, playbackRate, playing]);

  const seekProgress = duration > 0
    ? Math.min(100, Math.max(0, (currentTime / duration) * 100))
    : 0;
  const seekStyle = { "--audio-progress": `${seekProgress}%` } as CSSProperties;

  return (
    <span className="article-audio-control">
      <button
        aria-controls={playerId}
        aria-expanded={playerOpen}
        aria-label={playerOpen ? "Hide article audio player" : "Play article audio"}
        aria-pressed={playerOpen}
        className={`reader-toolbar-action${playerOpen ? "" : " article-audio-button-ready"}`}
        onClick={togglePlayer}
        title={playerOpen ? "Hide audio player" : "Play article audio"}
        type="button"
      >
        <Volume2 aria-hidden="true" size={17} strokeWidth={1.8} />
      </button>
      <audio
        aria-hidden="true"
        className="article-audio-engine"
        onDurationChange={(event) => {
          const next = Number.isFinite(event.currentTarget.duration)
            ? event.currentTarget.duration
            : 0;
          setDuration(next);
        }}
        onEnded={() => {
          setPlaying(false);
          clearStoredPosition();
          setCurrentTime(0);
        }}
        onError={() => setMessage("Audio could not be loaded.")}
        onLoadedMetadata={(event) => {
          const audio = event.currentTarget;
          setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
          audio.playbackRate = playbackRate;
          restorePosition(audio);
        }}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        onTimeUpdate={(event) => {
          setCurrentTime(event.currentTarget.currentTime);
          persistPosition();
        }}
        preload="metadata"
        ref={audioRef}
        src={audioUrl}
      />
      {playerOpen ? (
        <span
          aria-label="Article audio player"
          className="article-audio-overlay"
          id={playerId}
          role="group"
        >
          <span className="article-audio-transport">
            <button
              aria-label="Skip back 10 seconds"
              className="article-audio-skip-button"
              disabled={duration <= 0}
              onClick={() => skip(-10)}
              type="button"
            >
              <RotateCcw aria-hidden="true" size={19} strokeWidth={1.8} />
              <span aria-hidden="true" className="article-audio-skip-label">10</span>
            </button>
            <button
              aria-label={playing ? "Pause article audio" : "Play article audio"}
              className="article-audio-play-button"
              onClick={() => void togglePlayback()}
              type="button"
            >
              {playing
                ? <Pause aria-hidden="true" size={16} strokeWidth={2} />
                : <Play aria-hidden="true" size={16} strokeWidth={2} />}
            </button>
            <button
              aria-label="Skip forward 10 seconds"
              className="article-audio-skip-button"
              disabled={duration <= 0}
              onClick={() => skip(10)}
              type="button"
            >
              <RotateCw aria-hidden="true" size={19} strokeWidth={1.8} />
              <span aria-hidden="true" className="article-audio-skip-label">10</span>
            </button>
          </span>
          <span className="article-audio-speed-control" ref={speedControlRef}>
            <button
              aria-controls={speedMenuOpen ? speedOptionsId : undefined}
              aria-expanded={speedMenuOpen}
              aria-label={`Playback speed ${formatPlaybackRate(playbackRate)}`}
              className="article-audio-speed-button"
              onClick={() => setSpeedMenuOpen((open) => !open)}
              ref={speedButtonRef}
              type="button"
            >
              {formatPlaybackRate(playbackRate)}
            </button>
            {speedMenuOpen ? (
              <span
                aria-label="Playback speed"
                className="article-audio-speed-menu"
                id={speedOptionsId}
                role="group"
              >
                {PLAYBACK_RATES.map((rate) => (
                  <button
                    aria-pressed={rate === playbackRate}
                    className="article-audio-speed-option"
                    key={rate}
                    onClick={() => selectPlaybackRate(rate)}
                    type="button"
                  >
                    <span>{formatPlaybackRate(rate)}</span>
                    {rate === playbackRate
                      ? <Check aria-hidden="true" size={13} strokeWidth={2} />
                      : null}
                  </button>
                ))}
              </span>
            ) : null}
          </span>
          <span className="article-audio-timeline">
            <span aria-hidden="true" className="article-audio-time">
              {formatPlaybackTime(currentTime)}
            </span>
            <input
              aria-label="Article audio position"
              aria-valuetext={`${formatPlaybackTime(currentTime)} of ${formatPlaybackTime(duration)}`}
              className="article-audio-seek"
              disabled={duration <= 0}
              max={duration > 0 ? duration : 0}
              min="0"
              onBlur={() => persistPosition(true)}
              onChange={(event) => seek(Number(event.currentTarget.value))}
              onPointerUp={() => persistPosition(true)}
              step="0.1"
              style={seekStyle}
              type="range"
              value={duration > 0 ? Math.min(currentTime, duration) : 0}
            />
            <span aria-hidden="true" className="article-audio-time article-audio-duration">
              {formatPlaybackTime(duration)}
            </span>
          </span>
          {message ? <span className="article-audio-playback-error" role="status">{message}</span> : null}
        </span>
      ) : null}
    </span>
  );
}
