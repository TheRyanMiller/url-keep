import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, UrlKeepClient } from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UrlKeepClient request ownership", () => {
  it("uses no-store for private synchronization and content reads", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ bookmark_count: 0, sync_revision: 0 }))
      .mockResolvedValueOnce(Response.json({
        item: {
          bookmark_id: "bookmark-1",
          content_html: null,
          word_count: 0,
          author: null,
          published_date: null,
          extraction_status: "pending",
          extraction_error: null,
          extracted_at: null,
          content_source: null,
        },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new UrlKeepClient({
      baseUrl: "https://api.example.com",
      getToken: () => "token",
    });

    await client.getOfflineStatus();
    await client.getBookmarkContent("bookmark-1");

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ cache: "no-store" });
  });

  it("invalidates auth only for authenticated 401 responses", async () => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { error: { code: "unauthorized", message: "expired" } },
      { status: 401 },
    )));
    const client = new UrlKeepClient({
      baseUrl: "https://api.example.com",
      getToken: () => "token",
      onUnauthorized,
    });

    await expect(client.me()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("retains auth on network and server failures", async () => {
    const onUnauthorized = vi.fn();
    const client = new UrlKeepClient({
      baseUrl: "https://api.example.com",
      getToken: () => "token",
      onUnauthorized,
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline")));
    await expect(client.me()).rejects.toMatchObject({ code: "network_error" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(
      { error: { code: "server_error", message: "failed" } },
      { status: 500 },
    )));
    await expect(client.me()).rejects.toMatchObject({ status: 500 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
