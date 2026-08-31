# url-keep

url-keep is a private, single-user reading list with immutable article snapshots, a quiet reader, optional narration, and verified offline media.

The repository contains:

- `apps/api`: Hono Worker, D1 state, bounded extraction, narration orchestration, and authenticated media streaming;
- `apps/web`: React PWA, IndexedDB snapshot sync, reader, and offline audio;
- `apps/extension`: Chrome/Brave MV3 live-page capture;
- `packages/api-client`: the typed API client;
- `packages/shared`: schemas, limits, URL classification, and sanitization policy;
- `shortcuts`: the iPhone Shortcut capture source and setup.

Speech synthesis and canonical narration storage live in an independently deployed private service. URL Keep sends that service only bounded plaintext and owns product state, authorization, cleanup delivery, offline policy, and playback URLs.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the data flow and [STYLEGUIDE.md](./STYLEGUIDE.md) for the visual constraints.

## Requirements

- Node.js 22+
- npm 10+
- Cloudflare Workers, D1, and the existing article-image R2 bucket
- a static host for the PWA
- an HTTPS narration-service origin and URL Keep tenant token

The runtime is compatible with Workers Free: it has no cron trigger or explicit paid CPU limit, and every request performs bounded work.

```sh
npm install
```

## Local development

Create local configuration and apply the schema migrations:

```sh
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/web/.env.example apps/web/.env.local
npm run d1:migrate:local
```

Set these private Worker values:

- `TOKEN_PEPPER`: a long random access-token pepper;
- `NARRATION_SERVICE_TOKEN`: the URL Keep tenant credential for the narration service.

Public configuration lives in `apps/api/wrangler.toml`: application origins, extension origins, the narration-service origin, D1, the legacy image R2 binding, and the custom domain.

Bootstrap the account and run both processes:

```sh
npm run bootstrap:admin -- you@example.com --local
npm run dev:api
npm run dev:web
```

The default API and PWA origins are `http://localhost:8787` and `http://localhost:5173`.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm audit --audit-level=low
```

Always validate migrations from an empty D1 state rather than relying only on a previously migrated local database:

```sh
npx wrangler d1 migrations apply DB \
  --local \
  --persist-to /path/to/empty-directory \
  --config apps/api/wrangler.toml
```

The tests cover immutable replacement, content preservation, metadata/body separation, stable manifest reconciliation, the IndexedDB v1→v2 cutover, narration submission races, authenticated streaming, cleanup, and offline media integrity.

## Capture clients

Saving a URL creates bookmark metadata only. Article content then comes from one explicit path:

- the extension submits a bounded live DOM for canonical server extraction, falling back once to server URL extraction;
- the Safari Shortcut posts bookmark metadata, then sends the bounded live DOM as a separate raw `text/html` request, falling back to server extraction when capture is unavailable;
- the PWA can request bounded server extraction.

Captured DOM and fetched HTML converge on the same API-owned Readability, metadata, URL-resolution, and sanitization pipeline. Capture clients do not select or persist article content themselves.

Raw DOM is transport-only. Publisher cookies never leave the browser tab.

Build the extension for production:

```sh
URL_KEEP_API_ORIGIN=https://api.url-keep.com \
URL_KEEP_APP_ORIGIN=https://www.url-keep.com \
npm run build:extension
```

Create Shortcut credentials from `/settings`, then follow [shortcuts/README.md](./shortcuts/README.md).

## Synchronization and offline reading

The PWA treats IndexedDB as its read model. Reconciliation reads a small revision, pages a metadata-only manifest, verifies the ending revision, and atomically replaces the local snapshot only when the revision is stable. It retries one unstable snapshot and preserves the last accepted snapshot if the second attempt is also unstable.

Article bodies are fetched separately by immutable article ID with at most two concurrent requests. A revision-equality exit still reloads IndexedDB into React, so a response arriving out of order cannot leave a tab stale after another tab committed the current snapshot.

The `url-keep` IndexedDB v2 upgrade intentionally clears v1 bookmarks, article bodies, sync metadata, and offline audio while preserving the user's audio setting. The next reconciliation repopulates canonical data.

## Narration and offline audio

A complete private article can request one narration. Create and retry submit synchronously to the private service. While visible, the PWA polls through URL Keep at 5, 10, then 15-second intervals; polling stops while hidden. A missing service job causes at most one idempotent resubmission.

Ready audio streams from the narration service through the authenticated URL Keep API with byte-range support. If offline audio is enabled, the PWA verifies length and SHA-256 before committing an immutable cache response and its matching IndexedDB ledger row. Playback uses a revocable Blob URL, so bearer credentials never appear in media URLs or cache keys.

Deletion uses `narration_cleanup_jobs`. Ordinary sync and mutation traffic attempts at most one due cleanup job; failures remain durable with bounded backoff.

Settings expose offline-audio controls plus account and API-token controls. URL Keep has no Web Push or notification subsystem.

## API shape

The API has one unversioned contract:

- mutation responses return the authoritative bookmark plus bounded article metadata;
- `GET /sync/revision` and paginated `GET /sync/manifest` drive reconciliation;
- private and public article bodies use separate raw-HTML endpoints keyed by immutable identity;
- old bookmark-list, offline-status, offline-bundle, and JSON body-read routes do not exist;
- public share reads do not write counters or extend TTLs.

There are no compatibility adapters, dual browser-storage paths, or old-route redirects.

## Deployment

Back up D1 before deployment. For an existing installation, first import every ready narration object into the narration service and verify its service job is `ready`.

Release A is a coordinated cutover because migration `0002_service_owned_narration.sql` removes Push tables, share counters, and product-owned narration storage columns:

1. verify the independent narration service and tenant credential;
2. enter a short maintenance window and take a D1 backup;
3. apply all pending D1 migrations;
4. deploy the matching Worker immediately;
5. verify authentication, sync revision/manifest, narration create/poll/audio, and one cleanup delivery;
6. deploy the PWA, then rebuild the extension and Shortcut;
7. allow browsers to perform the IndexedDB v2 upgrade and reconcile.

```sh
npm run d1:migrate:remote
npm run deploy:api
npm run build:web
```

Do not edit an already-applied migration. Production migration and deployment are deliberate operator actions and are not performed by the test suite.
