// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { UrlKeepClient } from "@url-keep/api-client";
import { ApiError } from "@url-keep/api-client";
import type { Narration, ReadyNarrationSummary } from "@url-keep/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const audioStorage = vi.hoisted(() => ({
  downloadVerifiedAudio: vi.fn(),
  persistVerifiedAudio: vi.fn(),
  readVerifiedCachedAudio: vi.fn(),
}));

vi.mock("./offline-audio", () => audioStorage);

import { ArticleAudio } from "./ArticleAudio";

const articleId = "00000000-0000-4000-8000-000000000002";
const narrationId = "00000000-0000-4000-8000-000000000001";
const summary: ReadyNarrationSummary = {
  id: narrationId,
  article_id: articleId,
  sha256: "a".repeat(64),
  byte_size: 3,
  duration_ms: 1_000,
};
const readyNarration: Narration = {
  id: narrationId,
  status: "ready",
  retryable: false,
  error_code: null,
  audio: {
    sha256: summary.sha256,
    byte_size: summary.byte_size,
    duration_ms: summary.duration_ms,
  },
};
const pendingNarration: Narration = {
  id: narrationId,
  status: "pending",
  retryable: false,
  error_code: null,
  audio: null,
};

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value,
  });
  window.dispatchEvent(new Event(value ? "online" : "offline"));
}

function makeClient(overrides: Partial<Record<
  "getNarration" | "requestNarration" | "retryNarration",
  ReturnType<typeof vi.fn>
>> = {}) {
  return {
    getNarration: overrides.getNarration ?? vi.fn(),
    requestNarration: overrides.requestNarration ?? vi.fn(),
    retryNarration: overrides.retryNarration ?? vi.fn(),
  } as unknown as UrlKeepClient;
}

function renderAudio(
  client: UrlKeepClient,
  initialNarration: ReadyNarrationSummary | null,
  reveal = false,
) {
  return render(
    <ArticleAudio
      articleId={articleId}
      bookmarkId="bookmark-1"
      client={client}
      initialNarration={initialNarration}
      reveal={reveal}
      title="Example Article"
    />,
  );
}

beforeEach(() => {
  setOnline(true);
  setVisibility("visible");
  audioStorage.downloadVerifiedAudio.mockReset().mockResolvedValue(
    Uint8Array.from([1, 2, 3]).buffer,
  );
  audioStorage.persistVerifiedAudio.mockReset().mockResolvedValue(false);
  audioStorage.readVerifiedCachedAudio.mockReset().mockResolvedValue(null);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:verified-audio"),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ArticleAudio", () => {
  it("uses synced ready metadata and waits for Listen before downloading", async () => {
    const getNarration = vi.fn();
    const client = makeClient({ getNarration });
    const { container } = renderAudio(client, summary);

    expect(screen.getByRole("button", { name: "Listen to article audio" })).toBeInTheDocument();
    expect(getNarration).not.toHaveBeenCalled();
    expect(audioStorage.downloadVerifiedAudio).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Listen to article audio" }));
    await waitFor(() => expect(container.querySelector("audio")).toBeInTheDocument());
    expect(audioStorage.downloadVerifiedAudio).toHaveBeenCalledTimes(1);
  });

  it("keeps a loaded player and its Blob URL across visibility and connectivity changes", async () => {
    const getNarration = vi.fn();
    const client = makeClient({ getNarration });
    const { container } = renderAudio(client, summary);
    fireEvent.click(screen.getByRole("button", { name: "Listen to article audio" }));
    const audio = await waitFor(() => {
      const element = container.querySelector("audio");
      expect(element).toBeInTheDocument();
      return element!;
    });

    act(() => setVisibility("hidden"));
    act(() => setOnline(false));
    act(() => setVisibility("visible"));
    act(() => setOnline(true));

    expect(container.querySelector("audio")).toBe(audio);
    expect(audio.getAttribute("src")).toBe("blob:verified-audio");
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
    expect(getNarration).not.toHaveBeenCalled();
    expect(audioStorage.downloadVerifiedAudio).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("finishes one in-flight audio download while hidden", async () => {
    let finishDownload!: (bytes: ArrayBuffer) => void;
    audioStorage.downloadVerifiedAudio.mockImplementationOnce(
      () => new Promise<ArrayBuffer>((resolve) => {
        finishDownload = resolve;
      }),
    );
    const { container } = renderAudio(makeClient(), summary);
    fireEvent.click(screen.getByRole("button", { name: "Listen to article audio" }));
    expect(screen.getByText("Loading audio…")).toBeInTheDocument();
    await waitFor(() => expect(audioStorage.downloadVerifiedAudio).toHaveBeenCalledTimes(1));

    act(() => setVisibility("hidden"));
    await act(async () => finishDownload(Uint8Array.from([1, 2, 3]).buffer));

    expect(container.querySelector("audio")).toBeInTheDocument();
    expect(audioStorage.downloadVerifiedAudio).toHaveBeenCalledTimes(1);
  });

  it("stops pending status work while hidden and checks once immediately on return", async () => {
    vi.useFakeTimers();
    const getNarration = vi.fn()
      .mockResolvedValueOnce({ item: pendingNarration })
      .mockResolvedValueOnce({ item: readyNarration });
    const client = makeClient({ getNarration });
    renderAudio(client, null);

    await act(async () => Promise.resolve());
    expect(getNarration).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Preparing audio…")).toBeInTheDocument();

    act(() => setVisibility("hidden"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(getNarration).toHaveBeenCalledTimes(1);

    act(() => setVisibility("visible"));
    await act(async () => Promise.resolve());
    expect(getNarration).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Listen to article audio" })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("does not abort a user-initiated generation request when hidden", async () => {
    let finishRequest!: (value: { item: Narration }) => void;
    let requestSignal: AbortSignal | undefined;
    const requestNarration = vi.fn((_id: string, signal?: AbortSignal) => new Promise<{
      item: Narration;
    }>((resolve) => {
      requestSignal = signal;
      finishRequest = resolve;
    }));
    const getNarration = vi.fn().mockRejectedValue(
      new ApiError(404, "not_found", "Narration not found"),
    );
    const client = makeClient({ getNarration, requestNarration });
    renderAudio(client, null);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Generate article audio" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Generate article audio" }));
    act(() => setVisibility("hidden"));
    await act(async () => finishRequest({ item: readyNarration }));

    expect(requestNarration).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);
    expect(screen.getByRole("button", { name: "Listen to article audio" })).toBeInTheDocument();
  });

  it("resubmits submission_required at most once across visibility cycles", async () => {
    const getNarration = vi.fn()
      .mockRejectedValue(new ApiError(409, "submission_required", "Submit again", true));
    const requestNarration = vi.fn().mockResolvedValue({ item: pendingNarration });
    const client = makeClient({ getNarration, requestNarration });
    renderAudio(client, null);

    await waitFor(() => expect(requestNarration).toHaveBeenCalledTimes(1));
    act(() => setVisibility("hidden"));
    act(() => setVisibility("visible"));
    await waitFor(() => expect(screen.getByText("Retry checking")).toBeInTheDocument());
    expect(requestNarration).toHaveBeenCalledTimes(1);
  });

  it("routes audio_missing to generation retry and network failures to loading retry", async () => {
    const client = makeClient();
    audioStorage.downloadVerifiedAudio.mockRejectedValueOnce(
      new ApiError(409, "audio_missing", "Missing audio", true),
    );
    const first = renderAudio(client, summary);
    fireEvent.click(screen.getByRole("button", { name: "Listen to article audio" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry generating article audio" }))
        .toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Retry loading article audio" }))
      .not.toBeInTheDocument();
    first.unmount();

    audioStorage.downloadVerifiedAudio.mockRejectedValueOnce(
      new ApiError(0, "network_error", "Offline"),
    );
    renderAudio(client, summary);
    fireEvent.click(screen.getByRole("button", { name: "Listen to article audio" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry loading article audio" }))
        .toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Retry generating article audio" }))
      .not.toBeInTheDocument();
  });

  it("does not make a network request for an offline cache miss", async () => {
    setOnline(false);
    renderAudio(makeClient(), summary);
    fireEvent.click(screen.getByRole("button", { name: "Listen to article audio" }));

    expect(await screen.findByText("Audio wasn’t saved for offline use.")).toBeInTheDocument();
    expect(audioStorage.downloadVerifiedAudio).not.toHaveBeenCalled();
  });

  it("refreshes narration status once for a stale ready 404", async () => {
    audioStorage.downloadVerifiedAudio.mockRejectedValueOnce(
      new ApiError(404, "not_found", "Narration audio not found"),
    );
    const getNarration = vi.fn().mockResolvedValue({ item: readyNarration });
    renderAudio(makeClient({ getNarration }), summary);
    fireEvent.click(screen.getByRole("button", { name: "Listen to article audio" }));

    await waitFor(() => expect(getNarration).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Listen to article audio" })).toBeInTheDocument();
  });

  it("loads a ready #audio link but never generates an absent narration", async () => {
    const readyClient = makeClient();
    const first = renderAudio(readyClient, summary, true);
    await waitFor(() => expect(audioStorage.downloadVerifiedAudio).toHaveBeenCalledTimes(1));
    first.unmount();

    audioStorage.downloadVerifiedAudio.mockClear();
    const requestNarration = vi.fn();
    const absentClient = makeClient({
      getNarration: vi.fn().mockRejectedValue(
        new ApiError(404, "not_found", "Narration not found"),
      ),
      requestNarration,
    });
    renderAudio(absentClient, null, true);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Generate article audio" })).toBeInTheDocument();
    });
    expect(requestNarration).not.toHaveBeenCalled();
    expect(audioStorage.downloadVerifiedAudio).not.toHaveBeenCalled();
  });
});
