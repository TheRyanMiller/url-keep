import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { MemoryStore } from "./memory-store";
import {
  extractReadableSnapshot,
  runBookmarkExtraction,
  scopeDocumentToSingleArticle,
} from "./extraction";
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
  it("scopes extraction to one substantial headline article", () => {
    const snapshot = extractReadableSnapshot({
      baseUrl: "https://www.espn.example/story",
      documentHtml: `
        <html>
          <head>
            <title>Roster cuts</title>
            <meta property="og:image" content="/cardinals-video-poster.jpg">
          </head>
          <body>
            <nav>
              <h2>Welcome Ryan!</h2>
              <ul>
                <li>Manage my Account</li>
                <li>Edition: US</li>
                <li>TV Provider</li>
                <li>Settings</li>
                <li>Newsletters</li>
              </ul>
            </nav>
            <section>
              <h2>Favorites</h2>
              <p>${"Arizona Cardinals NFL account navigation. ".repeat(30)}</p>
            </section>
            <article class="ad-300"><p>Advertisement</p></article>
            <aside><p>${"Related news headline and timestamp. ".repeat(30)}</p></aside>
            <article class="article">
              <h1>2026 NFL roster cuts</h1>
              <figure data-video="player"><span>Play video</span></figure>
              <div><img src="/author.jpg" alt="NFL Nation"></div>
              <p>${"The complete roster report begins with the actual article. ".repeat(24)}</p>
              <p>${"Every team update remains part of the readable story. ".repeat(24)}</p>
            </article>
          </body>
        </html>
      `,
    });

    expect(snapshot.contentHtml).toContain("2026 NFL roster cuts");
    expect(snapshot.contentHtml).toContain("Every team update");
    expect(snapshot.imageUrl).toBe("https://www.espn.example/cardinals-video-poster.jpg");
    expect(snapshot.contentHtml).not.toContain("Welcome Ryan");
    expect(snapshot.contentHtml).not.toContain("Arizona Cardinals");
    expect(snapshot.contentHtml).not.toContain("Related news headline");
  });

  it("uses article JSON-LD as the standard lead-image fallback", () => {
    const snapshot = extractReadableSnapshot({
      baseUrl: "https://publisher.example/news/story",
      documentHtml: `
        <html>
          <head>
            <title>Structured article</title>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@graph": [{
                  "@type": "NewsArticle",
                  "image": { "url": "/images/structured-lead.jpg" }
                }]
              }
            </script>
          </head>
          <body><article>
            <h1>Structured article</h1>
            <p>${"A standards-based image fallback works without publisher selectors. ".repeat(20)}</p>
          </article></body>
        </html>
      `,
    });

    expect(snapshot.imageUrl).toBe("https://publisher.example/images/structured-lead.jpg");
  });

  it("falls through invalid Open Graph images to Twitter metadata", () => {
    const snapshot = extractReadableSnapshot({
      baseUrl: "https://publisher.example/story",
      documentHtml: `
        <html>
          <head>
            <title>Metadata fallback</title>
            <meta property="og:image" content="http://insecure.example/lead.jpg">
            <meta name="twitter:image" content="/images/twitter-lead.jpg">
          </head>
          <body><article>
            <h1>Metadata fallback</h1>
            <p>${"The extractor selects the first valid secure standard image. ".repeat(20)}</p>
          </article></body>
        </html>
      `,
    });

    expect(snapshot.imageUrl).toBe("https://publisher.example/images/twitter-lead.jpg");
  });

  it("keeps the full document when substantial headline articles are ambiguous", () => {
    const { document } = parseHTML(`
      <html><body>
        <article><h1>First story</h1><p>${"First article text. ".repeat(40)}</p></article>
        <article><h1>Second story</h1><p>${"Second article text. ".repeat(40)}</p></article>
      </body></html>
    `);

    expect(scopeDocumentToSingleArticle(document)).toBe(false);
    expect(document.body.textContent).toContain("First story");
    expect(document.body.textContent).toContain("Second story");
  });

  it("preserves sanitized HTTPS images without fetching or mirroring them", async () => {
    const store = new MemoryStore();
    const bookmark = {
      ...makeBookmark(),
      imageUrl: "https://cdn.example.com/stale-client-image.jpg",
    };
    await store.insertBookmark(bookmark);

    const fetchedUrls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchedUrls.push(url);

      if (url === bookmark.url) {
        return new Response(
          `
            <html>
              <head>
                <title>Politico Example</title>
                <meta name="author" content="Alec Hernandez" />
                <meta property="og:image" content="/lead.jpg" />
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
    expect(result.contentHtml).toContain("Trump-endorsed Republican advances");
    expect(result.contentHtml).toContain('src="https://cdn.example.com/image.jpg"');
    expect(fetchedUrls).toEqual([bookmark.url]);
    expect(result.wordCount).toBeGreaterThan(20);
    expect((await store.getBookmarkById(bookmark.userId, bookmark.id))?.imageUrl)
      .toBe("https://example.com/lead.jpg");
  });

  it("returns an existing complete generation without fetching unless forced", async () => {
    const store = new MemoryStore();
    const bookmark = makeBookmark();
    await store.insertBookmark(bookmark);
    const now = nowIso();
    await store.putServerArticleContent({
      id: "server-generation",
      bookmarkId: bookmark.id,
      userId: bookmark.userId,
      title: bookmark.title,
      contentHtml: `<p>${"existing complete article ".repeat(8)}</p>`,
      wordCount: 24,
      author: null,
      publishedDate: null,
      extractionStatus: "complete",
      extractionError: null,
      extractedAt: now,
      contentSource: "server",
      createdAt: now,
      updatedAt: now,
    }, undefined, null);
    let fetches = 0;

    const result = await runBookmarkExtraction({
      env: { DB: {} as D1Database } satisfies Bindings,
      store,
      bookmark,
      fetchImpl: async () => {
        fetches += 1;
        return new Response("unexpected");
      },
    });

    expect(result.id).toBe("server-generation");
    expect(fetches).toBe(0);
  });

  it("uses one global budget of four manual fetches including HackMD fallback", async () => {
    const store = new MemoryStore();
    const bookmark = {
      ...makeBookmark(),
      url: "https://hackmd.io/@team/note",
      normalizedUrl: "https://hackmd.io/@team/note",
    };
    await store.insertBookmark(bookmark);
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];

    const result = await runBookmarkExtraction({
      env: { DB: {} as D1Database } satisfies Bindings,
      store,
      bookmark,
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, redirect: init?.redirect });
        if (url.endsWith(".md?no-meta")) return new Response("missing", { status: 404 });
        if (url === bookmark.url) {
          return new Response(null, { status: 302, headers: { Location: "/step-1" } });
        }
        if (url.endsWith("/step-1")) {
          return new Response(null, { status: 302, headers: { Location: "/step-2" } });
        }
        return new Response(`
          <html><head><title>Budgeted article</title></head><body><article>
            <p>${"A readable paragraph stays within the bounded extraction fetch budget. ".repeat(12)}</p>
          </article></body></html>
        `, { headers: { "Content-Type": "text/html" } });
      },
    });

    expect(result.extractionStatus).toBe("complete");
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
  });

  it("refuses to follow more than two redirects", async () => {
    const store = new MemoryStore();
    const bookmark = makeBookmark();
    await store.insertBookmark(bookmark);
    const calls: string[] = [];

    const result = await runBookmarkExtraction({
      env: { DB: {} as D1Database } satisfies Bindings,
      store,
      bookmark,
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: { Location: `/redirect-${calls.length}` },
        });
      },
    });

    expect(calls).toHaveLength(3);
    expect(result.extractionStatus).toBe("failed");
    expect(result.extractionError).toContain('"reason":"fetch_error"');
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
