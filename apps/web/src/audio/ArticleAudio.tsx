import { ApiError, type UrlKeepClient } from "@url-keep/api-client";
import type { Narration, ReadyNarrationSummary } from "@url-keep/shared";
import { RefreshCw, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { getPrivateStorageGeneration } from "../offline/db";
import { AudioPlayer } from "./AudioPlayer";
import {
  downloadVerifiedAudio,
  persistVerifiedAudio,
  readVerifiedCachedAudio,
} from "./offline-audio";

const POLL_DELAYS_MS = [5_000, 10_000, 15_000];

type ReadyAsset =
  | { kind: "unloaded" }
  | { kind: "loading" }
  | { kind: "load-failed"; message: string; retryable: boolean }
  | { kind: "loaded"; audioUrl: string; playOnMount: boolean };

type NarrationView =
  | { kind: "checking" }
  | { kind: "check-failed" }
  | { kind: "absent" }
  | { kind: "pending"; narrationId: string }
  | {
      kind: "generation-failed";
      message: string;
      retryable: boolean;
      retryMode: "request" | "retry";
    }
  | { kind: "ready"; summary: ReadyNarrationSummary; asset: ReadyAsset };

class OfflineAudioUnavailable extends Error {}

function narrationIdentity(summary: ReadyNarrationSummary): string {
  return `${summary.id}:${summary.sha256}`;
}

function safeError(code: string | null): string {
  if (code === "file_too_large") return "Article audio is too large.";
  if (code === "source_mismatch") return "The article changed before audio finished.";
  if (code === "audio_missing") return "Article audio needs to be generated again.";
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

function readySummary(current: Narration, articleId: string): ReadyNarrationSummary {
  if (!current.audio) throw new Error("ready narration has no audio");
  return {
    id: current.id,
    article_id: articleId,
    ...current.audio,
  };
}

function statusWorkNeeded(view: NarrationView): boolean {
  return view.kind === "checking" || view.kind === "check-failed" || view.kind === "pending";
}

function documentIsVisible(): boolean {
  return document.visibilityState !== "hidden";
}

export function ArticleAudio({
  client,
  bookmarkId,
  articleId,
  initialNarration,
  title,
  artist,
  reveal = false,
}: {
  client: UrlKeepClient;
  bookmarkId: string;
  articleId: string;
  initialNarration: ReadyNarrationSummary | null;
  title: string;
  artist?: string | null;
  reveal?: boolean;
}) {
  const online = useOnlineStatus();
  const initialView: NarrationView = initialNarration
    ? { kind: "ready", summary: initialNarration, asset: { kind: "unloaded" } }
    : { kind: "checking" };
  const [view, setView] = useState<NarrationView>(initialView);
  const viewRef = useRef<NarrationView>(initialView);
  const onlineRef = useRef(online);
  const statusControllerRef = useRef<AbortController | null>(null);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const audioControllerRef = useRef<AbortController | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const loadPromiseRef = useRef<{
    identity: string;
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);
  const rejectedReadyIdentitiesRef = useRef(new Set<string>());
  const resubmissionRef = useRef<{
    articleId: string;
    narrationId: string | null;
    used: boolean;
  }>({ articleId, narrationId: null, used: false });

  onlineRef.current = online;

  const commitView = useCallback((next: NarrationView) => {
    viewRef.current = next;
    setView(next);
  }, []);

  const replaceAudioUrl = useCallback((next: string | null) => {
    if (audioUrlRef.current && audioUrlRef.current !== next) {
      URL.revokeObjectURL(audioUrlRef.current);
    }
    audioUrlRef.current = next;
  }, []);

  const adoptReady = useCallback((summary: ReadyNarrationSummary) => {
    const identity = narrationIdentity(summary);
    const current = viewRef.current;
    if (
      current.kind === "ready"
      && narrationIdentity(current.summary) === identity
    ) return;
    statusControllerRef.current?.abort();
    audioControllerRef.current?.abort();
    loadPromiseRef.current = null;
    replaceAudioUrl(null);
    commitView({ kind: "ready", summary, asset: { kind: "unloaded" } });
  }, [commitView, replaceAudioUrl]);

  const adoptNarration = useCallback((current: Narration) => {
    if (current.status === "ready") {
      adoptReady(readySummary(current, articleId));
      return;
    }
    if (current.status === "failed") {
      audioControllerRef.current?.abort();
      loadPromiseRef.current = null;
      replaceAudioUrl(null);
      commitView({
        kind: "generation-failed",
        message: safeError(current.error_code),
        retryable: current.retryable,
        retryMode: "retry",
      });
      return;
    }
    const guard = resubmissionRef.current;
    if (guard.narrationId && guard.narrationId !== current.id) {
      resubmissionRef.current = { articleId, narrationId: current.id, used: false };
    } else {
      guard.narrationId = current.id;
    }
    commitView({ kind: "pending", narrationId: current.id });
  }, [adoptReady, articleId, commitView, replaceAudioUrl]);

  const startStatusWork = useCallback((initialDelay = 0) => {
    if (!onlineRef.current || !documentIsVisible() || !statusWorkNeeded(viewRef.current)) return;
    statusControllerRef.current?.abort();
    const controller = new AbortController();
    statusControllerRef.current = controller;

    void (async () => {
      let attempt = 0;
      try {
        if (initialDelay > 0) await wait(initialDelay, controller.signal);
        while (!controller.signal.aborted && onlineRef.current && documentIsVisible()) {
          let response;
          try {
            response = await client.getNarration(bookmarkId, controller.signal);
          } catch (caught) {
            if (controller.signal.aborted) return;
            if (caught instanceof ApiError && caught.status === 404) {
              commitView({ kind: "absent" });
              return;
            }
            if (caught instanceof ApiError && caught.code === "submission_required") {
              const guard = resubmissionRef.current;
              if (guard.articleId !== articleId || guard.used) {
                commitView({ kind: "check-failed" });
                return;
              }
              guard.used = true;
              response = await client.requestNarration(bookmarkId, controller.signal);
            } else {
              commitView({ kind: "check-failed" });
              return;
            }
          }
          if (controller.signal.aborted) return;
          adoptNarration(response.item);
          if (response.item.status !== "pending") return;
          await wait(
            POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)],
            controller.signal,
          );
          attempt += 1;
        }
      } catch {
        if (!controller.signal.aborted) commitView({ kind: "check-failed" });
      } finally {
        if (statusControllerRef.current === controller) statusControllerRef.current = null;
      }
    })();
  }, [adoptNarration, articleId, bookmarkId, client, commitView]);

  const requestNarration = useCallback(async (retry: boolean) => {
    if (!onlineRef.current) return;
    mutationControllerRef.current?.abort();
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    statusControllerRef.current?.abort();
    audioControllerRef.current?.abort();
    loadPromiseRef.current = null;
    replaceAudioUrl(null);
    commitView({ kind: "pending", narrationId: "requesting" });
    try {
      const response = retry
        ? await client.retryNarration(bookmarkId, controller.signal)
        : await client.requestNarration(bookmarkId, controller.signal);
      if (controller.signal.aborted) return;
      resubmissionRef.current = {
        articleId,
        narrationId: response.item.id,
        used: true,
      };
      adoptNarration(response.item);
      if (
        response.item.status === "pending"
        && onlineRef.current
        && documentIsVisible()
      ) startStatusWork(POLL_DELAYS_MS[0]);
    } catch (caught) {
      if (!controller.signal.aborted) {
        commitView({
          kind: "generation-failed",
          message: "Audio request failed.",
          retryable: caught instanceof ApiError && (caught.retryable || caught.status === 0),
          retryMode: "request",
        });
      }
    } finally {
      if (mutationControllerRef.current === controller) mutationControllerRef.current = null;
    }
  }, [adoptNarration, articleId, bookmarkId, client, commitView, replaceAudioUrl, startStatusWork]);

  const loadReadyAudio = useCallback((summary: ReadyNarrationSummary, playOnMount: boolean) => {
    const identity = narrationIdentity(summary);
    const existing = loadPromiseRef.current;
    if (existing?.identity === identity) return existing.promise;

    audioControllerRef.current?.abort();
    const controller = new AbortController();
    audioControllerRef.current = controller;
    const storageGeneration = getPrivateStorageGeneration();
    commitView({ kind: "ready", summary, asset: { kind: "loading" } });

    let downloaded = false;
    const promise = (async () => {
      try {
        let bytes = await readVerifiedCachedAudio(
          summary,
          controller.signal,
          storageGeneration,
        );
        if (!bytes) {
          if (!onlineRef.current) throw new OfflineAudioUnavailable();
          bytes = await downloadVerifiedAudio(client, bookmarkId, summary, controller.signal);
          downloaded = true;
        }
        if (controller.signal.aborted) return;
        const current = viewRef.current;
        if (
          current.kind !== "ready"
          || narrationIdentity(current.summary) !== identity
        ) return;

        const audioUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
        if (controller.signal.aborted) {
          URL.revokeObjectURL(audioUrl);
          return;
        }
        replaceAudioUrl(audioUrl);
        commitView({
          kind: "ready",
          summary,
          asset: { kind: "loaded", audioUrl, playOnMount },
        });
        if (downloaded) {
          void persistVerifiedAudio(
            summary,
            bytes,
            controller.signal,
            storageGeneration,
          ).catch(() => false).finally(() => {
            if (audioControllerRef.current === controller) audioControllerRef.current = null;
          });
        } else if (audioControllerRef.current === controller) {
          audioControllerRef.current = null;
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof OfflineAudioUnavailable) {
          commitView({
            kind: "ready",
            summary,
            asset: {
              kind: "load-failed",
              message: "Audio wasn’t saved for offline use.",
              retryable: false,
            },
          });
          return;
        }
        if (caught instanceof ApiError && caught.code === "audio_missing") {
          rejectedReadyIdentitiesRef.current.add(identity);
          commitView({
            kind: "generation-failed",
            message: safeError("audio_missing"),
            retryable: true,
            retryMode: "retry",
          });
          return;
        }
        if (caught instanceof ApiError && caught.status === 404) {
          rejectedReadyIdentitiesRef.current.add(identity);
          commitView({ kind: "checking" });
          if (onlineRef.current && documentIsVisible()) startStatusWork();
          return;
        }
        commitView({
          kind: "ready",
          summary,
          asset: {
            kind: "load-failed",
            message: "Audio could not be loaded.",
            retryable: true,
          },
        });
      } finally {
        if (loadPromiseRef.current?.controller === controller) loadPromiseRef.current = null;
        if (audioControllerRef.current === controller && !downloaded) {
          audioControllerRef.current = null;
        }
      }
    })();
    loadPromiseRef.current = { identity, controller, promise };
    return promise;
  }, [bookmarkId, client, commitView, replaceAudioUrl, startStatusWork]);

  useEffect(() => {
    if (!initialNarration || initialNarration.article_id !== articleId) return;
    if (rejectedReadyIdentitiesRef.current.has(narrationIdentity(initialNarration))) return;
    adoptReady(initialNarration);
  }, [adoptReady, articleId, initialNarration]);

  useEffect(() => {
    if (!online) {
      statusControllerRef.current?.abort();
      return;
    }
    if (documentIsVisible() && statusWorkNeeded(viewRef.current)) startStatusWork();
  }, [online, startStatusWork]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!documentIsVisible()) {
        statusControllerRef.current?.abort();
        return;
      }
      if (onlineRef.current && statusWorkNeeded(viewRef.current)) startStatusWork();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [startStatusWork]);

  useEffect(() => {
    if (
      reveal
      && view.kind === "ready"
      && view.asset.kind === "unloaded"
    ) void loadReadyAudio(view.summary, false);
  }, [loadReadyAudio, reveal, view]);

  useEffect(() => () => {
    statusControllerRef.current?.abort();
    mutationControllerRef.current?.abort();
    audioControllerRef.current?.abort();
    replaceAudioUrl(null);
  }, [replaceAudioUrl]);

  if (view.kind === "ready") {
    if (view.asset.kind === "loaded") {
      return (
        <AudioPlayer
          artist={artist}
          audioUrl={view.asset.audioUrl}
          identity={narrationIdentity(view.summary)}
          key={narrationIdentity(view.summary)}
          playOnMount={view.asset.playOnMount}
          reveal={reveal}
          title={title}
        />
      );
    }
    if (view.asset.kind === "loading") {
      return (
        <span className="article-audio-control">
          <button
            aria-busy="true"
            aria-label="Loading article audio"
            className="reader-toolbar-action"
            disabled
            type="button"
          >
            <span aria-hidden="true" className="article-audio-spinner" />
          </button>
          <span className="article-audio-label" role="status">Loading audio…</span>
        </span>
      );
    }
    if (view.asset.kind === "load-failed") {
      return (
        <span className="article-audio-control">
          {view.asset.retryable && online ? (
            <button
              aria-label="Retry loading article audio"
              className="reader-toolbar-action"
              onClick={() => void loadReadyAudio(view.summary, true)}
              title="Retry loading"
              type="button"
            >
              <RefreshCw aria-hidden="true" size={16} strokeWidth={1.8} />
            </button>
          ) : null}
          <span className="article-audio-label" role="status" title={view.asset.message}>
            {view.asset.retryable && online ? "Retry loading" : view.asset.message}
          </span>
        </span>
      );
    }
    return (
      <span className="article-audio-control">
        <button
          aria-label="Listen to article audio"
          className="reader-toolbar-action article-audio-button-ready"
          onClick={() => void loadReadyAudio(view.summary, true)}
          title="Listen"
          type="button"
        >
          <Volume2 aria-hidden="true" size={17} strokeWidth={1.8} />
        </button>
        <span className="article-audio-label">Listen</span>
      </span>
    );
  }

  if (view.kind === "pending" || view.kind === "checking") {
    const checkingOffline = view.kind === "checking" && !online;
    return (
      <span className="article-audio-control">
        {!checkingOffline ? (
          <button
            aria-busy="true"
            aria-label={view.kind === "pending" ? "Preparing article audio" : "Checking article audio"}
            className="reader-toolbar-action"
            disabled
            type="button"
          >
            <span aria-hidden="true" className="article-audio-spinner" />
          </button>
        ) : null}
        <span className="article-audio-label" role="status">
          {checkingOffline
            ? "Audio status is unavailable offline."
            : view.kind === "pending" ? "Preparing audio…" : "Checking audio…"}
        </span>
      </span>
    );
  }

  if (view.kind === "check-failed") {
    return (
      <span className="article-audio-control">
        {online ? (
          <button
            aria-label="Retry checking article audio"
            className="reader-toolbar-action"
            onClick={() => startStatusWork()}
            title="Retry checking"
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} strokeWidth={1.8} />
          </button>
        ) : null}
        <span className="article-audio-label" role="status">Retry checking</span>
      </span>
    );
  }

  if (view.kind === "generation-failed") {
    return (
      <span className="article-audio-control">
        {view.retryable && online ? (
          <button
            aria-label="Retry generating article audio"
            className="reader-toolbar-action"
            onClick={() => void requestNarration(view.retryMode === "retry")}
            title="Retry generating audio"
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} strokeWidth={1.8} />
          </button>
        ) : null}
        <span className="article-audio-label" role="status" title={view.message}>
          {view.retryable && online ? "Retry generating audio" : view.message}
        </span>
      </span>
    );
  }

  return (
    <span className="article-audio-control">
      {online ? (
        <button
          aria-label="Generate article audio"
          className="reader-toolbar-action"
          onClick={() => void requestNarration(false)}
          title="Generate audio"
          type="button"
        >
          <Volume2 aria-hidden="true" size={17} strokeWidth={1.8} />
        </button>
      ) : null}
      <span className="article-audio-label">
        {online ? "Generate audio" : "Generate audio when online"}
      </span>
    </span>
  );
}
