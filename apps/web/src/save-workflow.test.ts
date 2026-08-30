import { describe, expect, it, vi } from "vitest";
import type { BookmarkMutationResponse } from "@url-keep/shared";
import { saveBookmarkWithReader } from "./save-workflow";

function response({
  normalizedUrl = "https://example.com/article",
  articleStatus = null,
}: {
  normalizedUrl?: string;
  articleStatus?: "pending" | "complete" | "failed" | "skipped" | null;
} = {}): BookmarkMutationResponse {
  return {
    item: {
      bookmark: {
        id: "bookmark-1",
        url: normalizedUrl,
        normalized_url: normalizedUrl,
        bucket: normalizedUrl.includes("youtu") ? "videos" : "reading",
        title: "Article",
        title_source: "fallback",
        image_url: null,
        site_name: null,
        saved_via: "web",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        extraction_status: articleStatus,
      },
      article: articleStatus
        ? {
            id: "article-1",
            status: articleStatus,
            title: "Article",
            word_count: articleStatus === "complete" ? 100 : 0,
            author: null,
            published_date: null,
            content_source: articleStatus === "complete" ? "server" : null,
            failure_code: articleStatus === "failed" ? "fetch_error" : null,
            updated_at: "2026-01-01T00:00:00.000Z",
          }
        : null,
    },
  };
}

describe("saveBookmarkWithReader", () => {
  it("automatically extracts reader content after a metadata-only web save", async () => {
    const saved = response();
    const extracted = response({ articleStatus: "complete" });
    const client = {
      saveBookmark: vi.fn().mockResolvedValue(saved),
      extractBookmark: vi.fn().mockResolvedValue(extracted),
    };

    await expect(saveBookmarkWithReader(client, {
      url: "https://example.com/article",
      saved_via: "web",
    })).resolves.toBe(extracted);
    expect(client.extractBookmark).toHaveBeenCalledWith("bookmark-1");
  });

  it("retries incomplete reader content but preserves a complete generation", async () => {
    const complete = response({ articleStatus: "complete" });
    const failed = response({ articleStatus: "failed" });
    const client = {
      saveBookmark: vi.fn()
        .mockResolvedValueOnce(complete)
        .mockResolvedValueOnce(failed),
      extractBookmark: vi.fn().mockResolvedValue(response({ articleStatus: "complete" })),
    };

    await expect(saveBookmarkWithReader(client, {
      url: "https://example.com/article",
      saved_via: "mobile_web",
    })).resolves.toBe(complete);
    expect(client.extractBookmark).not.toHaveBeenCalled();

    await saveBookmarkWithReader(client, {
      url: "https://example.com/article",
      saved_via: "mobile_web",
    });
    expect(client.extractBookmark).toHaveBeenCalledTimes(1);
  });

  it("does not extract URL types that use their native destination", async () => {
    const saved = response({ normalizedUrl: "https://youtu.be/example" });
    const client = {
      saveBookmark: vi.fn().mockResolvedValue(saved),
      extractBookmark: vi.fn(),
    };

    await expect(saveBookmarkWithReader(client, {
      url: "https://youtu.be/example",
      saved_via: "web",
    })).resolves.toBe(saved);
    expect(client.extractBookmark).not.toHaveBeenCalled();
  });
});
