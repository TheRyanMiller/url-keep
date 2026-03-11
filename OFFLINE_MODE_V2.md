# Offline Reading Mode v2

## 1. Overview

Save a URL from anywhere (extension, web, iOS Shortcut), extract the article content, and read it later without a network connection.

This plan supersedes `OFFLINE_MODE.md` and incorporates the hybrid capture model from `TRADEOFFS.md`. The key change: the browser extension captures article content from the live DOM when possible, and server-side extraction serves as the fallback for all other save paths.

### What changed from v1

| v1 (OFFLINE_MODE.md) | v2 (this document) |
|---|---|
| Server-only extraction for all save paths | Hybrid: extension captures from live DOM, server as fallback |
| Free-text `extraction_error` | Structured error with HTTP status and reason |
| No content provenance | `content_source` column tracks origin of content |
| Security addressed in a late section | Security is a prerequisite, addressed before implementation |
| Client-side extraction explicitly rejected | Client-side extraction is the primary path for extension saves |
| No extension service worker | MV3 service worker handles capture/upload durably |
| Server extraction queued for all saves | Server extraction skipped for extension saves; explicit fallback on failure |
| Readability as server sanitizer | `sanitize-html` with explicit allowlist as security boundary |

### What stayed the same

- D1 for article content, R2 for images
- Readability.js for content extraction (extension client-side + server-side)
- DOMPurify for sanitization on render (defense in depth)
- IndexedDB + full-snapshot sync for offline storage
- Read-only offline mode (no mutation queue)
- Four extraction states: `pending`, `complete`, `failed`, `skipped`

## 2. Security Model

This section comes first because the hybrid approach accepts HTML from a browser extension, which is untrusted input. Security is a prerequisite, not a polish step.

### 2.1 Threat: stored XSS via client-submitted HTML

When the extension captures article content from a page, it sends HTML to the API. A malicious or compromised page could craft HTML that, when rendered later in the reader view, executes JavaScript in the user's session.

**Mitigation: sanitize twice.**

1. **Server-side on ingest.** When the API receives client-captured HTML via `PUT /v1/bookmarks/:id/content`, sanitize it before storing in D1 using `sanitize-html` with an explicit tag/attribute allowlist (see section 2.2). Strip all script tags, event handlers, data URIs, and non-whitelisted attributes. This ensures the stored content is clean regardless of what the client sent.

2. **Client-side on render.** When the reader view displays `content_html`, run it through DOMPurify with an explicit allowlist (same as v1 section 8.4). This is the last line of defense.

Server-side sanitization is the critical gate. Client-side sanitization is defense in depth.

### 2.2 Server-side sanitization implementation

Use `sanitize-html` with an explicit allowlist that mirrors the client-side DOMPurify config. This is a proper security boundary — a purpose-built sanitizer with allowlist semantics, not a content extraction heuristic.

**Why not Readability?** Readability is a content extractor, not a sanitizer. It uses heuristics to find "the article" in a page, but it does not make security guarantees about what it strips. A page could craft content that Readability considers article-worthy while still containing dangerous attributes or tag combinations. The ingest boundary needs a tool designed for sanitization.

```typescript
import sanitizeHtml from "sanitize-html";

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'a', 'img',
    'blockquote', 'pre', 'code',
    'em', 'strong', 'b', 'i', 'br', 'hr',
    'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'sup', 'sub', 'del',
    'div', 'span',  // structural containers Readability may produce
  ],
  allowedAttributes: {
    'a': ['href', 'title'],
    'img': ['src', 'alt', 'title'],
  },
  allowedSchemes: ['http', 'https'],
  // Strip everything not on the allowlist — don't just escape it
  disallowedTagsMode: 'discard',
};

function sanitizeClientHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}
```

This allowlist is the single source of truth for what HTML is considered safe at the storage layer. The client-side DOMPurify config (section 2.6) should be kept in sync with it as defense in depth, but the server gate is what prevents malicious content from ever reaching D1.

`sanitize-html` is pure JS (~30KB, uses `htmlparser2`), runs in Cloudflare Workers, and is widely deployed for exactly this use case.

### 2.3 Threat: oversized payloads from client

The extension could send arbitrarily large HTML.

**Mitigation:** Enforce a 5MB body limit on the content upload endpoint (same as the existing server fetch limit). Reject with `413 Payload Too Large`.

### 2.4 Threat: content spoofing

A user could submit fabricated content for a URL they didn't visit. In a single-user personal tool, this is a non-issue — the user is only deceiving themselves. No mitigation needed.

### 2.5 Image proxy security

Unchanged from v1. The `/v1/images/` endpoint is unauthenticated. R2 keys contain UUIDs and SHA-256 hashes (unguessable). Images are from public web pages. SVGs are excluded to avoid XSS vectors.

### 2.6 Rendering sanitization (client-side)

Unchanged from v1. All `content_html` rendered in the reader view goes through DOMPurify with an explicit tag and attribute allowlist. No raw HTML is ever rendered without sanitization.

```typescript
const ALLOWED_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'a', 'img',
  'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'br', 'hr',
  'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'sup', 'sub', 'del',
  'div', 'span',  // structural containers from Readability output — must match server allowlist
];

const ALLOWED_ATTR = ['href', 'src', 'alt', 'title'];
```

Both allowlists (server `sanitize-html` in section 2.2, client DOMPurify here) must stay in sync. `div` and `span` are included because Readability uses them as structural wrappers. They're harmless with no attributes allowed.

## 3. Architecture

```
Extension save                          Web/Shortcut save
─────────────                           ─────────────────
1. Popup: save bookmark (metadata)      1. Save bookmark (metadata)
2. Popup → service worker: {tabId, id}  2. Server extraction via waitUntil()
3. Service worker: inject capture.js
4. Service worker: upload content
5. Or on failure: trigger server extract
         │                                      │
         ▼                                      ▼
   ┌──────────────┐                    ┌──────────────┐
   │ article_     │                    │ article_     │
   │ content (D1) │                    │ content (D1) │
   │ source:      │                    │ source:      │
   │ client       │                    │ server       │
   └──────┬───────┘                    └──────┬───────┘
          │                                   │
          └──────────┬────────────────────────┘
                     ▼
              ┌──────────────┐
              │ Reader view  │
              │ (DOMPurify)  │
              └──────────────┘
```

### Decision rules

1. Extension save: popup saves metadata, hands off to service worker for DOM capture + upload. Server does NOT queue extraction for extension saves.
2. Extension capture fails: service worker explicitly calls `POST /v1/bookmarks/:id/extract` to trigger server fallback.
3. Web paste / iOS Shortcut save: server extraction via `waitUntil()` (immediate, no delay).
4. Manual re-extract (`?force=true`): runs server extraction. If `content_source = 'client'`, refuses to overwrite — returns `409 Conflict` with `{"error": {"code": "client_content_exists", "message": "client-captured content exists. delete it first to re-extract from server."}}`. The user must explicitly `DELETE /v1/bookmarks/:id/content` first if they want to replace client content with a server fetch.

## 4. Database Changes

### 4.1 Migration: add `content_source` to `article_content`

```sql
-- 0003_content_source.sql
ALTER TABLE article_content ADD COLUMN content_source TEXT DEFAULT NULL
  CHECK (content_source IN ('client', 'server'));
```

Two values:
- `client` — captured by the extension from the live DOM
- `server` — fetched and extracted by the Worker

Null for legacy rows (pre-migration content).

### 4.2 Structured extraction errors

Replace free-text `extraction_error` with structured JSON. No schema change needed — the column is already `TEXT`. Store JSON instead of a plain string:

```json
{"http_status": 403, "reason": "access_denied"}
{"reason": "timeout"}
{"reason": "no_readable_content", "text_length": 42}
{"reason": "unsupported_content_type", "content_type": "application/pdf"}
```

The UI interprets these for display. A 401/403 says "site blocked server access" instead of a generic "FAILED". A timeout says "site took too long to respond." This is more useful than adding a `blocked` status to the state machine.

Keep the four existing extraction states: `pending`, `complete`, `failed`, `skipped`. No new states.

## 5. API Changes

### 5.1 New endpoint: upload client-captured content

```
PUT /v1/bookmarks/:id/content
```

Request body:

```json
{
  "content_html": "<article>...</article>",
  "title": "Article Title",
  "author": "Jane Doe",
  "published_date": "2026-01-15",
  "site_name": "Example News"
}
```

All fields except `content_html` are optional. The extension sends them explicitly rather than relying on server-side re-parsing to recover metadata.

Behavior:

1. Auth required. 404 if bookmark doesn't exist or doesn't belong to the user.
2. Reject if body exceeds 5MB (`413`).
3. Sanitize `content_html` with `sanitize-html` using the server allowlist (see section 2.2). This is the security boundary.
4. If sanitized output is empty or < 100 chars after stripping tags, return `422` with `{"error": {"code": "no_content", "message": "submitted HTML contained no readable content"}}`.
5. Count words from the sanitized text content. Upsert into `article_content` with `content_source = 'client'`, `extraction_status = 'complete'`. If content already exists for this bookmark (e.g., re-save from extension), overwrite it.
6. Update bookmark `title` if current `title_source = 'fallback'` and `title` was provided in the request.
7. Update bookmark `site_name` if null and `site_name` was provided in the request.
8. Return `200` with the stored article content.

This endpoint does not download images. Client-captured content keeps original image URLs. Images work online; they won't work offline for paywalled content. This is an acceptable tradeoff — the text is the high-value content.

### 5.2 Server extraction is not queued for extension saves

The race between client capture and server extraction is resolved by not racing at all. The decision is made at save time based on `saved_via`:

- **`saved_via = 'extension'`**: Do NOT queue server extraction in `waitUntil()`. The extension service worker owns the capture lifecycle. If capture fails, the service worker explicitly calls `POST /v1/bookmarks/:id/extract` as fallback.
- **All other `saved_via` values** (`web`, `mobile_web`, `ios_shortcut`): Queue server extraction immediately via `waitUntil()`, same as current behavior.

```typescript
// In POST /v1/bookmarks handler
if (body.saved_via !== "extension") {
  ctx.waitUntil(runBookmarkExtraction({ env, store, bookmark }));
}
// Extension saves: no server extraction queued. The extension handles it.
```

This eliminates the timing problem entirely. No delays, no polling, no race conditions. The arbitration is in the save path, not the extraction path.

### 5.3 Structured error in server extraction

Update `extraction.ts` to store structured errors:

```typescript
// Instead of:
throw new Error(`fetch failed with status ${response.status}`);

// Store:
const error = JSON.stringify({
  http_status: response.status,
  reason: response.status === 403 || response.status === 401
    ? "access_denied"
    : "fetch_error"
});
```

### 5.4 Existing endpoints unchanged

All other endpoints from v1 remain the same:
- `POST /v1/bookmarks/:id/extract` — trigger/retry server extraction. If `content_source = 'client'` and `extraction_status = 'complete'`, returns `409 Conflict` unless the user deletes the content first (see decision rule 4 in section 3).
- `GET /v1/bookmarks/:id/content` — get article content (now includes `content_source` in response)
- `DELETE /v1/bookmarks/:id/content` — delete content and images (works regardless of content source)
- `GET /v1/offline/bundle` — batch sync (includes `content_source`)
- `GET /v1/images/articles/:bookmarkId/:hash` — serve R2 images

## 6. Extension Content Capture

### 6.1 Design principle: capture must be durable

Client capture is the primary content path for extension saves. It is not best-effort. For paywalled and authenticated content, the extension is the only path that works. If capture fails silently, that content is lost — the server fallback will also fail on those pages.

This means capture cannot depend on the popup staying open. The popup can close at any time (user taps away, auto-close timer, browser kills it). Capture and upload must run on a durable execution surface: the extension's MV3 service worker.

### 6.2 Lifecycle: popup hands off to service worker

```
User clicks "save" in popup
  │
  ├─ Popup (fast, user-facing):
  │   1. POST /v1/bookmarks { url, title, ..., saved_via: "extension" }
  │   2. Receive bookmark ID from response
  │   3. Send message to service worker: { action: "capture", tabId, bookmarkId }
  │   4. Show "saved" confirmation. Popup can close at any time after this.
  │
  └─ Service worker (durable, background):
      1. Receive message from popup
      2. Inject capture.js into tab via chrome.scripting.executeScript
      3. Receive captured content from injected script
      4. PUT /v1/bookmarks/:id/content { content_html, title, author, ... }
      5. On success: done. Content is in D1.
      6. On failure: POST /v1/bookmarks/:id/extract (trigger server fallback)
```

The popup's only job after save is to hand off the `tabId` and `bookmarkId` to the service worker. The service worker runs independently. MV3 service workers stay alive for up to 5 minutes of active work — more than enough time for DOM capture (~100ms) plus an API upload (~1-2 seconds).

### 6.3 Injecting Readability via a bundled file

`chrome.scripting.executeScript({ func })` serializes the function and strips its closure scope. It cannot reference imported modules like Readability. Use the `files` form instead:

```typescript
// In the service worker
const [result] = await chrome.scripting.executeScript({
  target: { tabId },
  files: ["capture.js"],
});
```

`capture.js` is a self-contained bundle built at extension compile time that includes:
- `@mozilla/readability` (inlined)
- The capture logic (clone DOM, run Readability, resolve URLs)
- An IIFE wrapper that returns the result (required — `executeScript({ files })` uses the file's last evaluated expression as the return value)

```javascript
// capture.js structure (after esbuild bundles Readability inline)
(() => {
  // ... Readability library code (inlined by esbuild) ...
  // ... capture logic ...
  return { content_html, title, author, published_date, site_name };
})();
```

The build step (in `build.mjs`) uses esbuild to bundle Readability + capture logic into a single IIFE in `dist/capture.js`.

### 6.4 What capture.js does

```
1. Clone the document: document.cloneNode(true)
   — Avoids mutating the live page.

2. Run Readability on the clone: new Readability(clone).parse()
   — Returns { content, title, byline, siteName, publishedTime, ... }

3. Resolve relative URLs in the output HTML against document.baseURI
   — Images: <img src="/path"> → <img src="https://example.com/path">
   — Links: <a href="/page"> → <a href="https://example.com/page">

4. Return the result object:
   {
     content_html: string,
     title: string | null,
     author: string | null,
     published_date: string | null,
     site_name: string | null,
   }
```

URL resolution (runs inside the page context, so `DOMParser` is available):

```typescript
function resolveUrls(html: string, baseUrl: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const img of doc.querySelectorAll("img[src]")) {
    try {
      img.setAttribute("src", new URL(img.getAttribute("src")!, baseUrl).href);
    } catch { /* leave malformed src alone */ }
  }
  for (const a of doc.querySelectorAll("a[href]")) {
    try {
      a.setAttribute("href", new URL(a.getAttribute("href")!, baseUrl).href);
    } catch { /* leave malformed hrefs alone */ }
  }
  return doc.body.innerHTML;
}
```

### 6.5 Service worker message handler

The service worker needs its own API client instance. It reads the auth token and API origin from `chrome.storage.local` (same keys the popup uses) and creates a `UrlKeepClient` on each capture request.

```typescript
// background.ts (extension service worker)
import { UrlKeepClient } from "@url-keep/api-client";

async function getClient(): Promise<UrlKeepClient> {
  const { url_keep_token: token, url_keep_api_origin: apiOrigin } =
    await chrome.storage.local.get(["url_keep_token", "url_keep_api_origin"]);
  return new UrlKeepClient({ baseUrl: apiOrigin, getToken: () => token });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "capture") {
    handleCapture(message.tabId, message.bookmarkId)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true; // Keep the message channel open for async response
  }
});

async function handleCapture(tabId: number, bookmarkId: string): Promise<void> {
  const client = await getClient();
  let captured: CapturedContent | null = null;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      files: ["capture.js"],
    });
    captured = result?.result ?? null;
  } catch {
    // Injection failed (CSP, chrome:// page, tab closed, etc.)
  }

  if (captured?.content_html) {
    try {
      await client.uploadBookmarkContent(bookmarkId, {
        content_html: captured.content_html,
        title: captured.title,
        author: captured.author,
        published_date: captured.published_date,
        site_name: captured.site_name,
      });
      return; // Success — content is in D1
    } catch {
      // Upload failed (network error, 413, 422, etc.)
    }
  }

  // Capture or upload failed — trigger server extraction as explicit fallback
  try {
    await client.extractBookmark(bookmarkId);
  } catch {
    // Server extraction also failed to queue. Content stays pending.
    // User can retry from the web app.
  }
}
```

### 6.6 Failure modes

| Failure | Where | Recovery |
|---|---|---|
| Script injection blocked (CSP, chrome:// page, tab already closed) | Service worker | Service worker triggers server extraction |
| Readability returns null (not an article) | capture.js | Service worker triggers server extraction (which may also skip) |
| Upload returns 422 (content too short after sanitization) | Service worker | Service worker triggers server extraction |
| Upload returns 413 (content too large) | Service worker | Service worker triggers server extraction |
| Network error on upload | Service worker | Service worker triggers server extraction |
| Service worker killed before completing | Chrome runtime | Content stays `pending`. User sees "pending" in web app and can retry. |

The last case (service worker killed mid-work) is the residual risk. MV3 service workers can be terminated if Chrome is under memory pressure. In practice, the capture + upload takes 1-3 seconds total, so this is an edge case. If it happens, the bookmark exists but content is pending. The web app shows this state and offers a "retry extraction" action.

### 6.7 Extension changes summary

Files:
- `apps/extension/src/background.ts` — new file, service worker with capture message handler (~50 lines)
- `apps/extension/src/capture.ts` — new file, the script injected into tabs (Readability + URL resolution, bundled to `capture.js`)
- `apps/extension/src/popup.ts` — after save, send `{ action: "capture", tabId, bookmarkId }` to service worker instead of doing capture inline
- `apps/extension/build.mjs` — bundle `capture.ts` + Readability into `dist/capture.js`; build `background.ts` into `dist/background.js`
- `apps/extension/manifest.json` — add `"background": { "service_worker": "background.js" }`

The extension already has `scripting` and `activeTab` permissions. The only manifest change is registering the service worker.

## 7. Server-Side Extraction

Unchanged from v1 and the current implementation, with two modifications:

### 7.1 Structured errors

Replace free-text error strings with JSON:

```typescript
function makeExtractionError(reason: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ reason, ...extra });
}

// Usage:
// Non-OK response
makeExtractionError("fetch_error", { http_status: response.status })
// Timeout
makeExtractionError("timeout")
// Not HTML
makeExtractionError("unsupported_content_type", { content_type: contentType })
// No readable content
makeExtractionError("no_readable_content", { text_length: textLength })
```

### 7.2 Content source tracking

Set `content_source = 'server'` when server extraction completes successfully.

### 7.3 Protect client content

When `POST /v1/bookmarks/:id/extract` is called (including the explicit fallback from the extension service worker), check before running:

- If `content_source = 'client'` and `extraction_status = 'complete'`: return `409 Conflict`. Client content is canonical and must not be silently replaced by a server fetch that may return a paywall page or lower-quality result.
- If `content_source = 'server'` or content doesn't exist: proceed normally.

To replace client content, the user must first `DELETE /v1/bookmarks/:id/content`, then trigger extraction. This is intentional friction — it prevents accidental destruction of the highest-fidelity version.

## 8. Reader View

Unchanged from v1 section 8. Route: `/read/:id`. Typography: monospace, 1.7 line-height, 65ch max-width.

Content rendering:
1. Fetch `content_html` from API (or IndexedDB when offline).
2. Resolve image URLs: `src="/v1/images/"` → `src="${API_ORIGIN}/v1/images/"`.
3. Sanitize with DOMPurify (allowlisted tags and attributes from section 2.6).
4. Render with `dangerouslySetInnerHTML`.

### 8.1 Extraction error display

When `extraction_status` is `failed`, parse the structured `extraction_error` and show a human-readable message:

| `reason` | Display |
|---|---|
| `access_denied` (401/403) | "this site blocked server access. save from the extension for full content." |
| `fetch_error` (other HTTP) | "could not reach this page (HTTP {status})" |
| `timeout` | "page took too long to respond" |
| `unsupported_content_type` | "this page is not an article ({content_type})" |
| `no_readable_content` | "no article content found on this page" |
| (legacy free-text) | show the raw string |

For `access_denied` errors where `content_source` is null (no client capture was attempted), the message nudges the user to re-save from the extension.

## 9. Image Handling

Unchanged from v1 sections 9.1–9.10. Server-side image extraction stores images in R2 during extraction. Images are served via an unauthenticated proxy endpoint with immutable caching.

### 9.1 Images from client-captured content

Client-captured content keeps original third-party image URLs. These images:
- Work when the user is online (loaded directly from the source)
- May not work offline (not stored in R2)
- May not work if the source is behind a paywall (the server can't fetch them)

This is an acceptable v1 tradeoff. The text is the high-value content. Paywalled article images are a harder problem that would require client-side image capture (base64 encoding in the content script, significantly larger upload payloads). Defer to a future version if demand warrants it.

For publicly accessible images in client-captured content, a follow-up optimization could have the server download them to R2 after the content upload. This is not in scope for v1.

## 10. Offline Storage and Sync

Unchanged from v1 sections 7.1–7.4.

- IndexedDB for bookmarks and article content
- Full-snapshot sync via `GET /v1/offline/bundle`
- Re-sync on visibility change if stale (>60 seconds)
- Server wins conflict resolution
- Read-only offline mode
- Image pre-caching during sync (for R2-proxied images only)

### 10.1 Content source in offline display

The `content_source` field is included in the offline bundle. The reader view can show a subtle indicator:
- "captured from browser" for `client` content
- No indicator for `server` content (this is the default)

This helps the user understand why some articles have images offline and others don't.

## 11. PWA Infrastructure

Unchanged from v1 section 6 and `PWA.md`. Service worker, manifest, app shell caching, runtime caching for API and images.

## 12. Implementation Phases

### Phase 1: Server extraction + reader view (already done)

This is the current state of the codebase. Server-side extraction with Readability + linkedom, R2 image storage, reader view, DOMPurify sanitization, extraction status on bookmark list.

### Phase 2: Structured errors + content source

Scope:
- Migration `0003_content_source.sql` — add `content_source` column
- Update `extraction.ts` to store structured JSON errors and set `content_source = 'server'`
- Update reader view error display to parse structured errors
- Update shared schemas to include `content_source`

Files:
```
apps/api/migrations/0003_content_source.sql          (new)
apps/api/src/extraction.ts                           (structured errors, content_source)
apps/api/src/types.ts                                (add contentSource to ArticleContentRecord)
apps/api/src/d1-store.ts                             (read/write content_source)
apps/api/src/memory-store.ts                         (add contentSource for tests)
packages/shared/src/index.ts                         (add content_source to schemas)
apps/web/src/App.tsx                                 (structured error display in reader)
```

Effort: Small. Mostly string format changes and a one-column migration.

### Phase 3: Extension content capture

Scope:
- New API endpoint: `PUT /v1/bookmarks/:id/content` with `sanitize-html` allowlist
- Skip server extraction for `saved_via = 'extension'` saves
- Protect client content from server overwrite (`409 Conflict`)
- Extension service worker (`background.ts`) with capture message handler
- Extension content script (`capture.ts`) bundled with Readability into `capture.js`
- Popup hands off to service worker after save
- Extension build changes to produce `capture.js` and `background.js`

Files:
```
apps/api/src/app.ts                                  (PUT endpoint, skip extraction for extension saves, 409 on force)
apps/api/src/sanitize.ts                             (new — sanitize-html allowlist config)
apps/api/package.json                                (add sanitize-html dependency)
apps/extension/src/background.ts                     (new — service worker, capture handler)
apps/extension/src/capture.ts                        (new — injected script, Readability + URL resolution)
apps/extension/src/popup.ts                          (send message to service worker after save)
apps/extension/build.mjs                             (bundle capture.js and background.js)
apps/extension/manifest.json                         (add service_worker registration)
packages/shared/src/index.ts                         (upload request schema)
packages/api-client/src/index.ts                     (uploadBookmarkContent method)
```

Effort: Medium. The main new work is the extension service worker, the bundled capture script, and the sanitization endpoint. Each piece is small individually.

### Phase 4: PWA + offline sync

Same as v1 phases 2 and 3, combined:
- Web app manifest, icons, service worker
- Share target on `/save` page
- IndexedDB offline storage and sync
- Image pre-caching during sync
- Offline detection and read-only offline mode

Effort: Medium-Large. Same scope as v1.

## 13. What's explicitly out of scope

- **`blocked` extraction status.** Structured errors give the same information with more flexibility and no schema migration per failure mode.
- **Client-side image capture.** Base64 encoding images in the content script and uploading them would significantly increase payload sizes and extension complexity. Not worth it for v1. For paywalled content, images won't work offline — the text is the value.
- **Offline mutation queue.** Same rationale as v1 — read-only offline is sufficient.
- **Cookie/session forwarding to the server.** The hybrid model makes this unnecessary. The extension captures what the user can see; the server handles public content.
- **Automatic content merging.** No diffing, no merge strategies. Client content is canonical for extension saves. Server content is canonical for other saves. To replace one with the other, delete first, then re-extract. Simple and predictable.

## 14. Dependencies

Same as v1, plus:

| Package | Where | Purpose |
|---|---|---|
| `@mozilla/readability` | Extension (bundled into capture.js) | Client-side article extraction |
| `sanitize-html` | API | Server-side HTML sanitization on content ingest |

Readability is already a dependency in the API. `sanitize-html` (~30KB, pure JS via `htmlparser2`) is new to the API — it runs in Workers and is the server-side security gate for client-submitted HTML.

## 15. Open Questions

1. **Service worker keepalive.** MV3 service workers can be terminated under memory pressure. The capture + upload cycle is fast (1-3 seconds), but if Chrome kills the worker mid-flight, content stays pending. Is this acceptable, or should we add a `chrome.alarms`-based retry that checks for stale pending bookmarks on the next worker wakeup? Probably overkill for v1, but worth monitoring.

2. **Re-capture from extension for non-extension saves.** If a bookmark was saved via web paste (server extraction got a 403), should the extension offer to capture content when the user visits that URL? This would require the extension to check if the current tab URL matches any bookmarks with failed extraction. Nice to have, not v1.

3. **sanitize-html in Workers.** `sanitize-html` uses `htmlparser2` which is pure JS and should run in Workers without issues. Verify this during implementation. If there are problems, the fallback is to use `linkedom` to parse the HTML into a DOM, then walk the tree and strip non-allowlisted elements/attributes manually — effectively a hand-rolled sanitizer using the same allowlist. Less battle-tested than `sanitize-html` but avoids the dependency.
