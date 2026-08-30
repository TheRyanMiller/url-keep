# Architecture

url-keep has one API contract, one D1 schema, one IndexedDB read model, and one narration path. It favors bounded, eventually consistent reconciliation over coordination machinery.

## System boundary

```text
capture client ───────► URL Keep Worker ───────► D1 source of truth
                             │                         │
                             │ bounded plaintext       │ revision + manifest
                             ▼                         ▼
                    narration service          IndexedDB read model
                             │                         │
                             │ authenticated stream    │ immutable body hydrate
                             ▼                         ▼
                    URL Keep audio route          React reader
                             │
                      verified cache / Blob URL
```

The narration service owns synthesis, its queue, canonical MP3s, and recovery. It receives exact plaintext plus its SHA-256. It never receives a source URL, HTML, user identity, browser token, callback, or product database access.

URL Keep owns bookmark and article identity, service-job orchestration, authorization, cleanup delivery, offline policy, sharing, and playback URLs. D1 stores narration identity and integrity metadata, never MP3 bytes or storage paths.

## Capture and immutable articles

`POST /bookmarks` creates metadata only. It never starts hidden background extraction.

Chrome/Brave runs Readability in the active tab and uploads the readable result. Safari first creates bookmark metadata, then sends bounded raw DOM to `PUT /bookmarks/:id/capture`. The raw DOM is parsed and sanitized in memory and is never logged or persisted. Server extraction is an explicit synchronous fallback with one global budget of four external fetches, at most two manual redirects, and URL validation after every redirect.

Article images remain sanitized absolute HTTPS URLs. The server does not fetch or mirror new images. The existing R2 read route remains only for already-mirrored legacy objects.

`article_content.id` identifies an immutable generation. A successful replacement conditionally verifies the observed generation, deletes it, inserts the new generation, updates eligible bookmark metadata, revokes public sharing, and cascades narration invalidation. Client title precedence is `user > client > server > fallback`.

Failed or skipped client and server extraction never replaces an existing complete generation. An existing complete server generation is returned without fetching unless extraction is explicitly forced; a forced failure still preserves the complete generation.

## Read model and reconciliation

D1 is the source of truth. IndexedDB is the PWA read model:

- `bookmarks` contains the complete local bookmark snapshot;
- `article_meta` contains bounded metadata keyed by bookmark ID;
- `article_bodies` contains sanitized HTML keyed by immutable article ID;
- `sync_meta` contains the accepted revision and check timestamps;
- `audio_settings` and `offline_audio` own offline-audio policy and its ledger.

Reconciliation is single-flight within a tab:

1. read `GET /sync/revision`;
2. if it equals the accepted revision, refresh the last-check timestamp, reload IndexedDB into React, and hydrate missing bodies;
3. otherwise page `GET /sync/manifest` with a maximum page size of 100;
4. reject duplicate bookmarks, duplicate article identities, or malformed cursor progress;
5. read the ending revision;
6. if revisions differ, retry the whole snapshot once;
7. atomically replace bookmarks, metadata, narration summaries, and sync state only for a stable snapshot;
8. hydrate missing bodies with at most two concurrent requests and garbage-collect obsolete bodies in chunks of 25.

The equality-path reload is intentional: another tab may already have committed the accepted revision while an older mutation response updated this tab's React state. Reloading IndexedDB prevents an indefinitely stale UI without locks, broadcasts, or a cross-tab protocol.

The IndexedDB v1→v2 upgrade clears remotely reproducible records and offline audio, preserves `audio_settings`, and lets the next stable reconciliation repopulate data. Blocked upgrades close old connections and surface an explicit UI notice.

## Narration state and races

One narration belongs to exactly one article generation:

```text
pending ─────► ready
   │             │
   └────────────► failed
```

Create and retry derive bounded NFC plaintext, hash its exact UTF-8 bytes, commit a pending D1 row, and synchronously issue the idempotent service `PUT`. Every service `PUT` attempt—including an ambiguous transport failure—is followed by a D1 identity check. If the narration row no longer belongs to the same current article generation, URL Keep upserts the service job into `narration_cleanup_jobs`, returns `409 article_changed`, and never recreates the deleted narration row.

Each narration status GET performs at most one service GET. Service absence returns `submission_required`; a visible client may issue the idempotent PUT once. The PWA polls after 5, 10, then repeated 15-second delays and aborts while hidden.

Article replacement and deletion cascade the D1 narration row and enqueue the service job for cleanup. Retry also enqueues the superseded job. Sync and relevant mutation requests attempt at most one due cleanup DELETE. Success removes the outbox entry; failure increments bounded backoff state.

## Playback and authorization

Bearer authentication protects every private bookmark, article, narration, and audio route. Public shares expose neither narration state nor audio.

The audio route authorizes through the current bookmark/article relationship and streams the service response without buffering it. It forwards only `Range`, `If-Range`, and `If-None-Match`, validates identity, checksum, duration, byte size, and engine fingerprint against D1, and returns bounded response headers. Missing or invalid canonical audio demotes the narration to retryable `audio_missing`.

The browser never receives the service token or a direct service URL. Offline audio is accepted only after declared and computed SHA-256 plus byte length match. The cache entry is written before its ledger row; playback always uses a revocable Blob URL.

## Public sharing

Public share metadata and HTML use separate no-store routes. Metadata contains the immutable `article_id` but not the body. The body route returns sanitized `text/html` with `nosniff`, `noindex`, and an identity ETag. Reads perform no database writes. Replacing or deleting article content revokes the share.

## Security and resource properties

- Raw capture DOM is transport-only and excluded from logs.
- Browser credentials never reach the narration service or media cache keys.
- Plaintext, HTML, URLs, titles, audio, and credentials are excluded from structured logs.
- Request bodies, stored HTML, extraction fetches, redirects, manifest pages, hydration concurrency, cleanup work, narration retries, and error codes are bounded.
- The private article-body query is scoped by both user ID and immutable article ID.
- Authentication resolves token and user in one joined lookup.
- D1 constraints encode legal narration states, while unique article, service-job, token, and outbox identities make retries idempotent.
- No cron, Web Push, lock service, Durable Object, or cross-tab coordination protocol is required.

## Deployment boundaries

The product API is one Cloudflare Worker with D1 and a legacy article-image R2 read binding. It has no scheduled trigger and no explicit paid CPU ceiling. The PWA is a static deployment.

The narration service is independently deployed and independently recoverable. Product deployments do not restart it, and narration-service deployments do not restart URL Keep.
