import { describe, expect, it, vi } from "vitest";
import { detectStandaloneMode, shareLink } from "./pwa";

describe("standalone PWA behavior", () => {
  it("detects both iOS and standards-based standalone display modes", () => {
    expect(detectStandaloneMode(true, false)).toBe(true);
    expect(detectStandaloneMode(false, true)).toBe(true);
    expect(detectStandaloneMode(undefined, false)).toBe(false);
  });

  it("uses native share without copying and falls back to the clipboard", async () => {
    const nativeShare = vi.fn().mockResolvedValue(undefined);
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(shareLink({ url: "https://example.com" }, nativeShare, copy))
      .resolves.toBe("shared");
    expect(copy).not.toHaveBeenCalled();

    nativeShare.mockRejectedValueOnce(new Error("share unavailable"));
    await expect(shareLink({ url: "https://example.com" }, nativeShare, copy))
      .resolves.toBe("copied");
    expect(copy).toHaveBeenCalledWith("https://example.com");
  });

  it("silently treats native share cancellation as an abort", async () => {
    const abort = new DOMException("cancelled", "AbortError");
    const copy = vi.fn();
    await expect(shareLink(
      { url: "https://example.com" },
      vi.fn().mockRejectedValue(abort),
      copy,
    )).resolves.toBe("aborted");
    expect(copy).not.toHaveBeenCalled();
  });
});
