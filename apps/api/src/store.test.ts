import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory-store";
import { nowIso } from "./utils";
import type { ArticleContentRecord, BookmarkRecord } from "./types";

function bookmark(): BookmarkRecord {
  const now = nowIso();
  return {
    id: "bookmark-1",
    userId: "user-1",
    url: "https://example.com/article",
    normalizedUrl: "https://example.com/article",
    bucket: "reading",
    title: "Article",
    titleSource: "client",
    imageUrl: null,
    siteName: null,
    savedVia: "extension",
    createdAt: now,
    updatedAt: now,
    extractionStatus: null,
  };
}

function article(id: string, source: "client" | "server"): ArticleContentRecord {
  const now = nowIso();
  return {
    id,
    bookmarkId: "bookmark-1",
    userId: "user-1",
    contentHtml: `<p>${source} article content</p>`,
    wordCount: 3,
    author: null,
    publishedDate: null,
    extractionStatus: "complete",
    extractionError: null,
    extractedAt: now,
    contentSource: source,
    createdAt: now,
    updatedAt: now,
  };
}

describe("article write precedence", () => {
  it("allows only one server generation to win a compare-and-swap race", async () => {
    const store = new MemoryStore();
    await store.insertBookmark(bookmark());
    await store.putServerArticleContent(article("pending", "server"), undefined, null);

    const first = await store.putServerArticleContent(
      article("generation-a", "server"),
      undefined,
      "pending",
    );
    const stale = await store.putServerArticleContent(
      article("generation-b", "server"),
      undefined,
      "pending",
    );

    expect(first.written).toBe(true);
    expect(stale.written).toBe(false);
    expect((await store.getArticleContentByBookmarkId("user-1", "bookmark-1"))?.id)
      .toBe("generation-a");
  });

  it("never lets a server result overwrite complete client content", async () => {
    const store = new MemoryStore();
    await store.insertBookmark(bookmark());
    await store.putServerArticleContent(article("pending", "server"), undefined, null);
    await store.putClientArticleContent(article("client", "client"));

    const stale = await store.putServerArticleContent(
      article("server", "server"),
      undefined,
      "pending",
    );

    expect(stale.written).toBe(false);
    expect((await store.getArticleContentByBookmarkId("user-1", "bookmark-1"))?.contentSource)
      .toBe("client");
  });

  it("advances revisions only for offline-visible material changes", async () => {
    const store = new MemoryStore();
    const item = bookmark();
    await store.insertBookmark(item);
    const afterBookmark = await store.getOfflineStatus(item.userId);

    await store.updateBookmark(item);
    expect((await store.getOfflineStatus(item.userId)).syncRevision)
      .toBe(afterBookmark.syncRevision);

    const content = article("client", "client");
    await store.putClientArticleContent(content);
    const afterArticle = await store.getOfflineStatus(item.userId);
    expect(afterArticle.syncRevision).toBeGreaterThan(afterBookmark.syncRevision);

    await store.putClientArticleContent(content);
    expect((await store.getOfflineStatus(item.userId)).syncRevision)
      .toBe(afterArticle.syncRevision);

    await store.enableBookmarkShare(item.userId, item.id, "share", nowIso());
    await store.recordBookmarkShareHit(item.id, nowIso());
    expect((await store.getOfflineStatus(item.userId)).syncRevision)
      .toBe(afterArticle.syncRevision);
  });
});
