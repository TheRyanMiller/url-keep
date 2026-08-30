# url-keep

url-keep is a private, single-user reading list with immutable article snapshots, a quiet reader, optional narration, and verified offline media.

The repository contains:

- `apps/api`: Hono Worker, D1 state, extraction, private R2 media, narration reconciliation, and Web Push;
- `apps/web`: React PWA, reader, full-snapshot IndexedDB sync, and offline audio;
- `apps/extension`: Chrome/Brave MV3 page capture;
- `packages/api-client`: the current typed API client;
- `packages/shared`: exact schemas, limits, URL classification, and sanitization policy;
- `shortcuts`: the iPhone Shortcut source and setup.

Speech synthesis is not part of this repository. The Worker sends final plaintext to the independently deployed private narration service described in `~/yearn/narration-service`. URL Keep owns its product state, durable MP3s, notifications, authorization, and offline playback.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for system behavior and [STYLEGUIDE.md](./STYLEGUIDE.md) for the visual constraints.

## Requirements

- Node.js 22+
- npm 10+
- Cloudflare Workers, D1, and two private R2 buckets
- a Vercel project for the PWA
- an HTTPS narration-service origin and URL Keep tenant token

```sh
npm install
```

## Local development

Create local configuration and apply the single baseline schema:

```sh
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/web/.env.example apps/web/.env.local
npm run d1:migrate:local
```

Set these private values in `apps/api/.dev.vars`:

- `TOKEN_PEPPER`: a long random access-token pepper;
- `NARRATION_SERVICE_TOKEN`: the raw URL Keep product credential;
- `VAPID_PRIVATE_KEY`: the Web Push P-256 private key.

The public/configured values live in `apps/api/wrangler.toml`: application origins, narration-service origin, VAPID public key and subject, and the explicit push-provider host allowlist.

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

Validate the baseline from an empty D1 state, not a previously migrated local database:

```sh
npx wrangler d1 migrations apply DB \
  --local \
  --persist-to /path/to/empty-directory \
  --config apps/api/wrangler.toml
```

The API integration tests exercise the current D1 schema, immutable article replacement, service publication, R2 integrity contract, cascade invalidation, and cleanup outbox.

## Capture clients

Build the extension for production:

```sh
URL_KEEP_API_ORIGIN=https://api.url-keep.com \
URL_KEEP_APP_ORIGIN=https://www.url-keep.com \
npm run build:extension
```

Load `apps/extension/dist` as an unpacked extension or distribute that build. Its manifest grants only the configured API origin. The extension uploads a Readability capture from the active tab and requests one server extraction if capture fails. Publisher cookies never leave the tab.

Create Shortcut credentials from `/settings`, then follow [shortcuts/README.md](./shortcuts/README.md). Safari sends the live DOM only as bounded transport input; URL-only shares remain URL-only.

## Narration and offline audio

A complete private article can request one narration. The Worker derives bounded plaintext, creates an idempotent service job, and a once-per-minute scheduled handler publishes verified output into the private `url-keep-narrations` bucket. The browser never sees the service credential.

Ready audio is fetched through the authenticated API. If offline audio is enabled, the PWA verifies its length and SHA-256 before committing a synthetic immutable response to the `url-keep-audio` cache and its matching IndexedDB ledger row. The native audio element plays a Blob URL; no bearer token is placed in a media URL or service worker.

Settings expose only:

- offline-audio enablement, usage, limit, and clear;
- notification enablement for the current browser;
- account and API-token controls.

## Configuration

Worker secrets:

- `TOKEN_PEPPER`;
- `NARRATION_SERVICE_TOKEN`;
- `VAPID_PRIVATE_KEY`.

Worker configuration:

- `APP_ORIGIN` and `ALLOWED_EXTENSION_ORIGINS`;
- `NARRATION_SERVICE_ORIGIN`;
- `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, and `PUSH_PROVIDER_HOSTS`;
- `DEBUG_LOGS` for content-free structured diagnostics.

Web build variables:

- `VITE_API_ORIGIN`;
- optional `VITE_IOS_SHORTCUT_URL`.

The API has one unversioned contract. There are no old-route redirects, payload normalizers, password-hash fallbacks, schema adapters, or dual browser-storage paths.

## Clean deployment

This is a destructive greenfield cutover. Back up any data worth retaining, then recreate D1 from `0001_init.sql`; do not apply the old migration chain or preserve its migration history.

1. Verify the independent narration service and its URL Keep tenant credential.
2. Create the private `url-keep-narrations` R2 bucket.
3. Create a fresh D1 database from the single baseline and update its binding ID.
4. Set the three Worker secrets.
5. Deploy the Worker, including its once-per-minute scheduled trigger.
6. Bootstrap the single account.
7. Build and deploy the PWA to Vercel.
8. Clear prior URL Keep site data on installed browsers, then log in again.
9. Rebuild the extension and Shortcut against the unversioned endpoints.

```sh
npm run d1:migrate:remote
npm run deploy:api
npm run build:web
vercel --prod
```

Acceptance covers health and authentication, capture and immutable replacement, offline text/images, narration request through durable playback, notification enrollment, verified offline audio, deletion cleanup, and operation with the narration service unavailable.
