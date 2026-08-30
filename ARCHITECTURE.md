# Architecture

url-keep is a private, single-user reading list. The design has one current API, one current D1 schema, one browser-storage schema, and one synthesis path.

## System boundary

```text
capture client ──► URL Keep Worker ──► D1 bookmarks/articles/narrations
                         │                         │
                         │ final plaintext         │ bounded reconciliation
                         ▼                         │
                 private narration service ◄──────┘
                         │ authenticated MP3 pull
                         ▼
                  private narration R2
                    │             │
                    ▼             ▼
             online Blob URL   verified browser cache
                    └──────┬──────┘
                           ▼
                    native audio element

ready D1 state ──► durable notification outbox ──► Web Push
```

The standalone narration service owns only its model, voice, encoder, compute queue, recovery, and temporary spool. It receives exact plaintext plus its SHA-256. It never receives a URL, HTML, user identity, browser token, callback, push subscription, or product database access.

URL Keep owns article identity, service-job orchestration, durable MP3s, authorization, deletion, push, offline policy, and playback. Centralizing synthesis does not centralize product state.

## Capture and immutable articles

Web URL saves use server Readability extraction. Chrome/Brave inject bundled Readability into the active tab. Safari Shortcut captures submit bounded DOM transport input. All paths resolve links, sanitize HTML, bound metadata and stored bytes, and persist only the readable result.

`article_content.id` identifies one immutable article generation. The extracted document title is stored with that generation; the bookmark title remains an editable library label. A successful replacement atomically:

1. verifies the expected current generation;
2. deletes that row;
3. inserts the new generation with a new ID;
4. updates winning bookmark metadata.

A failed recapture preserves existing complete content. Server writes never replace complete client content. Narrations reference the generation with `ON DELETE CASCADE`, so replacement and deletion invalidate audio without hash comparisons spread through the application.

Server-extracted public images use:

```text
articles/{bookmarkId}/{generationId}/{hash}
```

They are served only through `/images/articles/:bookmarkId/:generationId/:hash`. Winning generations remove obsolete image generations; losing attempts remove only their own files.

## Narration state

One narration can exist for an article generation:

```text
pending → publishing → ready
    │          │
    └──────────┴────► failed
```

The public API exposes `publishing` as `pending`. One explicit retry is available only for a small retryable error allowlist.

Requesting narration derives NFC plaintext from stored sanitized block content, excludes code/pre/table content, enforces 100,000 Unicode scalar values without truncation, and hashes the exact UTF-8 bytes. D1 commits the product row before the service call. A lost submission is repaired by repeating the same service PUT with the immutable article and job ID.

Reconciliation polls a bounded set once per minute. A ready service response is validated for ID, fingerprint, content type, known length, duration, and SHA-256. A `FixedLengthStream` writes it to:

```text
narrations/{narrationId}/{serviceJobId}.mp3
```

R2 validates the supplied SHA-256. D1 becomes ready only after the object exists. A five-minute publishing claim can be retried safely at the same reserved key. The service job is acknowledged after commit and otherwise expires after seven days.

Deleting or retrying a narration writes its service job ID and R2 key to one `narration_cleanup_jobs` outbox. Scheduled cleanup idempotently removes both. This single row prevents either store from becoming an untracked cleanup concern.

## API and authorization

All product routes are unversioned. Normal user bearer authentication protects bookmarks, narration status, audio, push configuration, subscriptions, and offline bundles. Public shares expose article HTML only and never narration state or media.

The audio route authorizes through the current article and bookmark, reads only the D1-reserved R2 key, and returns a complete MP3 with length, strong ETag, and SHA-256. Range and public bucket URLs are intentionally absent: the browser consumes one authenticated complete response before creating a Blob URL.

The private narration-service credential exists only in Worker secrets. Each product uses a distinct token; the service stores only token hashes.

## Web Push

One browser access token owns at most one push subscription. Enrollment requires an explicit Settings action. Endpoint URLs require HTTPS, no credentials, fragment, or custom port, and a hostname in the configured provider allowlist. Key material is structurally and cryptographically bounded before storage.

The notification table is both watcher set and durable outbox. Senders can see rows only after joining a committed ready narration. Success and terminal rejection delete the row; provider `404`/`410` deletes the subscription; transient failures use bounded retry delays within 24 hours. Push failure never changes audio readiness.

The service worker accepts one bounded `narration.ready` payload and a same-origin `/read/{id}#audio` path. It contains no bearer token and never caches authenticated API responses or audio.

## Offline ownership

IndexedDB stores bookmarks, article HTML, sync metadata, audio settings, and the offline-audio ledger. Cache Storage owns the versioned app shell, public article images, and verified MP3 bytes. Each concern has one owner.

Foreground text reconciliation reads the D1 revision and bookmark count, downloads a full paginated snapshot, rechecks identity, and atomically replaces IndexedDB only when the snapshot stayed stable. It retries one moving snapshot. There is no offline mutation queue, background bearer token, incremental event log, or tombstone protocol.

Only current ready narration metadata appears in the offline bundle. When enabled, audio download:

1. evicts audio-only LRU entries until the declared object fits;
2. fetches the authenticated complete response;
3. verifies content type, declared length, response hash header, byte length, and computed SHA-256;
4. writes the immutable synthetic cache response;
5. commits the ledger row last.

Playback always becomes a revocable Blob URL, preferring verified cached bytes. Disabling or clearing offline audio touches only the audio cache and ledger. Logout or authenticated `401` clears all private offline data while retaining device-local audio settings and the app shell.

## Security properties

- Raw captured DOM is transport-only and never logged or persisted.
- The shared sanitization policy removes scripts, events, forms, frames, SVG, active schemes, styling, and unsupported attributes.
- Browser credentials never reach the narration service or service worker media paths.
- Plaintext, HTML, URLs, titles, audio, credentials, push endpoints, and key material are excluded from logs.
- Queue, text, request, output, storage, reconciliation, notification, and cleanup limits bound work.
- D1 constraints encode legal narration states and safe error values.
- Unique article, service-job, audio-key, token, endpoint, and outbox identities make retries idempotent.
- Dependency audit, empty-schema application, typechecking, tests, production builds, and live smoke tests are release gates.

## Deployment boundaries

The URL Keep API is one Cloudflare Worker with D1, image R2, narration R2, and a scheduled trigger. The PWA is a Vercel static deployment. The extension and Shortcut are separately built clients of the same current contract.

The narration service is an independent repository, virtual environment, SQLite database, spool, model cache, API unit, worker unit, and release lifecycle on Electro. Deploying or restarting Wavey Gist or URL Keep does not restart it; deploying or restarting it does not restart either product.
