import { Readability } from "@mozilla/readability";
import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";
import { parseHTML } from "linkedom";
import { makeId, nowIso } from "./utils";
import type { Store } from "./store";
import type {
  ArticleContentRecord,
  Bindings,
  BookmarkRecord,
} from "./types";

const ARTICLE_FETCH_TIMEOUT_MS = 10_000;
const IMAGE_FETCH_TIMEOUT_MS = 5_000;
const ARTICLE_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_ARTICLE = 20;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
const MIN_IMAGE_BYTES = 100;
const USER_AGENT = "url-keep/1.0";

type RunBookmarkExtractionOptions = {
  env: Bindings;
  store: Store;
  bookmark: BookmarkRecord;
  force?: boolean;
  fetchImpl?: typeof fetch;
};

type ExtractionMetadata = {
  author: string | null;
  publishedDate: string | null;
  siteName: string | null;
};

function cleanOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function firstMetaContent(document: Document, selectors: string[]): string | null {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const value = cleanOptionalText(element?.getAttribute("content") ?? null);
    if (value) {
      return value;
    }
  }
  return null;
}

function readPublishedDate(document: Document): string | null {
  return (
    firstMetaContent(document, [
      'meta[property="article:published_time"]',
      'meta[name="article:published_time"]',
      'meta[property="og:published_time"]',
      'meta[name="pubdate"]',
      'meta[name="publish-date"]',
      'meta[name="date"]',
    ]) ??
    cleanOptionalText(
      document.querySelector("time[datetime]")?.getAttribute("datetime") ?? null,
    )
  );
}

function readExtractionMetadata(document: Document): ExtractionMetadata {
  return {
    author: firstMetaContent(document, [
      'meta[name="author"]',
      'meta[property="author"]',
      'meta[name="parsely-author"]',
    ]),
    publishedDate: readPublishedDate(document),
    siteName: firstMetaContent(document, [
      'meta[property="og:site_name"]',
      'meta[name="application-name"]',
    ]),
  };
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  const declaredLength = lengthHeader ? Number(lengthHeader) : NaN;
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("response body exceeded 5MB limit");
  }

  if (!response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("response body exceeded 5MB limit");
    }

    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

function makeExtractionError(reason: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ reason, ...extra });
}

export function pendingArticleContent(
  bookmark: BookmarkRecord,
  existing: ArticleContentRecord | null,
): ArticleContentRecord {
  const now = nowIso();
  return {
    id: existing?.id ?? makeId(),
    bookmarkId: bookmark.id,
    userId: bookmark.userId,
    contentHtml: null,
    wordCount: 0,
    author: null,
    publishedDate: null,
    extractionStatus: "pending",
    extractionError: null,
    extractedAt: null,
    contentSource: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function failureArticleContent(
  bookmark: BookmarkRecord,
  existing: ArticleContentRecord | null,
  status: "failed" | "skipped",
  error: string,
): ArticleContentRecord {
  const now = nowIso();
  return {
    id: existing?.id ?? makeId(),
    bookmarkId: bookmark.id,
    userId: bookmark.userId,
    contentHtml: null,
    wordCount: 0,
    author: null,
    publishedDate: null,
    extractionStatus: status,
    extractionError: error,
    extractedAt: now,
    contentSource: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

async function maybeStoreImage(
  src: string,
  bookmarkId: string,
  r2: R2Bucket,
  fetchImpl: typeof fetch,
  totalBytes: number,
): Promise<{ proxiedPath: string | null; bytesStored: number }> {
  if (!src.startsWith("https://")) {
    return { proxiedPath: null, bytesStored: 0 };
  }

  const response = await fetchImpl(src, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    return { proxiedPath: null, bytesStored: 0 };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/") || contentType.includes("svg")) {
    return { proxiedPath: null, bytesStored: 0 };
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (
    Number.isFinite(declaredLength) &&
    (declaredLength > MAX_IMAGE_BYTES || totalBytes + declaredLength > MAX_TOTAL_IMAGE_BYTES)
  ) {
    return { proxiedPath: null, bytesStored: 0 };
  }

  const body = await response.arrayBuffer();
  if (
    body.byteLength > MAX_IMAGE_BYTES ||
    body.byteLength < MIN_IMAGE_BYTES ||
    totalBytes + body.byteLength > MAX_TOTAL_IMAGE_BYTES
  ) {
    return { proxiedPath: null, bytesStored: 0 };
  }

  const hash = await sha256Hex(src);
  const key = `articles/${bookmarkId}/${hash}`;

  await r2.put(key, body, {
    httpMetadata: { contentType },
  });

  return {
    proxiedPath: `/v1/images/articles/${bookmarkId}/${hash}`,
    bytesStored: body.byteLength,
  };
}

async function extractAndStoreImages(
  contentHtml: string,
  bookmarkId: string,
  baseUrl: string,
  r2: R2Bucket,
  fetchImpl: typeof fetch,
): Promise<string> {
  const { document } = parseHTML("<html><body></body></html>");
  const container = document.createElement("div");
  container.innerHTML = contentHtml;
  const images = [...container.querySelectorAll("img[src]")].slice(0, MAX_IMAGES_PER_ARTICLE);
  let totalBytes = 0;

  for (const image of images) {
    const src = image.getAttribute("src");
    if (!src) {
      continue;
    }

    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(src, baseUrl).toString();
    } catch {
      continue;
    }

    try {
      const { proxiedPath, bytesStored } = await maybeStoreImage(
        absoluteUrl,
        bookmarkId,
        r2,
        fetchImpl,
        totalBytes,
      );

      if (proxiedPath) {
        image.setAttribute("src", proxiedPath);
        totalBytes += bytesStored;
      }
    } catch {
      // Leave the original URL in place so images still work while online.
    }
  }

  return container.innerHTML;
}

async function cleanupBookmarkImages(bookmarkId: string, r2: R2Bucket): Promise<void> {
  let cursor: string | undefined;

  do {
    const listing = await r2.list({
      prefix: `articles/${bookmarkId}/`,
      cursor,
    });
    const keys = listing.objects.map((object) => object.key);
    if (keys.length > 0) {
      await r2.delete(keys);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

export async function removeBookmarkImages(
  bookmarkId: string,
  r2?: R2Bucket,
): Promise<void> {
  if (!r2) {
    return;
  }

  await cleanupBookmarkImages(bookmarkId, r2);
}

export async function runBookmarkExtraction(
  options: RunBookmarkExtractionOptions,
): Promise<ArticleContentRecord> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const existing = await options.store.getArticleContentByBookmarkId(
    options.bookmark.userId,
    options.bookmark.id,
  );

  if (existing?.extractionStatus === "complete" && !options.force) {
    return existing;
  }

  // The caller (queueBookmarkExtraction) already wrote a pending row before
  // dispatching via waitUntil(). No need to write pending again here.

  try {
    const response = await fetchImpl(options.bookmark.url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const reason = response.status === 401 || response.status === 403
        ? "access_denied"
        : "fetch_error";
      const failed = failureArticleContent(
        options.bookmark,
        existing,
        "failed",
        makeExtractionError(reason, { http_status: response.status }),
      );
      await options.store.upsertArticleContent(failed);
      return failed;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) {
      const skippedCt = failureArticleContent(
        options.bookmark,
        existing,
        "skipped",
        makeExtractionError("unsupported_content_type", { content_type: contentType }),
      );
      await options.store.upsertArticleContent(skippedCt);
      return skippedCt;
    }

    const html = await readResponseTextWithLimit(response, ARTICLE_BODY_LIMIT_BYTES);
    const { document } = parseHTML(html);
    const metadata = readExtractionMetadata(document);
    const readable = new Readability(document).parse();

    const textLength = cleanOptionalText(readable?.textContent)?.length ?? 0;
    if (!readable?.content || textLength < 100) {
      const skipped = failureArticleContent(
        options.bookmark,
        existing,
        "skipped",
        makeExtractionError("no_readable_content", { text_length: textLength }),
      );
      await options.store.upsertArticleContent(skipped);
      return skipped;
    }

    let contentHtml = readable.content;
    if (options.env.IMAGES) {
      const rewrittenContentHtml = await extractAndStoreImages(
        contentHtml,
        options.bookmark.id,
        response.url || options.bookmark.url,
        options.env.IMAGES,
        fetchImpl,
      );
      if (rewrittenContentHtml.trim()) {
        contentHtml = rewrittenContentHtml;
      }
    }

    const title = cleanOptionalText(readable.title);
    const siteName = cleanOptionalText(readable.siteName) ?? metadata.siteName;
    const author = cleanOptionalText(readable.byline) ?? metadata.author;
    const now = nowIso();

    let bookmarkChanged = false;
    const nextBookmark: BookmarkRecord = {
      ...options.bookmark,
      extractionStatus: "complete",
    };

    if (options.bookmark.titleSource === "fallback" && title) {
      nextBookmark.title = title;
      nextBookmark.titleSource = "client";
      bookmarkChanged = true;
    }

    if (!options.bookmark.siteName && siteName) {
      nextBookmark.siteName = siteName;
      bookmarkChanged = true;
    }

    if (bookmarkChanged) {
      nextBookmark.updatedAt = now;
      await options.store.updateBookmark(nextBookmark);
    }

    const complete: ArticleContentRecord = {
      id: existing?.id ?? makeId(),
      bookmarkId: options.bookmark.id,
      userId: options.bookmark.userId,
      contentHtml,
      wordCount: countWords(readable.textContent ?? ""),
      author,
      publishedDate: metadata.publishedDate,
      extractionStatus: "complete",
      extractionError: null,
      extractedAt: now,
      contentSource: "server",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await options.store.upsertArticleContent(complete);
    return complete;
  } catch (error) {
    const reason = error instanceof Error && error.message.includes("timeout")
      ? "timeout"
      : "fetch_error";
    const failed = failureArticleContent(
      options.bookmark,
      existing,
      "failed",
      makeExtractionError(reason, error instanceof Error ? { message: error.message } : {}),
    );
    await options.store.upsertArticleContent(failed);
    return failed;
  }
}
