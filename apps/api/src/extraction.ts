import { Readability } from "@mozilla/readability";
import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";
import {
  ARTICLE_AUTHOR_MAX_CHARS,
  ARTICLE_CONTENT_MAX_BYTES,
  ARTICLE_PUBLISHED_DATE_MAX_CHARS,
  ARTICLE_SITE_NAME_MAX_CHARS,
  ARTICLE_TITLE_MAX_CHARS,
  CAPTURE_REQUEST_MAX_BYTES,
  toHackmdMarkdownUrl,
} from "@url-keep/shared";
import { parseHTML } from "linkedom";
import { extractMarkdownTitle, renderMarkdownToHtml } from "./markdown";
import { sanitizeClientHtml } from "./sanitize";
import { makeId, nowIso } from "./utils";
import type { Store } from "./store";
import type {
  ArticleContentRecord,
  Bindings,
  BookmarkRecord,
} from "./types";

const ARTICLE_FETCH_TIMEOUT_MS = 10_000;
const IMAGE_FETCH_TIMEOUT_MS = 5_000;
const ARTICLE_BODY_LIMIT_BYTES = CAPTURE_REQUEST_MAX_BYTES;
const MAX_IMAGES_PER_ARTICLE = 20;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
const MIN_IMAGE_BYTES = 100;
const USER_AGENT = "url-keep/1.0";
const NON_BODY_ROOT_TAGS = new Set([
  "BASE",
  "HEAD",
  "BODY",
  "LINK",
  "META",
  "NOSCRIPT",
  "SCRIPT",
  "STYLE",
  "TITLE",
]);

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

export class ExtractionFailure extends Error {
  readonly reason: string;
  readonly extra: Record<string, unknown>;

  constructor(reason: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ExtractionFailure";
    this.reason = reason;
    this.extra = extra;
  }
}

function cleanOptionalText(
  value: string | null | undefined,
  maxChars = Number.POSITIVE_INFINITY,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxChars) : null;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

export function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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

function shouldMoveTopLevelNodeToBody(node: ChildNode): boolean {
  if (node.nodeType === 1) {
    return !NON_BODY_ROOT_TAGS.has((node as Element).tagName);
  }

  if (node.nodeType === 3) {
    return Boolean(node.textContent?.trim());
  }

  return false;
}

// Some pages parse with content attached directly under <html> instead of <body>.
// Hoist those stray nodes so Readability sees a sane ancestor chain.
function normalizeDocumentForReadability(document: Document): number {
  const html = document.documentElement;
  const body = document.body;
  if (!html || !body) {
    return 0;
  }

  const topLevelNodes = [...html.childNodes];
  let moved = 0;
  for (const node of topLevelNodes) {
    if (!shouldMoveTopLevelNodeToBody(node)) {
      continue;
    }

    body.appendChild(node);
    moved += 1;
  }

  return moved;
}

function parseReadableDocument(html: string): {
  metadata: ExtractionMetadata;
  readable: ReturnType<Readability["parse"]>;
} {
  let document: Document;
  let hoistedNodes = 0;

  try {
    ({ document } = parseHTML(html));
    hoistedNodes = normalizeDocumentForReadability(document);
  } catch {
    throw new ExtractionFailure(
      "parse_error",
      "HTML parse failed",
    );
  }

  const metadata = readExtractionMetadata(document);

  try {
    const readable = new Readability(document).parse();
    return { metadata, readable };
  } catch {
    throw new ExtractionFailure(
      "readability_error",
      "Readability parse failed",
      {
        hoisted_nodes: hoistedNodes,
      },
    );
  }
}

export type ExtractedSnapshot = {
  contentHtml: string;
  textContent: string;
  wordCount: number;
  title: string | null;
  author: string | null;
  publishedDate: string | null;
  siteName: string | null;
};

function validateBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ExtractionFailure("invalid_base_url", "Capture base URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ExtractionFailure("invalid_base_url", "Capture base URL must use HTTP(S)");
  }
  return url;
}

function resolveArticleUrls(html: string, baseUrl: URL): string {
  const { document } = parseHTML("<html><body></body></html>");
  const container = document.createElement("div");
  container.innerHTML = html;

  for (const link of container.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href");
    if (!href) continue;
    try {
      link.setAttribute("href", new URL(href, baseUrl).toString());
    } catch {
      link.removeAttribute("href");
    }
  }

  for (const image of container.querySelectorAll("img[src]")) {
    const src = image.getAttribute("src");
    if (!src) continue;
    try {
      image.setAttribute("src", new URL(src, baseUrl).toString());
    } catch {
      image.removeAttribute("src");
    }
  }

  return container.innerHTML;
}

export function extractReadableSnapshot(input: {
  documentHtml: string;
  baseUrl: string;
}): ExtractedSnapshot {
  const baseUrl = validateBaseUrl(input.baseUrl);
  const { metadata, readable } = parseReadableDocument(input.documentHtml);
  const textContent = cleanOptionalText(readable?.textContent) ?? "";

  if (!readable?.content || textContent.length < 100) {
    throw new ExtractionFailure(
      "no_readable_content",
      "No readable article content was found",
      { text_length: textContent.length },
    );
  }

  const contentHtml = sanitizeClientHtml(
    resolveArticleUrls(readable.content, baseUrl),
  );
  const sanitizedText = stripHtml(contentHtml).trim();
  if (sanitizedText.length < 100) {
    throw new ExtractionFailure(
      "no_readable_content",
      "Sanitized article content was empty",
      { text_length: sanitizedText.length },
    );
  }

  const storedBytes = utf8ByteLength(contentHtml);
  if (storedBytes > ARTICLE_CONTENT_MAX_BYTES) {
    throw new ExtractionFailure(
      "stored_content_too_large",
      "Sanitized article exceeds the storage limit",
      { sanitized_bytes: storedBytes },
    );
  }

  return {
    contentHtml,
    textContent: sanitizedText,
    wordCount: countWords(sanitizedText),
    title: cleanOptionalText(readable.title, ARTICLE_TITLE_MAX_CHARS),
    author: cleanOptionalText(
      readable.byline,
      ARTICLE_AUTHOR_MAX_CHARS,
    ) ?? cleanOptionalText(metadata.author, ARTICLE_AUTHOR_MAX_CHARS),
    publishedDate: cleanOptionalText(
      readable.publishedTime,
      ARTICLE_PUBLISHED_DATE_MAX_CHARS,
    ) ?? cleanOptionalText(
      metadata.publishedDate,
      ARTICLE_PUBLISHED_DATE_MAX_CHARS,
    ),
    siteName: cleanOptionalText(
      readable.siteName,
      ARTICLE_SITE_NAME_MAX_CHARS,
    ) ?? cleanOptionalText(metadata.siteName, ARTICLE_SITE_NAME_MAX_CHARS),
  };
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  const declaredLength = lengthHeader ? Number(lengthHeader) : NaN;
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ExtractionFailure(
      "transport_overflow",
      "Source response exceeded the transport limit",
      { declared_bytes: declaredLength },
    );
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
      throw new ExtractionFailure(
        "transport_overflow",
        "Source response exceeded the transport limit",
        { streamed_bytes: totalBytes },
      );
    }

    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

async function tryExtractHackmdContent(
  bookmark: BookmarkRecord,
  generationId: string,
  fetchImpl: typeof fetch,
  images: R2Bucket | undefined,
): Promise<{
  author: string | null;
  contentHtml: string;
  publishedDate: string | null;
  siteName: string | null;
  title: string | null;
  wordCount: number;
} | null> {
  const rawUrl = toHackmdMarkdownUrl(bookmark.url);
  if (!rawUrl) {
    return null;
  }

  const response = await fetchImpl(rawUrl, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/markdown")) {
    return null;
  }

  const markdown = await readResponseTextWithLimit(response, ARTICLE_BODY_LIMIT_BYTES);
  const renderedHtml = sanitizeClientHtml(renderMarkdownToHtml(markdown));
  const textContent = stripHtml(renderedHtml).trim();

  if (textContent.length < 100) {
    return null;
  }

  if (utf8ByteLength(renderedHtml) > ARTICLE_CONTENT_MAX_BYTES) {
    throw new ExtractionFailure(
      "stored_content_too_large",
      "Sanitized article exceeds the storage limit",
      { sanitized_bytes: utf8ByteLength(renderedHtml) },
    );
  }

  let contentHtml = renderedHtml;
  if (images) {
    const rewrittenContentHtml = await extractAndStoreImages(
      contentHtml,
      bookmark.id,
      generationId,
      bookmark.url,
      images,
      fetchImpl,
    );
    if (rewrittenContentHtml.trim()) {
      contentHtml = rewrittenContentHtml;
    }
  }

  return {
    author: null,
    contentHtml,
    publishedDate: null,
    siteName: "HackMD",
    title: cleanOptionalText(extractMarkdownTitle(markdown), ARTICLE_TITLE_MAX_CHARS),
    wordCount: countWords(textContent),
  };
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
    id: makeId(),
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
  generationId: string,
  status: "failed" | "skipped",
  error: string,
): ArticleContentRecord {
  const now = nowIso();
  return {
    id: generationId,
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
  generationId: string,
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
  const key = `articles/${bookmarkId}/${generationId}/${hash}`;

  await r2.put(key, body, {
    httpMetadata: { contentType },
  });

  return {
    proxiedPath: `/v1/images/articles/${bookmarkId}/${generationId}/${hash}`,
    bytesStored: body.byteLength,
  };
}

async function extractAndStoreImages(
  contentHtml: string,
  bookmarkId: string,
  generationId: string,
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
        generationId,
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

async function cleanupBookmarkImageGeneration(
  bookmarkId: string,
  generationId: string,
  r2: R2Bucket,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const listing = await r2.list({
      prefix: `articles/${bookmarkId}/${generationId}/`,
      cursor,
    });
    const keys = listing.objects.map((object) => object.key);
    if (keys.length > 0) {
      await r2.delete(keys);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

async function cleanupObsoleteBookmarkImages(
  bookmarkId: string,
  currentGenerationId: string,
  r2: R2Bucket,
): Promise<void> {
  let cursor: string | undefined;
  const keepPrefix = `articles/${bookmarkId}/${currentGenerationId}/`;
  do {
    const listing = await r2.list({
      prefix: `articles/${bookmarkId}/`,
      cursor,
    });
    const keys = listing.objects
      .map((object) => object.key)
      .filter((key) => !key.startsWith(keepPrefix));
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

  try {
    await cleanupBookmarkImages(bookmarkId, r2);
  } catch {
    console.warn(JSON.stringify({
      event: "article_images.cleanup",
      outcome: "failed",
      failure_code: "r2_cleanup_failed",
      cleanup_scope: "bookmark",
    }));
  }
}

async function cleanupServerAttemptImages(
  bookmarkId: string,
  generationId: string,
  r2?: R2Bucket,
): Promise<void> {
  if (!r2) return;
  try {
    await cleanupBookmarkImageGeneration(bookmarkId, generationId, r2);
  } catch {
    console.warn(JSON.stringify({
      event: "article_images.cleanup",
      outcome: "failed",
      failure_code: "r2_cleanup_failed",
      cleanup_scope: "attempt",
    }));
  }
}

async function cleanupAfterWinningServerWrite(
  bookmarkId: string,
  generationId: string,
  r2?: R2Bucket,
): Promise<void> {
  if (!r2) return;
  try {
    await cleanupObsoleteBookmarkImages(bookmarkId, generationId, r2);
  } catch {
    console.warn(JSON.stringify({
      event: "article_images.cleanup",
      outcome: "failed",
      failure_code: "r2_cleanup_failed",
      cleanup_scope: "obsolete",
    }));
  }
}

function bookmarkMetadataForSnapshot(
  bookmark: BookmarkRecord,
  snapshot: Pick<ExtractedSnapshot, "title" | "siteName">,
  source: "client" | "server",
  now: string,
): BookmarkRecord | undefined {
  const next = { ...bookmark };
  let changed = false;

  if (snapshot.title) {
    if (source === "client" && bookmark.titleSource !== "user") {
      next.title = snapshot.title;
      next.titleSource = "client";
      changed = next.title !== bookmark.title || next.titleSource !== bookmark.titleSource;
    } else if (source === "server" && bookmark.titleSource === "fallback") {
      next.title = snapshot.title;
      changed = next.title !== bookmark.title;
    }
  }

  if (!bookmark.siteName && snapshot.siteName) {
    next.siteName = snapshot.siteName;
    changed = true;
  }

  if (!changed) return undefined;
  next.updatedAt = now;
  return next;
}

async function currentContentAfterLostWrite(
  options: RunBookmarkExtractionOptions,
  fallback: ArticleContentRecord,
): Promise<ArticleContentRecord> {
  return await options.store.getArticleContentByBookmarkId(
    options.bookmark.userId,
    options.bookmark.id,
  ) ?? fallback;
}

async function persistServerFailure(
  options: RunBookmarkExtractionOptions,
  existing: ArticleContentRecord | null,
  generationId: string,
  status: "failed" | "skipped",
  error: string,
): Promise<ArticleContentRecord> {
  await cleanupServerAttemptImages(
    options.bookmark.id,
    generationId,
    options.env.IMAGES,
  );
  if (existing?.extractionStatus === "complete") {
    return existing;
  }

  const failed = failureArticleContent(
    options.bookmark,
    existing,
    generationId,
    status,
    error,
  );
  const result = await options.store.recordServerArticleFailure(
    failed,
    existing?.id ?? null,
  );
  return result.written
    ? failed
    : currentContentAfterLostWrite(options, existing ?? failed);
}

export async function runCapturedPageExtraction(options: {
  store: Store;
  bookmark: BookmarkRecord;
  documentHtml: string;
  baseUrl: string;
}): Promise<{
  article: ArticleContentRecord;
  replacedServerContent: boolean;
}> {
  const existing = await options.store.getArticleContentByBookmarkId(
    options.bookmark.userId,
    options.bookmark.id,
  );
  const snapshot = extractReadableSnapshot({
    documentHtml: options.documentHtml,
    baseUrl: options.baseUrl,
  });
  const now = nowIso();
  const complete: ArticleContentRecord = {
    id: makeId(),
    bookmarkId: options.bookmark.id,
    userId: options.bookmark.userId,
    contentHtml: snapshot.contentHtml,
    wordCount: snapshot.wordCount,
    author: snapshot.author,
    publishedDate: snapshot.publishedDate,
    extractionStatus: "complete",
    extractionError: null,
    extractedAt: now,
    contentSource: "client",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const bookmark = bookmarkMetadataForSnapshot(
    options.bookmark,
    snapshot,
    "client",
    now,
  );
  const result = await options.store.putClientArticleContent(complete, bookmark);
  return {
    article: complete,
    replacedServerContent: result.replacedServerContent,
  };
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

  const generationId = makeId();

  try {
    let snapshot: ExtractedSnapshot | null = null;
    try {
      const hackmd = await tryExtractHackmdContent(
        options.bookmark,
        generationId,
        fetchImpl,
        options.env.IMAGES,
      );
      if (hackmd) {
        snapshot = {
          ...hackmd,
          textContent: stripHtml(hackmd.contentHtml).trim(),
        };
      }
    } catch {
      snapshot = null;
    }

    if (!snapshot) {
      const response = await fetchImpl(options.bookmark.url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const reason = response.status === 401 || response.status === 403
          ? "access_denied"
          : "fetch_error";
        return persistServerFailure(
          options,
          existing,
          generationId,
          "failed",
          makeExtractionError(reason, { http_status: response.status }),
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("text/html")) {
        return persistServerFailure(
          options,
          existing,
          generationId,
          "skipped",
          makeExtractionError("unsupported_content_type", {
            content_type: contentType,
          }),
        );
      }

      const html = await readResponseTextWithLimit(response, ARTICLE_BODY_LIMIT_BYTES);
      snapshot = extractReadableSnapshot({
        documentHtml: html,
        baseUrl: response.url || options.bookmark.url,
      });
      if (options.env.IMAGES) {
        snapshot.contentHtml = await extractAndStoreImages(
          snapshot.contentHtml,
          options.bookmark.id,
          generationId,
          response.url || options.bookmark.url,
          options.env.IMAGES,
          fetchImpl,
        );
      }
    }

    const now = nowIso();
    const complete: ArticleContentRecord = {
      id: generationId,
      bookmarkId: options.bookmark.id,
      userId: options.bookmark.userId,
      contentHtml: snapshot.contentHtml,
      wordCount: snapshot.wordCount,
      author: snapshot.author,
      publishedDate: snapshot.publishedDate,
      extractionStatus: "complete",
      extractionError: null,
      extractedAt: now,
      contentSource: "server",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const bookmark = bookmarkMetadataForSnapshot(
      options.bookmark,
      snapshot,
      "server",
      now,
    );
    const result = await options.store.putServerArticleContent(
      complete,
      bookmark,
      existing?.id ?? null,
    );
    if (!result.written) {
      await cleanupServerAttemptImages(
        options.bookmark.id,
        generationId,
        options.env.IMAGES,
      );
      return currentContentAfterLostWrite(options, existing ?? complete);
    }

    await cleanupAfterWinningServerWrite(
      options.bookmark.id,
      generationId,
      options.env.IMAGES,
    );
    return complete;
  } catch (error) {
    const reason = error instanceof ExtractionFailure
      ? error.reason
      : error instanceof Error && error.message.includes("timeout")
        ? "timeout"
        : "fetch_error";
    return persistServerFailure(
      options,
      existing,
      generationId,
      "failed",
      makeExtractionError(
        reason,
        error instanceof ExtractionFailure ? error.extra : {},
      ),
    );
  }
}
