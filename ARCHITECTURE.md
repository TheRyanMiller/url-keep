# Architecture

This document describes the shipped url-keep system. It is a private, single-user, text-first reading list; it is not a crawler platform, collaboration product, or offline mutation system.

## System shape

```text
Chrome/Brave tab ─ Readability HTML upload ───────────┐
Safari Shortcut ─ live DOM ─ server Readability ─────┤
URL-only save ─ server fetch ─ server Readability ───┤
                                                     └─ sanitized article + metadata
                                                           │
                                      D1 bookmarks/articles/share state
                                                           │
                                   internal reader ─ IndexedDB reconciliation
                                                           │
                                      app shell + R2 image Cache Storage
```

The durable asset is the readable snapshot. Capture source changes acquisition, not storage, sync, or rendering.

## Clients and capture

The React web app saves pasted or shared URLs. Reader-capable URL-only saves create a pending article and queue a Worker fetch.

The Chrome/Brave extension uses a two-request workflow. Its popup upserts the bookmark, then an MV3 service worker injects bundled Readability into the active tab, resolves article links/images, and uploads the result. `activeTab` and `scripting` authorize page injection; the generated manifest separately grants only the configured API origin for cross-origin requests. Capture/upload failure asks the API for one server fallback unless complete client content already exists.

The iPhone Shortcut has two branches. Safari webpages send `captured_page: { html, base_url }`; other share inputs send URL metadata only. The Safari source measures the exact JSON and removes `captured_page` above 4.5 MiB. Raw DOM is transport-only and is never logged or stored.

Server and Safari documents share the same extraction core: validate an HTTP(S) base, parse, run Readability, require 100 readable characters, absolutize links/images, sanitize, bound metadata, count words, and enforce the stored-byte limit. Safari snapshots are marked `content_source = "client"` because the browser supplied the authenticated page.

## Persistence and precedence

D1 stores users, access tokens, bookmarks, article content, share state, migration state, and per-user offline revisions. Article HTML is not included in bookmark-list responses.

Store operations distinguish client content, server content, server failures, and deletion. Every server write uses SQL-level compare-and-swap and refuses to replace a complete client article. Client recaptures are last committed write wins. Bookmark title/site metadata is updated in the same D1 batch as the winning article generation:

- user titles are immutable to capture;
- client capture may replace fallback or prior client titles;
- server extraction may replace only fallback titles and keeps `title_source = "fallback"`;
- site name is filled only when absent.

Failed explicit recapture preserves complete content. Lost writes cannot update bookmark metadata or share state.

D1 triggers revoke active public shares inside the article insert/update/delete transaction. Public sharing remains an explicit publishing action; replacing content never republishes it automatically.

## Limits and sanitization

- Capture request: 5 MiB, counted from the actual request stream before JSON parsing.
- Client preflight: 4.5 MiB for exact serialized JSON.
- Stored sanitized HTML: 1,500,000 UTF-8 bytes.
- Title/site/author/published date: 300/120/300/100 characters.

The API and reader use adapters around one shared tag, attribute, scheme, and external-link policy. Ingestion is authoritative; render-time DOMPurify is defense in depth. Scripts, event handlers, forms, frames, SVG, unsafe schemes, data attributes, styles, and unsupported markup are removed. Article links open in a new tab with `noopener noreferrer`.

No path forwards publisher cookies, stores raw captured DOM, or caches authenticated JSON in Cache Storage.

## Article images

Server extraction mirrors eligible public images to R2 under:

```text
articles/{bookmarkId}/{generationId}/{hash}
```

New image URLs use `/v1/images/articles/:bookmarkId/:generationId/:hash`; the legacy two-segment route remains for existing articles. A winning server generation removes obsolete generations. A losing or failed attempt removes only its own generation. Client replacement and article deletion may remove the full bookmark prefix. Cleanup is best-effort and never rolls back readable text.

Subscriber-page images keep their original URLs and may be unavailable offline. Text is the guarantee; browser cookies and base64 image archives are out of scope.

## Offline reconciliation

Private offline state belongs to IndexedDB. `offline_sync_state.revision` advances through D1 triggers for material bookmark/article changes, including article-only state transitions; share counters do not advance it.

A foreground reconciliation:

1. reads `{ bookmark_count, sync_revision }` with `cache: "no-store"`;
2. fetches the complete bundle in pages of at most 10 items;
3. reads status again;
4. commits a full bookmark/article replacement plus local revision in one IndexedDB transaction only when start/end identity and count agree;
5. retries one moving snapshot immediately, then leaves local revision stale for the next trigger;
6. warms article images without making image success part of text correctness.

`syncOnce` is single-flight. Foreground triggers are mount, network restoration, visible-after-stale, and successful mutations. There is no polling timer, background sync, service-worker bearer token, incremental feed, tombstone protocol, or offline write queue.

Explicit logout or an authenticated `401` clears private IndexedDB state, in-memory auth, and the article-image cache. Network errors and `5xx` responses do not. The versioned app shell remains available for login.

## Reader and PWA behavior

One pure resolver drives both bookmark title and primary action:

- complete + online → internal `/read/:id` in the current tab;
- complete + offline + local article → internal reader;
- complete + offline + missing local article → disabled/unavailable;
- pending/failed/skipped/video/non-reader + online → publisher source in a new tab;
- the same items offline → disabled/unavailable.

Readers load IndexedDB first, then may fetch authenticated content online with `cache: "no-store"`. Missing content never silently redirects to a publisher. **Read on web** is explicit and disabled offline.

Standalone mode is detected after mount with iOS `navigator.standalone` or `(display-mode: standalone)`. Installed app screens gain a quiet Refresh icon; reader screens also gain Share. Private readers share the original bookmark URL and public readers share the canonical public URL. This never enables public sharing. Ordinary browser tabs render neither redundant control. The logo only navigates home.

## Deployment boundaries

The API is a Cloudflare Worker with D1 and R2 bindings. The web app is a Vercel-hosted static SPA with an injected service worker. Extension and Shortcut artifacts are distributed separately after the compatible API/web rollout.

Migrations are additive. Rollback is code-only; do not drop offline revision tables or article/share triggers to roll back a release.
