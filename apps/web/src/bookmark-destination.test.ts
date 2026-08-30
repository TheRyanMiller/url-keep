import { describe, expect, it } from "vitest";
import type { Bookmark } from "@url-keep/shared";
import { resolveBookmarkDestination } from "./bookmark-destination";

function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: "bookmark-1",
    url: "https://example.com/article",
    normalized_url: "https://example.com/article",
    bucket: "reading",
    title: "Article",
    title_source: "client",
    image_url: null,
    site_name: null,
    saved_via: "web",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    extraction_status: "complete",
    ...overrides,
  };
}

describe("resolveBookmarkDestination", () => {
  it("routes complete articles to the internal reader in the same app", () => {
    expect(resolveBookmarkDestination(bookmark(), true, false)).toEqual({
      kind: "reader",
      href: "/read/bookmark-1",
    });
  });

  it("only routes offline when the article is actually local", () => {
    expect(resolveBookmarkDestination(bookmark(), false, true).kind).toBe("reader");
    expect(resolveBookmarkDestination(bookmark(), false, false).kind).toBe("unavailable");
  });

  it("opens incomplete and non-reader bookmarks at the source only while online", () => {
    expect(resolveBookmarkDestination(
      bookmark({ extraction_status: "pending" }),
      true,
      false,
    )).toEqual({ kind: "source", href: "https://example.com/article" });
    expect(resolveBookmarkDestination(
      bookmark({
        url: "https://youtu.be/abc",
        normalized_url: "https://youtu.be/abc",
        bucket: "videos",
        extraction_status: null,
      }),
      false,
      false,
    ).kind).toBe("unavailable");
  });
});
