import { describe, expect, it } from "vitest";
import {
  canonicalizeBookmarkUrl,
  isHackmdRawMarkdownUrl,
  toHackmdMarkdownUrl,
  toReadableBookmarkUrl,
} from "@url-keep/shared";
import { normalizeUrl } from "./utils";

describe("normalizeUrl", () => {
  it("normalizes protocol and host and removes fragments", () => {
    expect(normalizeUrl("HTTPS://Example.com#top")).toBe("https://example.com/");
  });

  it("removes default ports", () => {
    expect(normalizeUrl("https://example.com:443/path")).toBe(
      "https://example.com/path",
    );
  });

  it("preserves query strings", () => {
    expect(normalizeUrl("https://example.com/path?a=1#x")).toBe(
      "https://example.com/path?a=1",
    );
  });

  it("canonicalizes HackMD raw markdown and view URLs to the note URL", () => {
    expect(
      normalizeUrl("https://hackmd.io/@murderteeth/S1A4kz-9bg.md?no-meta"),
    ).toBe("https://hackmd.io/@murderteeth/S1A4kz-9bg");
    expect(
      normalizeUrl("https://hackmd.io/@murderteeth/S1A4kz-9bg?type=view"),
    ).toBe("https://hackmd.io/@murderteeth/S1A4kz-9bg");
  });
});

describe("HackMD URL helpers", () => {
  it("detects and rewrites raw markdown URLs", () => {
    const rawUrl = "https://hackmd.io/@murderteeth/S1A4kz-9bg.md?no-meta";

    expect(isHackmdRawMarkdownUrl(rawUrl)).toBe(true);
    expect(canonicalizeBookmarkUrl(rawUrl)).toBe(
      "https://hackmd.io/@murderteeth/S1A4kz-9bg",
    );
    expect(toReadableBookmarkUrl(rawUrl)).toBe(
      "https://hackmd.io/@murderteeth/S1A4kz-9bg?type=view",
    );
    expect(toHackmdMarkdownUrl(rawUrl)).toBe(
      "https://hackmd.io/@murderteeth/S1A4kz-9bg.md?no-meta",
    );
  });
});
