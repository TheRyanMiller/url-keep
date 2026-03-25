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

    const fakeBucket = {
      put: async () => undefined,
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
    expect(result.contentHtml).toContain("/v1/images/articles/bookmark-1/");
    expect(result.wordCount).toBeGreaterThan(20);
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
    expect(result.contentHtml).toContain("<a href=\"https://github.com/louislam/uptime-kuma\">uptime kuma</a>");
    expect(result.contentHtml).not.toContain("[uptime kuma](");
    expect(result.wordCount).toBeGreaterThan(20);

    const updatedBookmark = await store.getBookmarkById(bookmark.userId, bookmark.id);
    expect(updatedBookmark?.title).toBe("Uptime Kuma x Yearn User Guide");
    expect(updatedBookmark?.siteName).toBe("HackMD");
  });
});
