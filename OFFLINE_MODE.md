# Offline Reading Mode

## 1. Overview

Add the ability to read saved articles offline. This requires two capabilities that url-keep does not have today:

1. **Article extraction** - fetch and parse the readable content of a bookmarked URL, then persist it in D1.
2. **Offline-capable web app** - turn the web app into a PWA that caches the app shell and article content locally so everything works without a network connection.

The goal is simple: save a URL from anywhere (extension, web, iOS Shortcut), have the system automatically extract the article text, and be able to read it later on a plane or outside of WiFi/cell reach.

## 2. Architecture Summary

```
Save flow (unchanged)              Extraction flow (new)
─────────────────────              ──────────────────────
extension ─┐                       POST /v1/bookmarks
web paste ─┼─▶ POST /v1/bookmarks      │
iOS shortcut┘       │               ctx.waitUntil(extract)
                    │                   │
                    ▼               ┌───┴────┐
              ┌──────────┐    ┌────┤ extract ├────┐
              │ bookmarks│    │    └────┬────┘    │
              │ (D1)     │    ▼         ▼         ▼
              └──────────┘  fetch    Readability  download
                            HTML     parse        images
                              │         │           │
                              ▼         ▼           ▼
                        ┌──────────┐  ┌───┐  ┌──────────┐
                        │ article_ │  │D1 │  │   R2     │
                        │ content  │  │   │  │  images  │
                        │  (D1)    │  │   │  │  bucket  │
                        └────┬─────┘  └───┘  └────┬─────┘
                             │                     │
                             ▼                     ▼
                    GET /v1/.../content    GET /v1/images/:key
                             │                     │
                    ┌────────┼─────────────────────┤
                    ▼        ▼                     ▼
              ┌──────────┐ ┌──────────┐     ┌──────────┐
              │ Reader   │ │ IndexedDB│     │ Service  │
              │ view     │ │ (offline │     │ Worker   │
              │ /read/:id│ │  store)  │     │ (cache)  │
              └──────────┘ └──────────┘     └──────────┘
```

The existing save flow stays fast and unchanged. Extraction runs asynchronously in the background via `ctx.waitUntil()` after a bookmark is saved. During extraction, article images are downloaded and stored in a Cloudflare R2 bucket, and image URLs in the article HTML are rewritten to API-origin proxy paths. The web app syncs extracted content to IndexedDB for offline access. A service worker caches the app shell and proxied images so everything — text and pictures — works without a network.

### 2.1 Origin model

url-keep runs on split origins: the web app is on `www.url-keep.com` (Vercel) and the API is on `api.url-keep.com` (Workers). Images served from the API are **cross-origin** to the web app.

The image URL model:

- **Stored in D1** (`content_html`): relative paths like `/v1/images/articles/{bookmarkId}/{hash}`. Origin-agnostic so the data is portable across environments.
- **Rendered in browser**: the client prepends `API_ORIGIN` at render time → `https://api.url-keep.com/v1/images/articles/{bookmarkId}/{hash}`.
- **CORS**: the API's existing CORS middleware already grants `Access-Control-Allow-Origin` for `APP_ORIGIN`. Image proxy responses go through the same middleware, so the browser can fetch them with full CORS. No opaque responses, no storage padding.
- **Service worker**: Workbox's runtime cache matches against the absolute API-origin URLs. Standard cross-origin CORS responses are cacheable at their actual size.

## 3. Article Extraction

### 3.1 Why server-side

Every save path (extension, web paste, iOS Shortcut) must result in extractable content. Doing extraction server-side in the Cloudflare Worker means all clients benefit equally without duplicating parsing logic. The extension *could* extract content client-side since it has access to the live DOM, but server-side extraction is simpler and more consistent as the single path.

### 3.2 Parser choice

Use **@mozilla/readability** (the library behind Firefox Reader View) with **linkedom** as a lightweight DOM implementation for Workers.

- `@mozilla/readability` (~50KB) - battle-tested article extraction with excellent heuristics for identifying main content, stripping nav/ads/sidebars.
- `linkedom` (~40KB) - minimal DOM implementation that provides the `Document` interface Readability needs. Much smaller than jsdom or happy-dom. Runs well in Workers.

```
npm install @mozilla/readability linkedom
```

### 3.3 Extraction flow

```
1. Bookmark saved → extraction_status = 'pending'
2. ctx.waitUntil() fires async extraction:
   a. fetch(bookmark.url) with 10s timeout, User-Agent header
   b. Parse HTML with linkedom
   c. Run Readability on the document
   d. Download and store article images to R2 (see section 9)
   e. Rewrite <img src> URLs in content_html to R2-proxied paths
   f. Store content_html, word_count, author
   g. Set extraction_status = 'complete'
3. On failure → extraction_status = 'failed', store error message
```

### 3.4 Fetch considerations

- **Timeout**: 10 second fetch timeout. Some pages are slow; don't block the Worker.
- **User-Agent**: Send a reasonable UA string (`url-keep/1.0`). Some sites block requests without one.
- **Redirects**: Follow redirects (fetch default behavior). Store the final URL if it differs.
- **Size limit**: Abort if response body exceeds 5MB. Protects against accidentally fetching huge files.
- **Content-Type**: Only parse `text/html` responses. Skip PDFs, images, JSON APIs, etc.
- **Robots/rate-limiting**: This is a personal tool saving one URL at a time. No batch crawling. Acceptable use.

### 3.5 Pages that won't extract well

Some URLs don't have readable article content (YouTube, Twitter/X, GitHub repos, interactive apps). The extraction should handle this gracefully:

- If Readability returns null or very short content (<100 chars), set `extraction_status = 'skipped'` with a message like "no readable content found."
- The UI treats skipped bookmarks the same as ones without content - just show the link, no reader view.

### 3.6 Workers CPU budget

Cloudflare Workers (paid plan, which this project already uses for D1) allow 30 seconds of CPU time per invocation. The extraction workload is:

- `fetch()`: network I/O, doesn't count against CPU time
- HTML parsing with linkedom: typically 10-50ms for a normal article page
- Readability extraction: typically 5-20ms
- D1 write: network I/O

Total CPU cost: well under 100ms per article. Comfortably within limits.

## 4. Database Changes

### 4.1 New table: `article_content`

```sql
CREATE TABLE article_content (
  id TEXT PRIMARY KEY,
  bookmark_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  content_html TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  author TEXT,
  published_date TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'complete', 'failed', 'skipped')),
  extraction_error TEXT,
  extracted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_article_content_user_status
  ON article_content(user_id, extraction_status);
```

### 4.2 Why a separate table

Article content is large (5-100KB per article). Keeping it separate from `bookmarks` means:

- `GET /v1/bookmarks` (list) stays fast - no content blobs in the response.
- Content can be fetched on demand or in batch for offline sync.
- Easy to manage storage: delete content independently, re-extract, track status.
- Clean migration path: no changes to the existing bookmarks table.

### 4.3 Migration file

`apps/api/migrations/0002_article_content.sql`

The migration creates the table and index. It does not backfill existing bookmarks — the `POST /v1/bookmarks/:id/extract` endpoint can be called in a loop for existing bookmark IDs. No dedicated script needed.

## 5. API Changes

### 5.1 New endpoints

#### `POST /v1/bookmarks/:id/extract`

Trigger extraction for a single bookmark. Useful for retry after failure or for extracting content from bookmarks saved before this feature existed.

- Auth required.
- Returns `202 Accepted` and runs extraction via `waitUntil()`. The response signals that extraction has been queued, without persisting a separate `processing` state — the row stays `pending` until extraction completes or fails.
- Returns `404` if bookmark doesn't exist.
- If content already exists and status is `complete`, returns `200` with current status (no re-extraction). Pass `?force=true` to force re-extraction.

#### `GET /v1/bookmarks/:id/content`

Get extracted article content for a single bookmark.

Response (status `200`):
```json
{
  "item": {
    "bookmark_id": "b_123",
    "content_html": "<article>...</article>",
    "word_count": 1450,
    "author": "Jane Doe",
    "published_date": "2026-01-15",
    "extraction_status": "complete",
    "extracted_at": "2026-03-10T12:00:00.000Z"
  }
}
```

- Returns `404` if bookmark doesn't exist.
- Returns `200` with `extraction_status: 'pending'` or `'failed'` if content isn't available yet. `content_html` will be null in those cases.

#### `GET /v1/offline/bundle`

Batch endpoint for offline sync. Returns bookmarks with their extracted content.

This uses **full snapshot sync**: the client pages through the entire bookmark set and reconciles locally. Incremental delta sync (with a `since` timestamp) was considered and rejected for v1 because:

- A bare timestamp cursor is not stable when multiple rows share the same `updated_at`.
- Delta sync cannot represent deletions without tombstones or a separate deletion log.
- The existing bookmark pagination already uses a robust composite cursor (`created_at|id`). Reusing it here is simpler and correct.
- For a single-user app with hundreds of bookmarks, full snapshot sync is fast enough.

Query params:
- `cursor` (optional) - opaque cursor from a previous response (same format as `GET /v1/bookmarks`).
- `limit` (optional) - max bookmarks to return per page (default 50, max 100).

Response:
```json
{
  "items": [
    {
      "bookmark": { "id": "b_123", "url": "...", "title": "...", ... },
      "content": {
        "content_html": "...",
        "word_count": 1450,
        "extraction_status": "complete"
      }
    }
  ],
  "next_cursor": "base64(created_at|id)",
  "has_more": true
}
```

The client pages through with `cursor` until `has_more` is false, then reconciles: add new bookmarks, update changed ones, delete any local bookmarks whose IDs are not in the server set.

Sort order is newest-first by `created_at DESC, id DESC`, consistent with the existing bookmark list endpoint. The composite cursor ensures stable pagination even when rows share timestamps.

#### `DELETE /v1/bookmarks/:id/content`

Remove extracted content for a bookmark. Returns `204`. Useful if the user wants to free storage or if content was incorrectly extracted.

### 5.2 Changes to existing endpoints

**`POST /v1/bookmarks`** (save) - After successfully saving a bookmark, trigger extraction via `ctx.waitUntil()`. The response shape is unchanged. The extraction runs asynchronously and doesn't affect save latency.

**`GET /v1/bookmarks`** (list) - Add an optional `extraction_status` field to each bookmark in the response, joined from `article_content`. This lets the UI show which bookmarks have content available for offline reading. The join is on an indexed unique column, so performance impact is minimal.

**`DELETE /v1/bookmarks/by-url`** - The `ON DELETE CASCADE` foreign key on `article_content.bookmark_id` automatically removes associated content. R2 image cleanup runs via `waitUntil()` (see section 9.8).

### 5.2.1 Extraction's effect on bookmark metadata

When extraction completes, it may update fields on the `bookmarks` row:

- **`title`**: If `title_source = 'fallback'` (server-generated hostname placeholder) and Readability extracted a proper title, update the title and set `title_source = 'client'`. If `title_source` is `'client'` or `'user'`, do not overwrite — those are intentional.
- **`site_name`**: If null and Readability extracted a site name, fill it.
- **`image_url`**: Not changed by extraction. Bookmark thumbnails come from client-supplied og:image only (current behavior).

This means extraction improves metadata for bookmarks saved without titles (e.g., web paste, iOS Shortcut without title), while preserving any user edits.

The reader view header uses `bookmark.title` (from the bookmarks table, which may have been upgraded by extraction) plus `article_content.author` and `article_content.published_date` for byline metadata. There is no separate "extracted title" field — Readability's title is used to upgrade the bookmark title if appropriate, then the bookmark title is the single source of truth.

### 5.3 Shared schema additions

Add to `packages/shared/src/index.ts`:

```typescript
export const extractionStatusSchema = z.enum([
  'pending', 'complete', 'failed', 'skipped'
]);

// Add extraction_status to existing bookmarkSchema
export const bookmarkSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  normalized_url: z.string().url(),
  title: z.string(),
  image_url: z.string().url().nullable().optional(),
  site_name: z.string().nullable().optional(),
  saved_via: savedViaSchema,
  created_at: z.string(),
  updated_at: z.string(),
  extraction_status: extractionStatusSchema.nullable().optional(),
});

export const articleContentSchema = z.object({
  bookmark_id: z.string(),
  content_html: z.string().nullable(),
  word_count: z.number(),
  author: z.string().nullable(),
  published_date: z.string().nullable(),
  extraction_status: extractionStatusSchema,
  extracted_at: z.string().nullable(),
});

export const offlineBundleItemSchema = z.object({
  bookmark: bookmarkSchema,
  content: articleContentSchema.nullable(),
});

export const offlineBundleResponseSchema = z.object({
  items: z.array(offlineBundleItemSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
```

### 5.4 API client additions

Add to `packages/api-client/src/index.ts`:

```typescript
async extractBookmark(id: string, force?: boolean): Promise<{ extraction_status: string }> { ... }
async getBookmarkContent(id: string): Promise<ArticleContentResponse> { ... }
async getOfflineBundle(cursor?: string, limit?: number): Promise<OfflineBundleResponse> { ... }
async deleteBookmarkContent(id: string): Promise<void> { ... }
```

## 6. PWA Infrastructure

> The full PWA plan — including the share target, install UX, standalone mode behavior, and the relationship to the iOS Shortcut — is in `PWA.md`. This section covers only the manifest and service worker config needed for offline support. Implement `PWA.md` first; it establishes the foundation this document extends.

### 6.1 Web app manifest

Create `apps/web/public/manifest.json` (see `PWA.md` section 3 for the complete manifest including `share_target`). The minimum fields needed for offline support:

```json
{
  "name": "url-keep",
  "short_name": "url-keep",
  "description": "personal bookmark keeper",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#000000",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    },
    {
      "src": "/icon-512-maskable.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
}
```

Add `<link rel="manifest" href="/manifest.json">` to `index.html`.

Generate icons from the existing `url-keep-logo.png` at 192px and 512px.

### 6.2 Service worker

Use **vite-plugin-pwa** with Workbox. This is the standard approach for Vite-based PWAs and handles the complexity of service worker lifecycle, precaching, and runtime caching.

```
npm install -D vite-plugin-pwa
```

Vite config addition:

```typescript
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        runtimeCaching: [
          {
            // API data calls: network-first, fall back to cache
            urlPattern: /^https:\/\/api\.url-keep\.com\/v1\/(?!images\/).*/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 },
              networkTimeoutSeconds: 5,
            },
          },
          {
            // R2-proxied article images (cross-origin, proper CORS): cache-first
            urlPattern: /^https:\/\/api\.url-keep\.com\/v1\/images\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'article-images',
              expiration: { maxEntries: 2000, maxAgeSeconds: 90 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      manifest: false, // use the static manifest.json instead
    }),
  ],
});
```

### 6.3 What the service worker caches

| Layer | What | Strategy | Storage |
|-------|------|----------|---------|
| App shell | HTML, CSS, JS, fonts, icons | Precache on install | Cache API |
| API responses | Bookmark list, auth | Network-first, 5s timeout | Cache API |
| Article content | Extracted HTML | Explicit sync | IndexedDB |
| Article images | Images within articles (R2-proxied, cross-origin) | Cache-first, pre-cached during sync | Cache API |

### 6.4 Offline detection

The app needs to know when it's offline to adjust behavior:

```typescript
// Simple hook
function useOnlineStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);
  return online;
}
```

When offline:
- Show a subtle indicator in the header (e.g., "offline" label).
- Serve bookmark list and article content from IndexedDB.
- Disable write actions (save, delete, edit, extract) — offline mode is read-only.
- The "read" action works fully offline from IndexedDB + Cache API.

## 7. Client-Side Offline Storage

### 7.1 IndexedDB schema

Use the `idb` library (tiny Promise wrapper around IndexedDB) for ergonomics.

```
npm install idb
```

Database name: `url-keep-offline`

```typescript
interface OfflineDB {
  bookmarks: {
    key: string;          // bookmark.id
    value: Bookmark;
    indexes: {
      'by-created': string;       // created_at
      'by-normalized-url': string; // normalized_url
    };
  };
  articles: {
    key: string;          // bookmark_id
    value: {
      bookmark_id: string;
      content_html: string | null;
      word_count: number;
      author: string | null;
      published_date: string | null;
      extraction_status: string;
      synced_at: string;
    };
  };
  sync_meta: {
    key: string;          // 'state'
    value: {
      last_sync_at: string | null;
      bookmark_count: number;
    };
  };
}
```

### 7.2 Sync manager

A `SyncManager` class that:

1. **Full snapshot sync**: Page through `GET /v1/offline/bundle` until `has_more` is false. Collect all server bookmark IDs.
2. **Reconciliation**: After downloading, delete any local bookmarks whose IDs are not in the server set. This handles server-side deletions without tombstones.
3. **Re-sync on visibility**: When the tab regains focus or visibility (`visibilitychange` event) and the last sync is stale (e.g., >60 seconds ago), trigger a re-sync. This catches bookmarks saved via the extension or shortcut while the web app was sitting open, without polling on a timer.
4. **Conflict resolution**: Server wins. The server is the source of truth. Client-side data is a read cache.

```typescript
class SyncManager {
  private db: IDBPDatabase<OfflineDB>;

  async sync(): Promise<void> {
    // Page through the full bookmark set
    const serverIds = new Set<string>();
    let cursor: string | undefined;

    do {
      const response = await client.getOfflineBundle(cursor);

      const tx = this.db.transaction(['bookmarks', 'articles'], 'readwrite');
      for (const item of response.items) {
        serverIds.add(item.bookmark.id);
        await tx.objectStore('bookmarks').put(item.bookmark);
        if (item.content) {
          await tx.objectStore('articles').put({
            ...item.content,
            synced_at: new Date().toISOString(),
          });
        }
      }
      await tx.done;

      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    // Reconcile: remove local bookmarks deleted on the server
    const localKeys = await this.db.getAllKeys('bookmarks');
    const deleteTx = this.db.transaction(['bookmarks', 'articles'], 'readwrite');
    for (const key of localKeys) {
      if (!serverIds.has(key as string)) {
        await deleteTx.objectStore('bookmarks').delete(key);
        await deleteTx.objectStore('articles').delete(key);
      }
    }
    await deleteTx.done;

    await this.db.put('sync_meta', {
      last_sync_at: new Date().toISOString(),
      bookmark_count: serverIds.size,
    }, 'state');
  }

  async getBookmarks(): Promise<Bookmark[]> {
    return this.db.getAllFromIndex('bookmarks', 'by-created');
  }

  async getArticle(bookmarkId: string): Promise<ArticleContent | null> {
    return this.db.get('articles', bookmarkId) ?? null;
  }
}
```

### 7.3 No offline mutation queue (read-only offline)

Offline mode is **read-only**. Save, delete, and edit operations require a network connection and are disabled in the UI when offline.

An offline mutation queue (save/delete/edit while offline, replay on reconnect) was considered and cut from this plan. The complexity is disproportionate to the value:

- Deduplication: what happens if the user saves then deletes the same URL before reconnecting?
- Replay ordering: edits to a title that was deleted, or saves that conflict with server-side changes.
- Auth expiry: tokens could expire before the queue replays.
- Error handling: what does the user see if replay partially fails?

None of these are unsolvable, but they're all unnecessary for the core goal (reading articles on a plane). Offline reading works perfectly without offline writes. If offline saves become important later, they can be added as a separate feature with proper design.

### 7.4 Storage budget and failure policy

Typical sizes per article:
- Article HTML in IndexedDB: 5-50KB (avg ~30KB)
- Article images in Cache API: 5 images × 200KB avg = ~1MB

For 500 cached articles:
- IndexedDB (text content): ~15MB
- Cache API (images): ~500MB

Total: ~515MB. Within browser storage limits on all modern platforms (Chrome: up to 80% of disk per origin, Safari: 1GB+ per origin, Firefox: up to 2GB per origin). Images are served with proper CORS (not opaque), so they're cached at their actual size — no padding overhead.

#### Failure hierarchy

**Text content (IndexedDB) is guaranteed.** Article text is the core offline value and is small (~15MB for 500 articles). If IndexedDB is full (extremely unlikely), sync stops and the user is notified. Existing cached content remains available.

**Images (Cache API) are best-effort.** Image pre-caching must never block or break the sync. All Cache API operations during sync are wrapped in try/catch:

```typescript
// Image pre-caching — best-effort, never blocks sync
try {
  await precacheArticleImages(item.content.content_html);
} catch {
  // Quota exceeded, network error, or eviction — continue without images.
  // Articles are still readable; images just won't load offline.
}
```

If the browser evicts cached images (possible on iOS Safari after ~7 days of inactivity), articles are still fully readable — the text is in IndexedDB. Missing images show a neutral CSS placeholder, not a broken icon.

#### iOS Safari eviction

Safari may evict both Cache API and IndexedDB data for origins not visited in ~7 days. Mitigation:
- IndexedDB is more persistent than Cache API on iOS. Prioritize text in IndexedDB.
- If data is evicted, the next app open triggers a fresh sync (the `last_sync_at` check in sync_meta will be null).
- This is a browser limitation, not something the app can fully prevent. Acceptable for v1.

## 8. Reader View

### 8.1 Route

New route: `/read/:id`

This is a dedicated reading view for extracted article content. It renders the cleaned HTML from `article_content.content_html`.

### 8.2 Layout

```
┌─────────────────────────────────────┐
│ ← back          url-keep    offline │
├─────────────────────────────────────┤
│                                     │
│  Article Title                      │
│  author · 1,450 words · 6 min read  │
│  site_name · published_date         │
│                                     │
│  ─────────────────────────────────  │
│                                     │
│  Article content rendered here as   │
│  clean HTML. Paragraphs, headings,  │
│  lists, blockquotes, images, and    │
│  code blocks.                       │
│                                     │
│  ...                                │
│                                     │
│  ─────────────────────────────────  │
│  open original                      │
│                                     │
└─────────────────────────────────────┘
```

### 8.3 Design decisions

- **Typography**: Keep monospace to match the app's visual language. Apply a wider line-height (1.7) and constrained line width (65ch max) for readability.
- **Estimated read time**: `Math.ceil(word_count / 230)` minutes (average reading speed).

### 8.4 Content rendering and sanitization

The `content_html` from Readability.js is already simplified, but must be sanitized before rendering in the browser. Use **DOMPurify** (~15KB) to whitelist safe tags and attributes.

```
npm install dompurify
```

```typescript
import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'a', 'img',
  'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'br', 'hr',
  'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'sup', 'sub', 'del',
];

const ALLOWED_ATTR = ['href', 'src', 'alt', 'title'];

function sanitizeArticleHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ADD_ATTR: ['target', 'rel'],
  });
}
```

Before rendering, resolve relative image paths against the API origin (see section 2.1):

```typescript
function resolveImageUrls(html: string, apiOrigin: string): string {
  return html.replaceAll('src="/v1/images/', `src="${apiOrigin}/v1/images/`);
}
```

Render with:

```tsx
<div
  className="reader-content"
  dangerouslySetInnerHTML={{
    __html: sanitizeArticleHtml(resolveImageUrls(content_html, API_ORIGIN))
  }}
/>
```

### 8.5 Accessing the reader

Add a "read" action to each bookmark row in the list view, visible when `extraction_status === 'complete'`. This links to `/read/:id`.

For bookmarks where extraction is pending/failed/skipped, the read action is either hidden or shown as disabled with a tooltip explaining why.

## 9. Image Handling for Offline Reading

Images are critical to the offline reading experience. An article about architecture without its diagrams, or a recipe without its photos, isn't much use on a plane. The strategy: download article images server-side during extraction, store them in Cloudflare R2, and rewrite the HTML to reference API-origin proxied URLs. The API serves these with proper CORS headers, making them fully cacheable by the service worker at their actual size. R2 also preserves images permanently even if the original source goes down.

### 9.1 Why R2 instead of client-side caching

The obvious alternative is to skip R2 and have the service worker cache images from their original third-party URLs as the user views articles. This has three problems:

1. **CORS and opaque responses.** Fetching third-party images via `fetch()` in a service worker requires `no-cors` mode, which returns opaque responses. Browsers pad opaque responses to ~7MB each for storage quota purposes. Five images per article × 500 articles = potentially 17GB of quota consumed for maybe 500MB of actual image data. This can exhaust the origin's storage budget.

2. **You have to open every article first.** "Cache on view" means if you're about to board a plane and want to read your saved articles, you'd need to manually open each one while still on WiFi. That's not a real offline experience.

3. **Image URLs go stale.** CDN tokens expire, sites reorganize, publications go behind paywalls. An article saved today may have dead image links in six months. Server-side storage preserves the images at extraction time.

R2 solves all three: images are served from the API origin with proper CORS (no opaque responses, actual-size cache accounting), downloaded proactively during extraction (no manual pre-caching), and permanently stored (no link rot).

### 9.2 R2 bucket setup

Add to `apps/api/wrangler.toml`:

```toml
[[r2_buckets]]
binding = "IMAGES"
bucket_name = "url-keep-images"
```

Add to `Bindings` type in `apps/api/src/types.ts`:

```typescript
export type Bindings = {
  DB: D1Database;
  IMAGES: R2Bucket;
  // ...existing fields
};
```

R2 cost at this scale is negligible: $0.015/GB/month storage, $0.36/million reads. For 500 articles averaging 5 images at 200KB each = ~500MB = less than $0.01/month.

### 9.3 Image extraction during article processing

After Readability produces `content_html`, a second pass downloads and stores images:

```typescript
async function extractAndStoreImages(
  contentHtml: string,
  bookmarkId: string,
  baseUrl: string,
  r2: R2Bucket,
): Promise<string> {
  // Parse all <img src="..."> from the Readability output
  const imgRegex = /<img\s[^>]*src="([^"]+)"/gi;
  let rewrittenHtml = contentHtml;
  let totalBytes = 0;
  let imageCount = 0;

  for (const match of contentHtml.matchAll(imgRegex)) {
    if (imageCount >= 20) break;        // max 20 images per article
    if (totalBytes >= 10_000_000) break; // max 10MB total per article

    const originalSrc = match[1];
    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(originalSrc, baseUrl).href;
    } catch {
      continue; // skip malformed URLs
    }

    // Only download https:// images. Skip data: URIs, blob:, etc.
    if (!absoluteUrl.startsWith('https://')) continue;

    try {
      const response = await fetch(absoluteUrl, {
        signal: AbortSignal.timeout(5_000),  // 5s per image
        headers: { 'User-Agent': 'url-keep/1.0' },
      });
      if (!response.ok) continue;

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) continue;

      // Skip SVGs (often tracking pixels or decorative)
      if (contentType.includes('svg')) continue;

      const body = await response.arrayBuffer();
      if (body.byteLength > 2_000_000) continue;  // skip images > 2MB
      if (body.byteLength < 100) continue;         // skip tiny tracking pixels

      // Content-addressed key scoped to bookmark
      const hash = await sha256hex(absoluteUrl);
      const r2Key = `articles/${bookmarkId}/${hash}`;

      await r2.put(r2Key, body, {
        httpMetadata: { contentType },
      });

      // Rewrite src to relative proxy path (client prepends API_ORIGIN at render time)
      const proxiedPath = `/v1/images/articles/${bookmarkId}/${hash}`;
      rewrittenHtml = rewrittenHtml.replaceAll(originalSrc, proxiedPath);

      totalBytes += body.byteLength;
      imageCount++;
    } catch {
      // Failed to download this image; leave original URL in place.
      // It will still work online, just not offline.
    }
  }

  return rewrittenHtml;
}
```

### 9.4 Bookmark og:image thumbnails (deferred)

The existing `bookmarks.image_url` field stores third-party og:image URLs used for preview thumbnails in the bookmark list. Persisting these to R2 would make list thumbnails available offline, but it's not core to offline **reading**. Deferred to keep the initial scope focused.

In the offline bookmark list, thumbnails from third-party URLs simply won't load. The existing CSS already hides broken images gracefully (`onError={() => setHidden(true)}` in `BookmarkImage`). The list is fully functional without thumbnails.

### 9.5 Image proxy endpoint

New unauthenticated endpoint that serves article images from R2:

```
GET /v1/images/articles/:bookmarkId/:hash
```

```typescript
app.get('/v1/images/articles/:bookmarkId/:hash', async (c) => {
  const { bookmarkId, hash } = c.req.param();
  const key = `articles/${bookmarkId}/${hash}`;
  const object = await c.env.IMAGES.get(key);

  if (!object) {
    return c.notFound();
  }

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
});
```

Key design decisions:
- **Unauthenticated**: The R2 keys contain a bookmark ID (UUID) and a SHA-256 hash of the original URL. Both are unguessable. Requiring auth on image requests would force the service worker to inject Authorization headers into every `<img>` load, which adds significant complexity for negligible security benefit. The images are from public web pages.
- **Immutable caching**: Images are content-addressed and never change. A one-year `Cache-Control` with `immutable` means the browser and service worker cache them permanently and never revalidate.
- **CORS via existing middleware**: Images are cross-origin (API domain vs app domain), but the API's Hono CORS middleware already grants `Access-Control-Allow-Origin` for `APP_ORIGIN` on all routes. Browser fetches (from `<img>` tags and from the service worker) receive proper CORS headers, so responses are cacheable at their actual size — no opaque-response padding.

### 9.6 Service worker caching for images

Update the Workbox runtime caching config:

```typescript
{
  // R2-proxied article images (cross-origin, absolute API URLs)
  urlPattern: /^https:\/\/api\.url-keep\.com\/v1\/images\/.+/,
  handler: 'CacheFirst',
  options: {
    cacheName: 'article-images',
    expiration: {
      maxEntries: 2000,
      maxAgeSeconds: 90 * 24 * 60 * 60, // 90 days
    },
    cacheableResponse: {
      statuses: [200],
    },
  },
},
```

The images are cross-origin but served with proper CORS headers, so CacheFirst works correctly — check the cache first, fetch from R2 only on miss. The `immutable` Cache-Control header from the proxy means even without Workbox, the browser would not revalidate.

### 9.7 Proactive image pre-caching during sync

During the offline sync (Phase 3), after article content is synced to IndexedDB, the sync manager should also warm the service worker's image cache:

```typescript
async function precacheArticleImages(contentHtml: string): Promise<void> {
  const imgRegex = /src="(\/v1\/images\/[^"]+)"/gi;
  const cache = await caches.open('article-images');
  const urls: string[] = [];

  for (const match of contentHtml.matchAll(imgRegex)) {
    urls.push(match[1]);
  }

  // Fetch in parallel with concurrency limit
  const BATCH_SIZE = 5;
  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (url) => {
        const fullUrl = `${API_ORIGIN}${url}`;
        // Skip if already cached
        const existing = await cache.match(fullUrl);
        if (existing) return;

        const response = await fetch(fullUrl);
        if (response.ok) {
          await cache.put(fullUrl, response);
        }
      }),
    );
  }
}
```

This runs during sync — while the user is online — so by the time they go offline, all article images are already in the Cache API. No need to manually open each article.

### 9.8 Image cleanup on bookmark deletion

When a bookmark is deleted, its R2 images should be cleaned up. Add to the deletion flow:

```typescript
async function cleanupBookmarkImages(
  bookmarkId: string,
  r2: R2Bucket,
): Promise<void> {
  const objects = await r2.list({ prefix: `articles/${bookmarkId}/` });
  const keys = objects.objects.map((o) => o.key);

  if (keys.length > 0) {
    await r2.delete(keys);
  }
}
```

This is called via `waitUntil()` on bookmark deletion so it doesn't slow down the delete response.

### 9.9 Image handling limits summary

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max images per article | 20 | Covers nearly all articles; avoids gallery pages |
| Max size per image | 2MB | Covers high-res photos; skips huge infographics |
| Max total images per article | 10MB | Hard cap on R2 writes per extraction |
| Min image size | 100 bytes | Filters tracking pixels and spacer GIFs |
| Timeout per image download | 5 seconds | Don't let slow CDNs stall extraction |
| Skip SVGs | Always | Often decorative, tracking, or interactive — not useful offline |
| Skip non-HTTPS | Always | Consistent with existing image_url rules |

### 9.10 Fallback behavior

Not every image will be successfully stored. The strategy degrades gracefully:

- **Image download fails during extraction**: Original third-party URL is left in the HTML. The image works when online, shows a broken icon or CSS fallback when offline. This is acceptable — the article text is still readable.
- **Image exceeds size limits**: Same as above. The URL stays; it works online.
- **R2 is unavailable**: Extraction completes without images. The article content is still stored in D1. A re-extraction can be triggered later.
- **List thumbnails offline**: og:image thumbnails are third-party URLs and won't load offline. The existing `BookmarkImage` component already hides broken images. The list is fully functional without them.

Add a CSS fallback for broken images in the reader view:

```css
.reader-content img {
  max-width: 100%;
  height: auto;
}

/* Placeholder for images that failed to load */
.reader-content img::after {
  content: 'image unavailable offline';
  display: block;
  padding: 16px;
  background: #f5f5f5;
  color: var(--muted);
  font-size: 11px;
  text-align: center;
}
```

## 10. Bookmark List Offline Behavior

Offline mode is **read-only**. When the app detects it's offline:

1. **Bookmark list**: Load from IndexedDB instead of the API. Show a subtle "offline" indicator.
2. **Search**: Filter locally against IndexedDB data (case-insensitive substring match on title, url, site_name — same logic as the server).
3. **Read article**: Load from IndexedDB + images from Cache API. Works fully offline.
4. **Save URL**: Disabled. Show "saving requires a connection."
5. **Delete**: Disabled.
6. **Edit title**: Disabled.
7. **Extract**: Disabled (always requires server).
8. **Login**: Not possible offline. If the user is already authenticated (token in localStorage), the app works. If not, show "login requires a connection."

## 11. Implementation Phases

### Phase 1: Article extraction, image storage, and reader view (online only)

Scope:
- Migration `0002_article_content.sql`
- R2 bucket creation and wrangler.toml binding
- Server-side extraction using Readability.js + linkedom
- Extraction upgrades bookmark title (if fallback) and site_name (if null)
- Article image downloading to R2 during extraction
- HTML rewriting to use R2-proxied image paths
- `waitUntil()` extraction trigger on bookmark save
- New API endpoints: extract, get content, delete content, image proxy
- Image cleanup on bookmark deletion
- Store interface additions + `extraction_status` on bookmark list responses
- Reader view route `/read/:id` with DOMPurify sanitization + client-side URL resolution
- "read" action in bookmark list rows

New dependencies (API): `@mozilla/readability`, `linkedom`
New dependencies (web): `dompurify`

Files to add/modify:
```
apps/api/wrangler.toml                           (add R2 bucket binding)
apps/api/migrations/0002_article_content.sql     (new)
apps/api/src/extraction.ts                       (new - extraction + image download logic)
apps/api/src/types.ts                            (add ArticleContentRecord, IMAGES binding)
apps/api/src/store.ts                            (add article content methods)
apps/api/src/d1-store.ts                         (implement article content methods)
apps/api/src/memory-store.ts                     (implement for tests)
apps/api/src/app.ts                              (add new routes incl. image proxy)
packages/shared/src/index.ts                     (add article/extraction schemas)
packages/api-client/src/index.ts                 (add new client methods)
apps/web/src/App.tsx                             (add ReaderPage route, read action)
apps/web/src/styles.css                          (reader view styles, image fallbacks)
```

Estimated effort: Medium-Large. Article extraction, image pipeline, R2 proxy, and reader view are all in this phase, but they form a natural unit.

**Alternative: text-only Phase 1.** If the smallest shippable slice is the priority, article images can be deferred: Phase 1 does text extraction + reader view only (no R2, no image proxy), and a follow-up phase adds R2-backed images. The trade-off is that the reader view launches without images, which may feel incomplete for image-heavy articles. The plan above includes images in Phase 1 because R2 is low-effort infrastructure and the image extraction code is a natural extension of the fetch+parse pipeline.

### Phase 2: PWA shell and app caching

Scope:
- Web app manifest (`manifest.json`)
- PWA icons (192, 512, 512-maskable)
- Service worker via vite-plugin-pwa
- App shell precaching (HTML, CSS, JS)
- Runtime caching for API responses and images
- Offline detection hook (`useOnlineStatus`)
- "Offline" indicator in the UI

New dependencies (web): `vite-plugin-pwa`

Files to add/modify:
```
apps/web/public/manifest.json                    (new)
apps/web/public/icon-192.png                     (new)
apps/web/public/icon-512.png                     (new)
apps/web/public/icon-512-maskable.png            (new)
apps/web/index.html                              (add manifest link, theme-color)
apps/web/vite.config.ts                          (add VitePWA plugin)
apps/web/src/hooks/useOnlineStatus.ts            (new)
apps/web/src/App.tsx                             (add offline indicator)
```

Estimated effort: Small. Mostly configuration. vite-plugin-pwa does the heavy lifting.

### Phase 3: IndexedDB offline storage, sync, and image pre-caching

Scope:
- IndexedDB setup with `idb`
- SyncManager: full snapshot sync on load, re-sync on visibility change if stale
- Proactive image pre-caching: after syncing article content, parse image URLs from HTML and warm the service worker's Cache API (see section 9.7)
- Offline bundle API endpoint (`GET /v1/offline/bundle`)
- Bookmark list reads from IndexedDB when offline
- Reader view reads from IndexedDB when offline
- Local search against IndexedDB when offline

New dependencies (web): `idb`

Files to add/modify:
```
apps/api/src/app.ts                              (add bundle endpoint)
apps/api/src/store.ts                            (add bundle query method)
apps/api/src/d1-store.ts                         (implement bundle query)
apps/web/src/offline/db.ts                       (new - IndexedDB setup)
apps/web/src/offline/sync.ts                     (new - SyncManager + image pre-caching)
apps/web/src/App.tsx                             (integrate offline data source)
```

Estimated effort: Medium. The sync logic needs careful testing. Image pre-caching is straightforward since the URLs are already in the HTML and the client knows `API_ORIGIN`.

### Phase 4 (cut)

~~Offline action queue and background sync.~~ Cut from this plan. Offline mode is read-only. If offline writes become important later, they should be designed as a separate feature with proper consideration of deduplication, replay ordering, auth expiry, and partial failure (see section 7.3).

## 12. New Dependencies and Infrastructure

### npm packages

| Package | Where | Size | Purpose |
|---------|-------|------|---------|
| `@mozilla/readability` | API | ~50KB | Article content extraction |
| `linkedom` | API | ~40KB | DOM implementation for Workers |
| `dompurify` | Web | ~15KB | HTML sanitization for reader view |
| `vite-plugin-pwa` | Web (dev) | - | Service worker generation |
| `idb` | Web | ~3KB | IndexedDB Promise wrapper |

Total runtime addition to the web bundle: ~18KB (DOMPurify + idb). Minimal.

### Cloudflare infrastructure

| Resource | Purpose | Cost |
|----------|---------|------|
| R2 bucket (`url-keep-images`) | Store article images for offline reading | ~$0.01/month at personal scale |
| D1 database (existing) | Article content text/HTML in new `article_content` table | Included in existing plan |

## 13. Trade-offs and Alternatives Considered

### Client-side extraction (rejected)

Could have the extension extract article content using the live DOM and send it with the save request. Benefits: no server-side fetching, reuses existing extension script injection. Rejected because:
- Only works for extension saves, not web paste or iOS Shortcut.
- Large payloads on save requests (sending full article HTML).
- Extension popup would need to stay open longer for extraction.
- Two codepaths to maintain if server-side extraction is still needed for other save paths.

### Cloudflare Queues for async extraction (deferred)

Could use Cloudflare Queues to decouple extraction from the save request entirely. Benefits: better reliability, automatic retries, no CPU pressure on the save Worker. Deferred because:
- `waitUntil()` is sufficient for a single-user app with low save volume.
- Adds infrastructure complexity (Queue binding, consumer Worker).
- Can upgrade to Queues later if `waitUntil()` proves unreliable.

### Markdown storage instead of HTML (rejected)

Could convert extracted content to Markdown for smaller storage and simpler rendering. Rejected because:
- Readability.js outputs HTML natively; conversion adds a dependency and lossy step.
- HTML preserves semantic structure (tables, figures) better than Markdown.
- DOMPurify sanitization is well-understood and battle-tested.
- Storage savings are marginal vs the added conversion complexity.

### Full offline-first with CRDTs (rejected)

Could build a fully offline-first app where all data lives locally and syncs to the server. Rejected because:
- Massive increase in complexity for a single-user tool.
- Server is the source of truth; the client is a cache. This is simpler and correct.
- CRDT libraries add significant bundle size and conceptual overhead.
- The simpler "server-wins" sync model is sufficient for this use case.

### Client-side-only image caching without R2 (rejected)

Could skip R2 entirely and have the service worker cache images directly from third-party URLs using `no-cors` fetch. Rejected because:
- Opaque responses are padded to ~7MB each for quota purposes, quickly exhausting the origin's storage budget.
- "Cache on view" requires the user to manually open every article before going offline.
- Third-party image URLs go stale over time (CDN tokens expire, sites reorganize), so images saved months ago may no longer load.
- R2 is essentially free at personal-use scale ($0.015/GB/month) and solves all three problems.

## 14. Security Considerations

- **Server-side fetch**: The Worker now fetches arbitrary URLs submitted by the user. This is safe because:
  - Only authenticated requests trigger extraction.
  - Single-user app - the user controls what URLs are saved.
  - The Worker is on Cloudflare's network, not the user's home network, so SSRF to internal services isn't a concern.
  - Response bodies are capped at 5MB. Individual images capped at 2MB.
- **Image proxy**: The `/v1/images/` endpoint is unauthenticated but secure:
  - R2 keys contain UUIDs and SHA-256 hashes — unguessable without knowing the bookmark ID and original image URL.
  - The images are from public web pages and contain no private data.
  - Adding auth would require injecting Authorization headers into every `<img>` request, significantly complicating the service worker for negligible benefit.
  - Immutable cache headers prevent repeated requests.
- **Image content validation**: Only responses with `image/*` Content-Type are stored. Size limits (100 bytes min, 2MB max) filter out tracking pixels and excessively large files. SVGs are excluded to avoid potential XSS vectors in SVG markup.
- **Content sanitization**: All HTML rendered in the reader view goes through DOMPurify. No raw `content_html` is ever rendered without sanitization. This prevents XSS from malicious article content. Image `src` attributes are whitelisted; the client resolves relative `/v1/images/` paths against `API_ORIGIN` before rendering.
- **IndexedDB**: Stores article content locally. This is the user's own data on their own device. No special encryption needed beyond what the browser provides.
- **Service worker scope**: Limited to the web app origin. Cannot intercept requests to other sites.
- **Privacy improvement**: After extraction, article images are served from your own API domain instead of third-party CDNs. Reading an article (offline or online) no longer leaks your reading activity to every image host in the article.
- **Offline mode is read-only**: No mutation queue means no risk of conflicting writes, stale auth tokens replaying bad requests, or data loss from partial queue replays.

## 15. Open Questions

1. **Auto-extract vs opt-in**: Should every saved bookmark trigger extraction automatically, or should the user explicitly request it? This plan assumes auto-extract. An opt-in model would reduce server-side fetching but add friction. Recommendation: auto-extract, with the ability to disable in settings later.

2. **Retention policy**: Should extracted content expire? For a single-user personal tool, probably not. But a "clear offline cache" button in the profile page would be useful.

3. **Content updates**: If an article changes after extraction, should we ever re-extract? Probably not automatically. A manual "re-extract" action on the reader view is sufficient.

4. **Storage indicator**: Should the app show how much offline storage is being used? Useful but not critical for v1 of this feature. Can add to the profile page later.
