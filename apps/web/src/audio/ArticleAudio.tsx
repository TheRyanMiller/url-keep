import { ApiError, type UrlKeepClient } from "@url-keep/api-client";
import type { Narration, ReadyNarrationSummary } from "@url-keep/shared";
import { RefreshCw, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { AudioPlayer } from "./AudioPlayer";
import {
  cacheNarrationAudio,
  getCachedAudio,
  getCachedAudioForArticle,
} from "./offline-audio";

const POLL_DELAYS_MS = [5_000, 10_000, 15_000];

type NarrationView =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "ready"; audioUrl: string; identity: string }
  | { kind: "failed"; message: string; retryable: boolean };

function safeError(code: string | null): string {
  if (code === "file_too_large") return "Article audio is too large.";
  if (code === "source_mismatch") return "The article changed before audio finished.";
  return "Audio could not be prepared.";
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
  title,
  artist,
  reveal = false,
}: {
  client: UrlKeepClient;
  bookmarkId: string;
  articleId: string;
  title: string;
  artist?: string | null;
  reveal?: boolean;
}) {
  const online = useOnlineStatus();
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [view, setView] = useState<NarrationView>({ kind: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  function replaceAudioUrl(next: string | null) {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = next;
  }

  async function showReady(current: Narration, signal: AbortSignal) {
    if (!current.audio) throw new Error("ready narration has no audio");
    const summary: ReadyNarrationSummary = {
      id: current.id,
      article_id: articleId,
      ...current.audio,
    };
    let response = await getCachedAudio(summary.id, summary.sha256);
    let cached = Boolean(response);
    if (!response && online) {
      const stored = await cacheNarrationAudio(client, bookmarkId, summary, signal)
        .catch(() => false);
      if (stored) {
        response = await getCachedAudio(summary.id, summary.sha256);
        cached = Boolean(response);
      }
    }
    if (!response && online) {
      response = await client.getNarrationAudio(bookmarkId, signal);
    }
    if (!response) throw new Error("audio unavailable");
    const blob = cached
      ? await response.blob()
      : await verifiedOnlineBlob(response, current.audio);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const audioUrl = URL.createObjectURL(blob);
    replaceAudioUrl(audioUrl);
    setView({
      kind: "ready",
      audioUrl,
      identity: `${summary.id}:${summary.sha256}`,
    });
  }

  async function resolveNarration(
    current: Narration,
    controller: AbortController,
    submission: { used: boolean },
  ) {
    if (current.status === "ready") {
      await showReady(current, controller.signal);
      return;
    }
    if (current.status === "failed") {
      setView({
        kind: "failed",
        message: safeError(current.error_code),
        retryable: current.retryable,
      });
      return;
    }
    setView({ kind: "preparing" });
    let attempt = 0;
    while (!controller.signal.aborted) {
      await wait(
        POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)],
        controller.signal,
      );
      let response;
      try {
        response = await client.getNarration(bookmarkId, controller.signal);
      } catch (caught) {
        if (
          caught instanceof ApiError
          && caught.code === "submission_required"
          && !submission.used
        ) {
          submission.used = true;
          response = await client.requestNarration(bookmarkId, controller.signal);
        } else {
          throw caught;
        }
      }
      if (response.item.status !== "pending") {
        await resolveNarration(response.item, controller, submission);
        return;
      }
      attempt += 1;
    }
  }

  function begin() {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller;
  }

  async function request(retry: boolean) {
    if (!online) return;
    const controller = begin();
    replaceAudioUrl(null);
    setView({ kind: "preparing" });
    try {
      const response = retry
        ? await client.retryNarration(bookmarkId, controller.signal)
        : await client.requestNarration(bookmarkId, controller.signal);
      await resolveNarration(response.item, controller, { used: true });
    } catch {
      if (!controller.signal.aborted) {
        setView({
          kind: "failed",
          message: "Audio request failed.",
          retryable: false,
        });
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  useEffect(() => {
    const onVisibilityChange = () => {
      const nextVisible = document.visibilityState !== "hidden";
      if (!nextVisible) controllerRef.current?.abort();
      setVisible(nextVisible);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    const controller = begin();
    replaceAudioUrl(null);
    setView({ kind: "idle" });
    void (async () => {
      try {
        if (!visible) return;
        if (!online) {
          const cached = await getCachedAudioForArticle(articleId);
          if (!cached || controller.signal.aborted) return;
          const blob = await cached.response.blob();
          if (controller.signal.aborted) return;
          const audioUrl = URL.createObjectURL(blob);
          replaceAudioUrl(audioUrl);
          setView({
            kind: "ready",
            audioUrl,
            identity: `${cached.record.narration_id}:${cached.record.sha256}`,
          });
          return;
        }
        const submission = { used: false };
        let response;
        try {
          response = await client.getNarration(bookmarkId, controller.signal);
        } catch (caught) {
          if (
            caught instanceof ApiError
            && caught.code === "submission_required"
            && !submission.used
          ) {
            submission.used = true;
            response = await client.requestNarration(bookmarkId, controller.signal);
          } else {
            throw caught;
          }
        }
        await resolveNarration(response.item, controller, submission);
      } catch (caught) {
        if (
          !controller.signal.aborted
          && !(caught instanceof ApiError && caught.status === 404)
        ) setView({ kind: "idle" });
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    })();
    return () => controller.abort();
  }, [articleId, bookmarkId, client, online, visible]);

  useEffect(() => () => {
    controllerRef.current?.abort();
    replaceAudioUrl(null);
  }, []);

  if (view.kind === "ready") {
    return (
      <AudioPlayer
        artist={artist}
        audioUrl={view.audioUrl}
        identity={view.identity}
        key={view.identity}
        reveal={reveal}
        title={title}
      />
    );
  }
  if (view.kind === "preparing") {
    return (
      <span className="article-audio-control">
        <button
          aria-busy="true"
          aria-label="Preparing article audio"
          className="reader-toolbar-action"
          disabled
          title="Preparing audio"
          type="button"
        >
          <span aria-hidden="true" className="article-audio-spinner" />
        </button>
      </span>
    );
  }
  if (view.kind === "failed") {
    return (
      <span className="article-audio-control">
        {view.retryable && online ? (
          <button
            aria-label="Retry article audio"
            className="reader-toolbar-action"
            onClick={() => void request(true)}
            title="Retry audio"
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} strokeWidth={1.8} />
          </button>
        ) : null}
        <span className="article-audio-feedback" role="status">{view.message}</span>
      </span>
    );
  }
  if (!online) return null;
  return (
    <span className="article-audio-control">
      <button
        aria-label="Prepare article audio"
        className="reader-toolbar-action"
        onClick={() => void request(false)}
        title="Listen"
        type="button"
      >
        <Volume2 aria-hidden="true" size={17} strokeWidth={1.8} />
      </button>
    </span>
  );
}
