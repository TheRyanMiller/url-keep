# url-keep

Minimal self-hostable reading-list app with:

- Cloudflare Worker API + D1
- simple React web app
- Chrome/Brave extension popup
- iOS Shortcut-compatible token flow

## Workspaces

- `apps/api`: Hono API for auth, tokens, and bookmarks
- `apps/web`: minimal monochrome web UI
- `apps/extension`: MV3 browser extension popup
- `packages/shared`: shared schemas and types
- `packages/api-client`: typed API client used by web and extension

## Local setup

1. Install dependencies:

```sh
npm install
```

2. Create a D1 database:

```sh
cd apps/api
npx wrangler d1 create url_keep
cd ../..
```

3. Update [`apps/api/wrangler.toml`](/Users/wavey/code/url-keep/apps/api/wrangler.toml) with the returned `database_id`.

4. Apply the schema:

```sh
npm run d1:migrate:local
```

5. Create local API env vars:

```sh
cp apps/api/.dev.vars.example apps/api/.dev.vars
```

6. Create web env vars:

```sh
cp apps/web/.env.example apps/web/.env
```

7. Bootstrap the single admin user:

```sh
npm run bootstrap:admin -- you@example.com --local
```

The script will prompt for a password and insert the single allowed user into the local D1 database.

For local dev, keep origins consistent. The simplest setup is:

- web app: `http://localhost:5173`
- API: `http://localhost:8787`

If your browser lands on `127.0.0.1:5173` instead, `APP_ORIGIN` can include both values as a comma-separated list.

## Local development

Run the API:

```sh
npm run dev:api
```

Wrangler reads [`apps/api/wrangler.toml`](/Users/wavey/code/url-keep/apps/api/wrangler.toml) automatically here because the API workspace command runs inside `apps/api`.

Run the web app:

```sh
npm run dev:web
```

The web app defaults to `http://localhost:5173`.

## Extension

Build the extension:

```sh
URL_KEEP_API_ORIGIN=http://localhost:8787 \
URL_KEEP_APP_ORIGIN=http://localhost:5173 \
npm run build:extension
```

Load [`apps/extension/dist`](/Users/wavey/code/url-keep/apps/extension/dist) as an unpacked extension in Chrome or Brave.

The build-time origins only seed the defaults. The popup now includes a `settings` view where you can change:

- API origin
- app origin

Those overrides are stored in `chrome.storage.local`, so you can repoint the extension to a different deployment without rebuilding it.

After Chrome assigns an extension ID, add that origin to `ALLOWED_EXTENSION_ORIGINS` in [`apps/api/.dev.vars`](/Users/wavey/code/url-keep/apps/api/.dev.vars), for example:

```env
ALLOWED_EXTENSION_ORIGINS=chrome-extension://abcdefghijklmnopabcdefghijklmnop
```

## Verification

Run the full workspace checks:

```sh
npm run test
npm run build
npm run typecheck
```

## Production

The simplest production shape is:

- API on Cloudflare Workers
- database on Cloudflare D1
- web app on Vercel
- optional custom domains like `api.yourdomain.com` and `app.yourdomain.com`

### 1. Choose your production origins

Pick the exact public URLs first. Example:

- app: `https://app.example.com`
- api: `https://api.example.com`

You can also use the default `*.workers.dev` URL for the API first and add a custom domain later.

### 2. Set production Worker config

`TOKEN_PEPPER` must be a Worker secret:

```sh
npx wrangler secret put TOKEN_PEPPER --config apps/api/wrangler.toml
```

`APP_ORIGIN` and `ALLOWED_EXTENSION_ORIGINS` are normal Worker vars. Add them to [`apps/api/wrangler.toml`](/Users/wavey/code/url-keep/apps/api/wrangler.toml):

```toml
[vars]
APP_ORIGIN = "https://app.example.com"
ALLOWED_EXTENSION_ORIGINS = ""
```

If you later load the extension in Chrome/Brave, update `ALLOWED_EXTENSION_ORIGINS` to include its extension origin, for example:

```toml
[vars]
APP_ORIGIN = "https://app.example.com"
ALLOWED_EXTENSION_ORIGINS = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
```

### 3. Apply remote database migrations

```sh
npm run d1:migrate:remote
```

### 4. Deploy the API

```sh
npm run deploy:api
```

After deploy, Wrangler will print the Worker URL. If you have not attached a custom domain yet, this will be your `*.workers.dev` origin.

### 5. Bootstrap the production admin user

Run the same admin bootstrap script without `--local`:

```sh
npm run bootstrap:admin -- you@example.com
```

This inserts the single allowed user into the remote D1 database.

### 6. Deploy the web app to Vercel

This repo is an npm-workspaces monorepo, so the Vercel project should use the repo root, not `apps/web`, otherwise the web app cannot access shared workspace packages in [`packages/`](/Users/wavey/code/url-keep/packages).

This repo includes [`vercel.json`](/Users/wavey/code/url-keep/vercel.json) so React Router deep links like `/login`, `/save`, and `/settings/tokens` work correctly on Vercel.

Recommended Vercel project settings:

- Root Directory: `.`
- Build Command: `npm run build --workspace @url-keep/web`
- Output Directory: `apps/web/dist`
- Environment Variable: `VITE_API_ORIGIN=https://api.example.com`

You can deploy through the Vercel dashboard by importing the repo, or with the CLI:

```sh
vercel
vercel --prod
```

### 7. Build the production extension

```sh
URL_KEEP_API_ORIGIN=https://api.example.com \
URL_KEEP_APP_ORIGIN=https://app.example.com \
npm run build:extension
```

Load or publish the built extension, note its extension ID, then add that origin to `ALLOWED_EXTENSION_ORIGINS` and redeploy the API.

If you later move the API or web app to a new domain, you can update the extension from its popup `settings` view instead of rebuilding it, as long as the target API allows the extension origin in `ALLOWED_EXTENSION_ORIGINS`.

### 8. Create your iOS Shortcut token

Once the web app is live, log in, create a token under `/settings/tokens`, and use that token in your Shortcut against:

```text
POST https://api.example.com/v1/bookmarks
```

## iOS Shortcut

Create a token in the web app under `/settings/tokens`, then configure an iOS Shortcut to:

1. accept a shared URL from the share sheet
2. send `POST /v1/bookmarks`
3. include `Authorization: Bearer <token>`
4. send JSON:

```json
{
  "url": "<shared url>",
  "saved_via": "ios_shortcut"
}
```

That keeps the Shortcut thin and lets the API handle normalization, dedupe, and fallback titles.
