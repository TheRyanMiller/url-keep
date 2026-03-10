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

Run the same admin bootstrap script with `--remote`:

```sh
npm run bootstrap:admin -- you@example.com --remote
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
- Optional Environment Variable: `VITE_IOS_SHORTCUT_URL=https://www.icloud.com/shortcuts/...`

`VITE_API_ORIGIN` must be a full absolute origin, including the protocol.

Correct:

- `https://api.url-keep.com`

Incorrect:

- `api.url-keep.com`
- `/api.url-keep.com`

`VITE_IOS_SHORTCUT_URL` is optional. If you publish a shared iCloud Shortcut link, setting this env var enables an `install shortcut` button in the token settings page.

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

Once the web app is live:

1. open `https://url-keep.com/settings/tokens`
2. in the `iphone shortcut` section, tap `create iphone token`
3. tap `copy token`
4. tap `install shortcut`

The token is only shown once.

Your Shortcut will send requests to:

```text
POST https://api.url-keep.com/v1/bookmarks
```

## iOS Shortcut

The easiest setup is a share-sheet Shortcut that sends the current page URL directly to the API.

This repo supports the best v1 UX:

- the app creates a token for you
- the app can link out to your published Shortcut template
- the Shortcut asks for the token once on first run
- after that, you use it from the share sheet like a native action

### What you are building

From Safari or another app on your iPhone:

1. tap `Share`
2. tap your Shortcut
3. the URL is sent to `url-keep`
4. you see a simple `saved` confirmation

### Step 1. Create the Shortcut

On your iPhone:

1. open the `Shortcuts` app
2. tap `+` to create a new shortcut
3. name it something like `Save to url-keep`

### Step 2. Make it show up in the share sheet

In the shortcut details/settings:

1. turn on `Show in Share Sheet`
2. set accepted input to `URLs`
3. if your iPhone offers `Safari Web Pages` as an accepted type, enable that too

The exact menu wording may vary slightly by iOS version, but the goal is:

- the shortcut appears in the iPhone share sheet
- it accepts shared links

### Step 3. Add the actions

Add these actions in this order:

1. `Get URLs from Input`
2. `Get Contents of URL`
3. `Show Notification`

If your iPhone shows `Shortcut Input` instead of `Input`, that is fine. They mean the same thing here.

### Step 4. Configure `Get Contents of URL`

Set the action up like this:

- URL: `https://api.url-keep.com/v1/bookmarks`
- Method: `POST`
- Headers:
  - `Authorization` = `Bearer YOUR_TOKEN_HERE`
  - `Content-Type` = `application/json`
- Request Body: `JSON`

Then set the JSON body fields to:

```json
{
  "url": "<output of Get URLs from Input>",
  "saved_via": "ios_shortcut"
}
```

In the Shortcuts UI, this means:

- key `url` should use the variable produced by `Get URLs from Input`
- key `saved_via` should be plain text: `ios_shortcut`

### Step 5. Configure the success message

For `Show Notification`, use something simple like:

- `saved to url-keep`

### Step 6. Test it

On your iPhone:

1. open a page in Safari
2. tap `Share`
3. tap `Save to url-keep`

The first time, iOS may ask for permission to contact `api.url-keep.com`.
Allow it.

If everything is correct, you should see:

- a `saved to url-keep` notification
- the new bookmark in the web app

### Troubleshooting

If it does not work:

- make sure the token is valid and copied exactly
- make sure the API URL is exactly `https://api.url-keep.com/v1/bookmarks`
- make sure the header is `Authorization: Bearer <token>`
- make sure the JSON body key is `url`, not `link`
- make sure `saved_via` is exactly `ios_shortcut`

### Technical reference

This is the request the Shortcut should make:

```http
POST https://api.url-keep.com/v1/bookmarks
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "url": "https://example.com/article",
  "saved_via": "ios_shortcut"
}
```

That keeps the Shortcut thin and lets the API handle normalization, dedupe, and fallback titles.
