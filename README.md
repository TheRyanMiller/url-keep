# url-keep

url-keep is a private, single-user reading list that saves readable article snapshots for offline use. Complete articles open in the internal reader; the publisher page remains an explicit **Read on web** action.

The repository contains:

- `apps/api`: Hono Worker, D1 persistence, Readability extraction, and R2 images.
- `apps/web`: React PWA, reader, and IndexedDB reconciliation.
- `apps/extension`: Chrome/Brave MV3 capture extension.
- `packages/api-client`: typed client shared by the web app and extension.
- `packages/shared`: API schemas, limits, URL classification, and sanitizer policy.
- `shortcuts`: source and setup for the iPhone Safari Shortcut.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for system behavior and [STYLEGUIDE.md](./STYLEGUIDE.md) for the intentionally minimal visual language.

## Requirements

- Node.js 22+
- npm 10+
- A Cloudflare account with Workers, D1, and R2
- A Vercel project for the web app

Install dependencies:

```sh
npm install
```

## Local development

Create local configuration:

```sh
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/web/.env.example apps/web/.env.local
npm run d1:migrate:local
```

Set a long random `TOKEN_PEPPER` in `apps/api/.dev.vars`. Bootstrap or replace the local account password:

```sh
npm run bootstrap:admin -- you@example.com --local
```

Run the API and web app in separate terminals:

```sh
npm run dev:api
npm run dev:web
```

The defaults are `http://localhost:8787` for the API and `http://localhost:5173` for the web app.

## Verification

The root commands cover every workspace that has a test or build script:

```sh
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

Before applying new migrations remotely, verify the complete migration chain against an empty local D1 persistence directory:

```sh
npx wrangler d1 migrations apply DB \
  --local \
  --persist-to /path/to/empty-directory \
  --config apps/api/wrangler.toml
```

## Browser extension

Build for local development:

```sh
URL_KEEP_API_ORIGIN=http://localhost:8787 \
URL_KEEP_APP_ORIGIN=http://localhost:5173 \
npm run build:extension
```

Then load `apps/extension/dist` as an unpacked extension in Chrome or Brave. Add the resulting `chrome-extension://...` origin to `ALLOWED_EXTENSION_ORIGINS` and restart the API.

For production:

```sh
URL_KEEP_API_ORIGIN=https://api.url-keep.com \
URL_KEEP_APP_ORIGIN=https://www.url-keep.com \
npm run build:extension
```

The generated manifest grants cross-origin access only to the configured API origin. Runtime API-origin changes require a build whose manifest grants that origin; production does not request blanket HTTPS access.

The popup saves the bookmark, then its MV3 worker injects Readability into the active tab and uploads sanitized article input. If capture fails, the worker requests one server extraction fallback. Publisher cookies never leave the tab.

## iPhone Shortcut

Create an API token from the profile page, then follow [shortcuts/README.md](./shortcuts/README.md). The Safari branch runs the source-controlled `capture-page.js`, submits the live DOM, and downgrades to URL/title metadata when the serialized request exceeds 4.5 MiB. Shares from other apps remain URL-only.

Set `VITE_IOS_SHORTCUT_URL` only after publishing and testing the matching iCloud Shortcut. The profile page shows the install link when that variable is present.

## PWA and offline use

Install the web app through the browser’s **Add to Home Screen** flow. IndexedDB stores private bookmarks and article HTML; Cache Storage owns only the app shell and article images.

Installed standalone mode adds two quiet pieces of missing browser chrome to the existing header:

- Refresh reloads the page.
- Share appears only in readers. Private readers share the publisher URL; public readers share their public URL.

Ordinary browser tabs do not render these controls. Offline mode is read-only.

## Configuration

API secrets in `apps/api/.dev.vars` or Cloudflare:

- `TOKEN_PEPPER`: required token-hashing secret.
- `APP_ORIGIN`: comma-separated allowed web origins.
- `ALLOWED_EXTENSION_ORIGINS`: comma-separated extension origins.
- `DEBUG_LOGS`: optional structured diagnostics; captured HTML and tokens are never logged.

Web build variables:

- `VITE_API_ORIGIN`: deployed API origin.
- `VITE_IOS_SHORTCUT_URL`: optional published Shortcut URL.

Extension build variables:

- `URL_KEEP_API_ORIGIN`: exact API origin emitted into `host_permissions`.
- `URL_KEEP_APP_ORIGIN`: web-app origin used by extension links.

## Deployment

Deploy in compatibility order:

1. Apply additive D1 migrations.
2. Deploy the API.
3. Deploy the web app and service worker.
4. Build/distribute the extension.
5. Publish the Shortcut and then update its install URL.

```sh
npm run d1:migrate:remote
npm run deploy:api
npm run build:web
vercel --prod
```

The Vercel project must expose `VITE_API_ORIGIN` and, if used, `VITE_IOS_SHORTCUT_URL` at build time. Cloudflare configuration lives in `apps/api/wrangler.toml`; secrets stay outside Git.

After deployment, verify `/health`, authenticated bookmark capture, `/v1/offline/status`, reader routing, and the installed PWA controls. Old extension and URL-only Shortcut clients remain valid during rollout.
