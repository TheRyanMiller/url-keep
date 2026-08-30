import { ApiError, type UrlKeepClient } from "@url-keep/api-client";
import type { Narration, ReadyNarrationSummary } from "@url-keep/shared";
import { LoaderCircle, RefreshCw, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import {
  cacheNarrationAudio,
  getCachedAudio,
  getCachedAudioForArticle,
} from "./offline-audio";

function safeError(code: string | null): string {
  if (code === "file_too_large") return "article audio is too large";
  if (code === "source_mismatch") return "article changed before audio finished";
  return "audio could not be prepared";
}

async function verifiedOnlineBlob(
  response: Response,
  audio: NonNullable<Narration["audio"]>,
): Promise<Blob> {
  if (
    response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "audio/mpeg"
    || Number(response.headers.get("content-length")) !== audio.byte_size
    || response.headers.get("x-content-sha256") !== audio.sha256
  ) throw new Error("invalid audio response");
  const bytes = await response.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (bytes.byteLength !== audio.byte_size || digest !== audio.sha256) {
    throw new Error("invalid audio response");
  }
  return new Blob([bytes], { type: "audio/mpeg" });
}

export function ArticleAudio({
  client,
  bookmarkId,
  articleId,
}: {
  client: UrlKeepClient;
  bookmarkId: string;
  articleId: string;
}) {
  const online = useOnlineStatus();
  const [narration, setNarration] = useState<Narration | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [cachedOffline, setCachedOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  const replaceAudioUrl = useCallback((next: string | null) => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = next;
    setAudioUrl(next);
  }, []);

  useEffect(() => () => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
  }, []);

  const loadAudio = useCallback(async (current: Narration) => {
    if (!current.audio) return;
    const summary: ReadyNarrationSummary = {
      id: current.id,
      article_id: articleId,
      ...current.audio,
    };
    let response = await getCachedAudio(summary.id, summary.sha256);
    let isCached = Boolean(response);
    if (!response && online) {
      const stored = await cacheNarrationAudio(client, bookmarkId, summary).catch(() => false);
      response = stored ? await getCachedAudio(summary.id, summary.sha256) : null;
      isCached = Boolean(response);
    }
    if (!response && online) {
      response = await client.getNarrationAudio(bookmarkId);
      isCached = false;
    }
    setCachedOffline(isCached);
    if (!response) {
      replaceAudioUrl(null);
      setMessage("audio isn't downloaded");
      return;
    }
    const blob = isCached
      ? await response.blob()
      : await verifiedOnlineBlob(response, current.audio);
    replaceAudioUrl(URL.createObjectURL(blob));
  }, [articleId, bookmarkId, client, online, replaceAudioUrl]);

  const refresh = useCallback(async () => {
    if (!online) {
      const cached = await getCachedAudioForArticle(articleId);
      if (cached) {
        setCachedOffline(true);
        replaceAudioUrl(URL.createObjectURL(await cached.response.blob()));
      }
      return;
    }
    try {
      const response = await client.getNarration(bookmarkId);
      setNarration(response.item);
      if (response.item.status === "ready") await loadAudio(response.item);
    } catch (caught) {
      if (!(caught instanceof ApiError && caught.status === 404)) {
        setMessage("audio status is unavailable");
      }
    }
  }, [articleId, bookmarkId, client, loadAudio, online, replaceAudioUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (narration?.status !== "pending" || !online) return;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [narration?.status, online, refresh]);

  const request = async (retry = false) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = retry
        ? await client.retryNarration(bookmarkId)
        : await client.requestNarration(bookmarkId);
      setNarration(response.item);
      if (response.item.status === "ready") await loadAudio(response.item);
    } catch {
      setMessage("audio request failed");
    } finally {
      setBusy(false);
    }
  };

  if (audioUrl) {
    return (
      <div className="article-audio">
        <audio controls preload="metadata" src={audioUrl} />
        {!cachedOffline && online ? <span>not saved offline</span> : null}
      </div>
    );
  }
  if (narration?.status === "pending" || busy) {
    return (
      <span className="article-audio-status">
        <LoaderCircle aria-hidden="true" className="spin" size={14} />
        preparing audio — safe to leave
      </span>
    );
  }
  if (narration?.status === "failed") {
    return (
      <span className="article-audio-status">
        {safeError(narration.error_code)}
        {narration.retryable && online ? (
          <button className="icon-action" onClick={() => void request(true)} type="button">
            <RefreshCw aria-hidden="true" size={14} />
            <span className="sr-only">retry audio</span>
          </button>
        ) : null}
      </span>
    );
  }
  if (!online) {
    return message ? <span className="article-audio-status">{message}</span> : null;
  }
  return (
    <span className="article-audio-request">
      <button
        aria-label="prepare article audio"
        className="reader-text-size-trigger"
        onClick={() => void request()}
        title="Prepare article audio"
        type="button"
      >
        <Volume2 aria-hidden="true" size={15} />
      </button>
      {message ? <span>{message}</span> : null}
    </span>
  );
}
