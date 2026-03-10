import { describe, expect, it } from "vitest";
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
});
