# URL Keep Design Doc

## Summary

`url-keep` is a personal bookmark keeper focused on one job: save URLs quickly from anywhere and view them later from a clean reading list.

The design goal is to keep v1 extremely small:

- one authenticated API
- one bookmarks table
- one web UI
- one browser extension
- one direct iOS Shortcut save flow
- client-supplied preview metadata only
- no background workers, no scraping pipeline, no social features

## Product Goals

- Save or un-save the current page in one click from Chrome or Brave.
- Browse and manage saved links from a simple web app.
- Allow manually pasting a URL into the web app to save it.
- Save a link from a phone with as little friction as possible.
- Show a preview image when a client can provide one at save time.
- Keep hosting and operations lightweight.
- Keep the product intentionally single-user and personal.

## Non-Goals For V1

- Multi-user support
- Teams or sharing
- Native mobile app
- Full-text article extraction
- Highlights, annotations, folders, tags, or recommendations
- Complex sync logic
- OAuth with Google, GitHub, etc.

## Design Principles

- Single-user first. This is a personal tool, so optimize for simplicity over generality.
- Managed infra first. Prefer removing server maintenance over maximizing portability on day one.
- Minimal auth surface. Avoid OAuth and email flows in v1.
- Same API for every client. Web, extension, and mobile should all talk to one backend.
- Store only what we need. URL, title, timestamps, saved-via information, and optional client-provided preview fields.
- UI should be text-first: monospace, black and white, no decorative UI.
- Never fetch remote page metadata on the server in v1.

## Recommended V1 Architecture

### Primary recommendation

Use Cloudflare for the backend and keep the web UI deployable on Vercel or Cloudflare Pages:

- API server: Cloudflare Workers
- Database: Cloudflare D1
- Web app: static React app deployable to Vercel or Cloudflare Pages
- Browser extension: Chrome Manifest V3
- Mobile: mobile web save page plus direct iOS Shortcut / optional Android share flow

Why this is the best default:

- no VPS management
- no database server to patch
- very low cost at small scale
- fast enough for a personal bookmark app
- easy public HTTPS endpoints for extension and mobile clients

Operational default:

- if you want the fewest moving parts, deploy both API and web on Cloudflare
- if you prefer Vercel for frontend ergonomics, the web app should still deploy there cleanly

## Core User Flows

### 1. Browser save flow

1. User logs into the extension once.
2. Extension reads the current tab URL and title.
3. Extension asks the API whether the URL is already saved.
4. User clicks `Save` or `Unsave`.
5. Extension calls the API.
6. On success, the popup auto-closes.

### 2. Web app flow

1. User logs into the web app.
2. User can paste a URL to save it manually.
3. Web app fetches bookmarks from the API.
4. Web app shows bookmarks in a simple columnar view.
5. User can search, open, edit titles, or delete bookmarks.

### 3. Mobile save flow

V1 should avoid a native app.

Required MVP flows:

1. User shares a URL from iOS into an iOS Shortcut.
2. The Shortcut sends the shared URL directly to the API using a device token.
3. The API stores the bookmark and returns success.

Fallback flow:

1. User opens `url-keep`'s mobile save page with the shared URL prefilled.
2. User taps `Save`.

Optional faster flow after v1:

- Android share target or installed PWA

## Authentication

### Decision

Use simple password login with long-lived device tokens.

### Why

OAuth is not worth the complexity for a single-user personal tool.

### Model

- One admin user for v1
- Username or email + password login
- Password stored as a scrypt hash
- Server issues opaque tokens, not JWTs
- Each client stores its own token
  - web app: local storage
  - extension: browser extension storage
  - iOS Shortcut: per-device API token stored in the Shortcut or Keychain-backed storage when available

### Tradeoff

This is less strict than HTTP-only cookie sessions, but much simpler when:

- the web app is hosted on Vercel
- the API is on a different domain
- the extension and mobile flow need the same auth model

For a single-user personal tool, this is an acceptable v1 tradeoff. If security requirements increase later, move the web app behind the same domain and switch the browser UI to cookie sessions.

## Data Model

Keep the schema minimal.

### `users`

- `id`
- `email`
- `password_hash`
- `created_at`

### `access_tokens`

- `id`
- `user_id`
- `name`
- `token_hash`
- `created_at`
- `last_used_at`
- `revoked_at`

### `bookmarks`

- `id`
- `user_id`
- `url`
- `normalized_url`
- `title`
- `title_source`
- `image_url` nullable
- `site_name` nullable
- `saved_via`
- `created_at`
- `updated_at`

Constraint:

- unique index on `user_id + normalized_url`

Delete semantics:

- un-saving a URL deletes the bookmark record completely
- no archive state and no history table in v1

### URL normalization

Keep this conservative in v1:

- trim whitespace
- lowercase scheme and host
- remove fragment (`#...`)

Do not try to aggressively strip query params in v1. It creates surprising behavior.

## Preview Metadata

Preview metadata is optional and client-supplied only.

### Rule

- the server never fetches bookmark URLs to discover metadata
- clients may send metadata they can already see locally
- bookmarks saved without preview metadata should still look clean in the UI

### Expected sources

- browser extension: can capture `document.title`, `og:image`, and `og:site_name` from the active page
- iOS Shortcut: may provide URL and title, depending on the share payload
- manual paste in the web app: usually URL only

### Failure behavior

- if no preview image is available, show no image
- if no title is available, display the normalized domain or URL
- titles should remain editable in the web app after save
- fallback titles should be replaceable by a later client-supplied title until the user edits them

## API Shape

Keep the API small and boring.

### Auth

- `POST /v1/auth/login`
- `POST /v1/auth/logout`
- `GET /v1/auth/me`

### Bookmarks

- `GET /v1/bookmarks`
  - supports `q`, `limit`, `cursor`
- `GET /v1/bookmarks/by-url?url=...`
- `POST /v1/bookmarks`
- `PATCH /v1/bookmarks/:id`
- `DELETE /v1/bookmarks/by-url?url=...`

`POST /v1/bookmarks` should accept:

- `url` required
- `title` optional
- `image_url` optional
- `site_name` optional
- `saved_via` required

`PATCH /v1/bookmarks/:id` should accept:

- `title` required

### Token management

- `GET /v1/tokens`
- `POST /v1/tokens`
- `DELETE /v1/tokens/:id`

## Web App

### Scope

- login screen
- manual paste-to-save input
- bookmark list
- search box
- inline or simple edit-title action
- delete button
- token management page for extensions and mobile shortcuts

### Visual language

- monospace typography everywhere
- black text on white background
- white cards or rows with black borders only
- no gradients, rounded corners, shadows, or decorative color
- preview images appear only when the client supplied them at save time

### Layout

Use a text-forward columnar layout instead of a feed of glossy cards.

Recommended desktop layout:

- left: saved date and saved-via label
- middle: title and domain
- right: preview image when available, plus open, edit, and delete actions

Recommended mobile layout:

- stacked rows with title first
- preview image is optional and can be omitted entirely when absent
- actions stay purely textual

### Stack

Prefer a small React TypeScript app. Vite is enough for v1.

Reasons:

- fewer framework concerns
- can deploy cleanly to Vercel or Cloudflare Pages
- stays mostly static
- easy to share API client code with the extension

## Browser Extension

### Scope

- login form
- current-tab saved / unsaved state
- one-click toggle
- link to open the full web app
- auto-close popup after a successful save or un-save

### Implementation notes

- Chrome Manifest V3
- popup UI only
- use `activeTab` and a tiny injected script at click time to read page title and OG tags
- store auth token with `chrome.storage.local`
- request only the minimal permissions needed:
  - `activeTab`
  - `scripting`
  - `storage`

## Mobile

### Recommendation

Do not build a native iOS or Android app for v1.

Build:

- a mobile-friendly `/save` page in the web app
- iOS Shortcut instructions and token creation UI
- a direct API save endpoint that is easy to call from Shortcuts

This gives a useful mobile path without creating a second full client codebase.

### iOS Shortcut design

The Shortcut should:

1. accept a shared URL from the share sheet
2. send `POST /v1/bookmarks` with the URL and optional page title
3. authenticate with a dedicated device token
4. show a simple success or failure notification

This is intentionally better than forcing mobile users through a browser tab just to save one URL.

## Deployment

### Cloudflare setup

- `api.url-keep.yourdomain.com` -> Cloudflare Worker
- `app.url-keep.yourdomain.com` -> Vercel app or Cloudflare Pages
- D1 database attached to the Worker

This split is fine for v1. Separate `app.` and `api.` subdomains are operationally simple and still feel like one product.

### Environment variables

- `APP_ORIGIN`
- `API_ORIGIN`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD_HASH`
- `TOKEN_PEPPER`

### CORS

Allow only:

- `app.url-keep.yourdomain.com`
- extension origin IDs in production and local development

The API should be publicly reachable over HTTPS.

It needs to be reachable so the extension, web app, and iOS Shortcut can all use it from any device. Security should come from password auth, device tokens, rate limiting, and tight CORS for browser clients, not from hiding the API behind a private network.

## Security

- Rate-limit login attempts.
- Hash passwords with scrypt.
- Store only hashed device tokens.
- Use HTTPS everywhere.
- Keep CSP strict on the web app.

## Backups And Operations

- Export D1 data regularly.
- Keep bookmark data easy to dump as JSON or CSV.
- Add a simple health endpoint.
- Add structured logs for auth and bookmark writes.

## Suggested Repo Layout

```text
/apps/api
/apps/web
/apps/extension
/packages/api-client
/packages/shared
/DESIGN_DOC.md
```

## Phased Plan

### Phase 1

- API with auth and bookmark CRUD
- static web app deployable on Vercel or Cloudflare Pages
- Chrome / Brave extension
- mobile `/save` page
- iOS Shortcut direct-save flow
- manual paste-to-save in the web app
- editable bookmark titles
- token management UI
- optional client-supplied preview images for extension-saved bookmarks

### Phase 2

- export
- optional iOS Shortcut guide

### Phase 3

- optional PWA install support
- optional self-hosted VPS deployment path

## Final Recommendation

Build `url-keep` as a single-user system first.

The cleanest v1 is:

- Cloudflare Worker API
- Cloudflare D1 database
- static React web app deployable on Vercel or Cloudflare Pages
- Chrome Manifest V3 extension
- iOS Shortcut direct-save flow plus mobile web save page
- black-and-white monospace UI with simple columnar bookmark rows
- manual paste-to-save in the web app
- preview images only when clients can provide them directly
- public HTTPS API secured by password login and per-device tokens

That keeps the product focused, the infra light, and the first implementation small enough to finish quickly.
