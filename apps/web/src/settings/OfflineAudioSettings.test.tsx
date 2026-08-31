// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OfflineAudioSettings } from "./OfflineAudioSettings";

vi.mock("../audio/offline-audio", () => ({
  clearOfflineAudio: vi.fn(),
  getAudioSettings: vi.fn(async () => ({
    key: "audio",
    enabled: true,
    byte_limit: 500 * 1024 * 1024,
  })),
  getOfflineAudioUsage: vi.fn(async () => ({ bytes: 0, count: 0 })),
  updateAudioSettings: vi.fn(),
}));

describe("offline audio settings", () => {
  it("briefly explains what keeping requested audio means", async () => {
    render(<OfflineAudioSettings />);

    expect(await screen.findByLabelText("keep requested audio on this device"))
      .toBeChecked();
    expect(screen.getByLabelText("About offline audio storage"))
      .toHaveAttribute("aria-describedby", "offline-audio-help");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Requested narration downloads to this device for offline listening and counts toward the storage limit below.",
    );
  });
});
