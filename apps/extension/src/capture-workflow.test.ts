import { describe, expect, it, vi } from "vitest";
import type { UrlKeepClient } from "@url-keep/api-client";
import { runCaptureWorkflow } from "./capture-workflow";

const captured = `<html><body><article>${"captured article ".repeat(10)}</article></body></html>`;

function client(overrides: Record<string, unknown> = {}) {
  return {
    captureBookmark: vi.fn().mockResolvedValue(undefined),
    extractBookmark: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as UrlKeepClient;
}

describe("extension capture workflow", () => {
  it("uploads the bounded live DOM without starting URL extraction", async () => {
    const api = client();
    await expect(runCaptureWorkflow("bookmark-1", null, {
      client: api,
      injectCapture: vi.fn().mockResolvedValue(captured),
    })).resolves.toBe("captured");
    expect(api.captureBookmark).toHaveBeenCalledWith("bookmark-1", captured);
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
      captureBookmark: vi.fn().mockRejectedValue(new Error("network")),
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
