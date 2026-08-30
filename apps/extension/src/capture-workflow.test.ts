import { describe, expect, it, vi } from "vitest";
import type { UrlKeepClient } from "@url-keep/api-client";
import { runCaptureWorkflow } from "./capture-workflow";

const captured = {
  content_html: `<p>${"captured article ".repeat(10)}</p>`,
  title: "Captured",
  author: null,
  published_date: null,
  site_name: "Example",
};

function client(overrides: Record<string, unknown> = {}) {
  return {
    uploadBookmarkContent: vi.fn().mockResolvedValue(undefined),
    extractBookmark: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as UrlKeepClient;
}

describe("extension capture workflow", () => {
  it("uploads Readability output without starting server extraction", async () => {
    const api = client();
    await expect(runCaptureWorkflow("bookmark-1", null, {
      client: api,
      injectCapture: vi.fn().mockResolvedValue(captured),
    })).resolves.toBe("uploaded");
    expect(api.uploadBookmarkContent).toHaveBeenCalledWith("bookmark-1", captured);
    expect(api.extractBookmark).not.toHaveBeenCalled();
  });

  it("falls back exactly once when capture is unavailable", async () => {
    const api = client();
    await expect(runCaptureWorkflow("bookmark-1", null, {
      client: api,
      injectCapture: vi.fn().mockResolvedValue(null),
    })).resolves.toBe("fallback");
    expect(api.extractBookmark).toHaveBeenCalledTimes(1);
  });

  it("preserves existing complete client content after an upload failure", async () => {
    const api = client({
      uploadBookmarkContent: vi.fn().mockRejectedValue(new Error("network")),
    });
    await expect(runCaptureWorkflow("bookmark-1", {
      id: "00000000-0000-4000-8000-000000000001",
      status: "complete",
      failure_code: null,
      title: "Existing",
      word_count: 10,
      author: null,
      published_date: null,
      content_source: "client",
      updated_at: "2026-08-30T00:00:00.000Z",
    }, {
      client: api,
      injectCapture: vi.fn().mockResolvedValue(captured),
    })).resolves.toBe("preserved");
    expect(api.extractBookmark).not.toHaveBeenCalled();
  });
});
