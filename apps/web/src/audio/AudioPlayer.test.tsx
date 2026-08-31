// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioPlayer,
  formatPlaybackRate,
  formatPlaybackTime,
} from "./AudioPlayer";

let paused = true;

beforeEach(() => {
  paused = true;
  window.localStorage.clear();
  Object.defineProperty(HTMLMediaElement.prototype, "paused", {
    configurable: true,
    get: () => paused,
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function play(
    this: HTMLMediaElement,
  ) {
    paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function pause(
    this: HTMLMediaElement,
  ) {
    paused = true;
    this.dispatchEvent(new Event("pause"));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AudioPlayer", () => {
  it("formats durations and the shared playback rates compactly", () => {
    expect(formatPlaybackTime(0)).toBe("0:00");
    expect(formatPlaybackTime(65.9)).toBe("1:05");
    expect(formatPlaybackTime(3_665)).toBe("1:01:05");
    expect(formatPlaybackRate(1)).toBe("1×");
    expect(formatPlaybackRate(1.5)).toBe("1.5×");
  });

  it("opens the compact transport and exposes the expected controls", () => {
    render(
      <AudioPlayer
        artist="Example Author"
        audioUrl="blob:example"
        identity="narration-1:sha"
        title="Example Article"
      />,
    );

    const listen = screen.getByRole("button", { name: "Play article audio" });
    expect(listen).toHaveClass("article-audio-button-ready");
    fireEvent.click(listen);

    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("group", { name: "Article audio player" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause article audio" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip back 10 seconds" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skip forward 10 seconds" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Article audio position" })).toBeDisabled();
  });

  it("seeks, persists position, and remembers playback speed", () => {
    const { container } = render(
      <AudioPlayer
        audioUrl="blob:example"
        identity="narration-2:sha"
        title="Example Article"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Play article audio" }));

    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();
    Object.defineProperty(audio, "duration", { configurable: true, value: 120 });
    fireEvent.loadedMetadata(audio!);

    fireEvent.click(screen.getByRole("button", { name: "Skip forward 10 seconds" }));
    expect(audio?.currentTime).toBe(10);
    expect(JSON.parse(
      window.localStorage.getItem("url_keep_audio_position:narration-2:sha") ?? "null",
    )).toEqual({ position: 10 });

    fireEvent.click(screen.getByRole("button", { name: "Playback speed 1×" }));
    fireEvent.click(screen.getByRole("button", { name: "1.5×" }));
    expect(audio?.playbackRate).toBe(1.5);
    expect(window.localStorage.getItem("url_keep_audio_rate")).toBe("1.5");
  });

  it("keeps the loaded player open when initial playback is rejected", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new DOMException("Playback requires interaction", "NotAllowedError"),
    );
    render(
      <AudioPlayer
        audioUrl="blob:example"
        identity="narration-3:sha"
        playOnMount
        title="Example Article"
      />,
    );

    expect(await screen.findByText("Ready—press play.")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Article audio player" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play article audio" })).toBeInTheDocument();
  });
});
