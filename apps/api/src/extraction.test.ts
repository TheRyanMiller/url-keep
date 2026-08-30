import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory-store";
import { runBookmarkExtraction } from "./extraction";
import { nowIso } from "./utils";
import type { Bindings, BookmarkRecord } from "./types";

function makeBookmark(): BookmarkRecord {
  const now = nowIso();
  return {
    id: "bookmark-1",
    userId: "user-1",
    url: "https://example.com/article",
    normalizedUrl: "https://example.com/article",
    bucket: "reading",
    title: "example.com",
    titleSource: "fallback",
    imageUrl: null,
    siteName: null,
    savedVia: "web",
    createdAt: now,
    updatedAt: now,
    extractionStatus: null,
  };
}

describe("runBookmarkExtraction", () => {
  it("preserves readable html when image rewriting is enabled", async () => {
    const store = new MemoryStore();
    const bookmark = makeBookmark();
    await store.insertBookmark(bookmark);

    const storedKeys: string[] = [];
    const fakeBucket = {
      put: async (key: string) => {
        storedKeys.push(key);
      },
      list: async () => ({ objects: [], truncated: false }),
    } as unknown as R2Bucket;

    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === bookmark.url) {
        return new Response(
          `
            <html>
              <head>
                <title>Politico Example</title>
                <meta name="author" content="Alec Hernandez" />
              </head>
              <body>
                <main>
                  <article>
                    <p>
                      Trump-endorsed Republican advances to runoff in Georgia special election for
                      MTG's seat. This paragraph is intentionally long enough to be considered
                      readable article content by Readability.
                    </p>
                    <p>
                      A second paragraph keeps the sample above the short-content threshold and
                      verifies that content is not lost during the image rewrite pass.
                    </p>
                    <img src="https://cdn.example.com/image.jpg" alt="Example image" />
                  </article>
                </main>
              </body>
            </html>
          `,
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
            },
          },
        );
      }

      if (url === "https://cdn.example.com/image.jpg") {
        return new Response(new Uint8Array(256), {
          headers: {
            "Content-Type": "image/jpeg",
            "Content-Length": "256",
          },
        });
      }

      return new Response("not found", { status: 404 });
    };

    const result = await runBookmarkExtraction({
      env: {
        DB: {} as D1Database,
        IMAGES: fakeBucket,
      } satisfies Bindings,
      store,
      bookmark,
      fetchImpl,
    });

    expect(result.extractionStatus).toBe("complete");
    expect(result.contentHtml).toContain("Trump-endorsed Republican advances");
    expect(result.contentHtml).toContain("/images/articles/bookmark-1/");
    expect(storedKeys[0]?.split("/")).toHaveLength(4);
    expect(result.wordCount).toBeGreaterThan(20);
  });

  it("preserves complete content when a forced server recapture fails", async () => {
    const store = new MemoryStore();
    const bookmark = makeBookmark();
    await store.insertBookmark(bookmark);
    const now = nowIso();
    await store.putClientArticleContent({
      id: "client-generation",
      bookmarkId: bookmark.id,
      userId: bookmark.userId,
      title: bookmark.title,
      contentHtml: `<p>${"private captured article ".repeat(8)}</p>`,
      wordCount: 24,
      author: null,
      publishedDate: null,
      extractionStatus: "complete",
      extractionError: null,
      extractedAt: now,
      contentSource: "client",
      createdAt: now,
      updatedAt: now,
    });

    const result = await runBookmarkExtraction({
      env: { DB: {} as D1Database } satisfies Bindings,
      store,
      bookmark,
      force: true,
      fetchImpl: async () => new Response("blocked", { status: 403 }),
    });

    expect(result.id).toBe("client-generation");
    expect(result.extractionStatus).toBe("complete");
    expect(result.contentSource).toBe("client");
  });

  it("renders HackMD markdown as HTML instead of saving raw markdown markup", async () => {
    const store = new MemoryStore();
    const bookmark = {
      ...makeBookmark(),
      url: "https://hackmd.io/@murderteeth/S1A4kz-9bg",
      normalizedUrl: "https://hackmd.io/@murderteeth/S1A4kz-9bg",
      title: "hackmd.io",
    };
    await store.insertBookmark(bookmark);

    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "https://hackmd.io/@murderteeth/S1A4kz-9bg.md?no-meta") {
        return new Response(
          `
# Uptime Kuma x Yearn User Guide
we recently setup an [uptime kuma](https://github.com/louislam/uptime-kuma) server for monitoring the services, infra, and bots yearn depends on.

### monitors
- http
- push

this second paragraph makes the sample comfortably longer than the readability threshold so the rendered html is preserved.
          `.trim(),
          {
            headers: {
              "Content-Type": "text/markdown; charset=utf-8",
            },
          },
        );
      }

      return new Response("not found", { status: 404 });
    };

    const result = await runBookmarkExtraction({
      env: {
        DB: {} as D1Database,
      } satisfies Bindings,
      store,
      bookmark,
      fetchImpl,
    });

    expect(result.extractionStatus).toBe("complete");
    expect(result.contentHtml).toContain("<h1>Uptime Kuma x Yearn User Guide</h1>");
    expect(result.contentHtml).toContain(
      "<a href=\"https://github.com/louislam/uptime-kuma\" target=\"_blank\" rel=\"noopener noreferrer\">uptime kuma</a>",
    );
    expect(result.contentHtml).not.toContain("[uptime kuma](");
    expect(result.wordCount).toBeGreaterThan(20);

    const updatedBookmark = await store.getBookmarkById(bookmark.userId, bookmark.id);
    expect(updatedBookmark?.title).toBe("Uptime Kuma x Yearn User Guide");
    expect(updatedBookmark?.titleSource).toBe("fallback");
    expect(updatedBookmark?.siteName).toBe("HackMD");
  });

  it("normalizes malformed html roots before running readability", async () => {
    const store = new MemoryStore();
    const bookmark = {
      ...makeBookmark(),
      url: "https://vitalik.eth.limo/general/2026/04/02/secure_llms.html",
      normalizedUrl: "https://vitalik.eth.limo/general/2026/04/02/secure_llms.html",
    };
    await store.insertBookmark(bookmark);

    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === bookmark.url) {
        return new Response(
          `
            <!DOCTYPE html>
            <html>
              <head>
                <title>Secure LLM Setup</title>
              </head>
              <body></body>
              <div id="doc" class="markdown-body">
                <article>
                  <h1>Secure LLM Setup</h1>
                  <p>
                    This first paragraph is intentionally long enough to look like article text
                    instead of chrome or navigation. It should survive malformed html roots and
                    still be extracted cleanly by the server reader.
                  </p>
                  <p>
                    A second paragraph keeps the sample above the readability threshold and proves
                    we recover content even when the parser places the article outside body.
                  </p>
                </article>
              </div>
            </html>
          `,
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
            },
          },
        );
      }

      return new Response("not found", { status: 404 });
    };

    const result = await runBookmarkExtraction({
      env: {
        DB: {} as D1Database,
      } satisfies Bindings,
      store,
      bookmark,
      fetchImpl,
    });

    expect(result.extractionStatus).toBe("complete");
    expect(result.extractionError).toBeNull();
    expect(result.contentHtml).toContain("This first paragraph is intentionally long enough");
    expect(result.wordCount).toBeGreaterThan(20);

    const updatedBookmark = await store.getBookmarkById(bookmark.userId, bookmark.id);
    expect(updatedBookmark?.title).toBe("Secure LLM Setup");
    expect(updatedBookmark?.titleSource).toBe("fallback");
  });
});
