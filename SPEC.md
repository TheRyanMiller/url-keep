# URL Keep Specification

## 1. Purpose

`url-keep` is a single-user bookmark keeper with four clients:

- a public HTTPS API
- a minimal web app
- a Chrome / Brave extension
- an iOS Shortcut that can save directly to the API

The product is intentionally narrow:

- save a URL
- un-save a URL
- browse saved URLs
- search saved URLs
- edit bookmark titles
- manage tokens

Everything else is out of scope for v1.

## 2. Locked V1 Decisions

- Single-user only.
- Managed hosting first.
- Backend on Cloudflare Workers + D1.
- Web app must be static and deployable on Vercel or Cloudflare Pages.
- Auth is email + password login, with opaque bearer tokens.
- No OAuth.
- No server-side metadata scraping.
- Preview images are allowed only when a client supplies `image_url` at save time.
- UI is strict black-and-white monospace with no decorative styling.
- Un-save means hard delete.
- Manual paste-to-save is part of the web app.
- Titles are editable after save.
- Extension popup auto-closes after a successful save or un-save.

## 3. Recommended Tech Choices

These choices are part of the implementation spec, not optional suggestions.

### API

- Runtime: Cloudflare Workers
- HTTP framework: Hono
- Validation: Zod
- Database: Cloudflare D1
- Password hashing: scrypt
- Token hashing: SHA-256 with server-side pepper

### Web app

- React
- TypeScript
- Vite
- React Router
- Plain CSS

Do not use Tailwind or a component library for v1.

### Browser extension

- Chrome Manifest V3
- TypeScript
- Plain HTML/CSS/TS popup
- No React unless build simplicity clearly improves

### Shared packages

- shared request/response types
- shared Zod schemas where practical
- shared API client for web app and extension

## 4. Repo Layout

```text
/apps/api
/apps/api/src
/apps/api/migrations
/apps/web
/apps/web/src
/apps/extension
/apps/extension/src
/packages/api-client
/packages/shared
/DESIGN_DOC.md
/STYLEGUIDE.md
/SPEC.md
```

## 5. Product Scope

### 5.1 In scope

- password login
- bearer-token auth
- token creation and revocation
- save current tab from extension
- un-save current tab from extension
- paste URL into web app and save
- browse bookmarks in the web app
- search bookmarks in the web app
- edit bookmark titles in the web app
- delete bookmarks in the web app
- mobile `/save` page
- iOS Shortcut direct-save flow
- optional preview images when provided by clients

### 5.2 Out of scope

- multi-user accounts
- signup
- password reset
- passkeys
- OAuth providers
- tags
- folders
- notes
- archive/history
- import/export in v1
- native mobile app
- Android share target in v1
- server-side metadata scraping
- article parsing

## 6. Data Model

All timestamps are ISO 8601 UTC strings.

All primary keys are `crypto.randomUUID()` strings.

### 6.1 SQL schema

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_access_tokens_user_active
  ON access_tokens(user_id, revoked_at, created_at DESC);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL,
  image_url TEXT,
  site_name TEXT,
  saved_via TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(user_id, normalized_url),
  CHECK (title_source IN ('fallback', 'client', 'user')),
  CHECK (saved_via IN ('web', 'mobile_web', 'extension', 'ios_shortcut'))
);

CREATE INDEX idx_bookmarks_user_created
  ON bookmarks(user_id, created_at DESC);

CREATE INDEX idx_bookmarks_user_normalized_url
  ON bookmarks(user_id, normalized_url);
```

### 6.2 Field rules

### `users`

- exactly one row exists in v1
- no registration endpoint
- the row is created by a one-time bootstrap script

### `access_tokens`

- stores the single bearer-token primitive used by the whole product
- web login creates a token named `web app`
- extension login creates a token named `browser extension`
- Shortcut tokens are created manually from the web app
- `token_hash` stores only a hash of the bearer token, never the plaintext token
- revoked tokens remain in the table for auditability

There is no separate concept of sessions versus named tokens in v1.

Login-issued tokens and manually created tokens are the same access-token object, created through different flows.

### `bookmarks`

- `url` stores the original submitted URL
- `normalized_url` is used for uniqueness and lookup
- `title` is always stored
- `title_source` tracks whether the title came from:
  - server fallback
  - client-supplied metadata
  - a user edit
- if create request omits `title`, the server fills it with hostname or normalized URL and marks `title_source = 'fallback'`
- if create request provides `title`, the server stores it and marks `title_source = 'client'`
- if the user edits a title, the server updates it and marks `title_source = 'user'`
- `image_url` is optional
- `site_name` is optional
- `saved_via` records which client first created the bookmark
- `saved_via` never changes after first create

`title_source` is internal server metadata.

Clients do not send it, and the API does not need to expose it in normal responses.

## 7. URL Normalization

Normalization must be deterministic and conservative.

### Algorithm

1. Trim surrounding whitespace.
2. Parse using the standard `URL` constructor.
3. Reject any scheme other than `http:` or `https:`.
4. Lowercase protocol and hostname.
5. Remove default ports:
   - `:80` for `http`
   - `:443` for `https`
6. Remove the fragment.
7. If pathname is empty, use `/`.
8. Preserve pathname, query string, and trailing slash behavior.
9. Serialize back to a string.

### Examples

- `HTTPS://Example.com#x` -> `https://example.com/`
- `https://example.com/path?a=1#top` -> `https://example.com/path?a=1`
- `https://example.com:443/a` -> `https://example.com/a`

Do not strip tracking parameters in v1.

## 8. Authentication Model

### 8.1 Passwords

- Passwords are hashed with scrypt.
- Only the bootstrap admin user exists.
- No signup route exists.

### 8.2 Bearer tokens

- All authenticated clients use `Authorization: Bearer <token>`.
- Tokens are opaque random strings, not JWTs.
- Token format should be human-distinct, for example `uk_<random>`.
- Generate at least 32 bytes of randomness before encoding.
- Store `sha256(token + TOKEN_PEPPER)` in `access_tokens.token_hash`.

### 8.3 Token lifecycle

- `POST /v1/auth/login` creates a new bearer token and returns it.
- `POST /v1/auth/logout` revokes the current bearer token.
- `POST /v1/tokens` creates a named token and returns plaintext once.
- `DELETE /v1/tokens/:id` revokes a token.

### 8.4 Current-token behavior

- The API auth middleware resolves the current token row on each request.
- The middleware attaches `user_id` and `token_id` to request context.
- `last_used_at` should be updated on successful authenticated requests on a best-effort basis.
- to avoid unnecessary writes, update `last_used_at` at most once per token per hour

## 9. API Conventions

### 9.1 Base URL

- production: `https://api.url-keep.yourdomain.com`
- local: `http://127.0.0.1:<port>`

### 9.2 Content type

- request bodies: `application/json`
- response bodies: `application/json`

### 9.3 Success response shape

Use plain JSON objects. Keep nesting shallow.

Examples:

```json
{
  "user": {
    "email": "me@example.com"
  },
  "token": "uk_xxx"
}
```

```json
{
  "item": {
    "id": "..."
  }
}
```

### 9.4 Error response shape

All non-204 errors should use:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "URL must be http or https"
  }
}
```

### 9.5 Status code rules

- `200` for successful reads and updates
- `201` for newly created records
- `204` for successful deletes and logout
- `400` for invalid input
- `401` for missing or invalid auth
- `404` for not found
- `409` for conflict if needed
- `429` for login rate limiting

## 10. API Endpoints

### 10.1 `GET /health`

Unauthenticated health endpoint.

Response:

```json
{
  "ok": true
}
```

### 10.2 `POST /v1/auth/login`

Creates a bearer token for the calling client.

Request body:

```json
{
  "email": "me@example.com",
  "password": "secret",
  "client_name": "web app"
}
```

Rules:

- `email` must match the single admin user
- `password` must verify against `users.password_hash`
- `client_name` is required and should be set by the client
- recommended values:
  - web app: `web app`
  - extension: `browser extension`

Response:

```json
{
  "user": {
    "id": "u_123",
    "email": "me@example.com"
  },
  "token": "uk_xxx",
  "token_info": {
    "id": "t_123",
    "name": "web app",
    "created_at": "2026-03-09T22:00:00.000Z"
  }
}
```

### 10.3 `POST /v1/auth/logout`

Auth required.

Behavior:

- revoke the current token
- return `204`

### 10.4 `GET /v1/auth/me`

Auth required.

Response:

```json
{
  "user": {
    "id": "u_123",
    "email": "me@example.com"
  },
  "token_info": {
    "id": "t_123",
    "name": "web app"
  }
}
```

### 10.5 `GET /v1/tokens`

Auth required.

Returns active, non-revoked tokens for the user.

Sort order:

- current token first
- otherwise newest first by `created_at DESC`

Response:

```json
{
  "items": [
    {
      "id": "t_123",
      "name": "web app",
      "created_at": "2026-03-09T22:00:00.000Z",
      "last_used_at": "2026-03-09T22:10:00.000Z",
      "current": true
    }
  ]
}
```

### 10.6 `POST /v1/tokens`

Auth required.

Creates a named access token, primarily for iOS Shortcut.

Request body:

```json
{
  "name": "iphone shortcut"
}
```

Rules:

- `name` is required
- trim whitespace
- max length `80`

Response:

```json
{
  "item": {
    "id": "t_456",
    "name": "iphone shortcut",
    "created_at": "2026-03-09T22:12:00.000Z",
    "last_used_at": null,
    "current": false
  },
  "token": "uk_xxx"
}
```

The plaintext `token` must never be returned again after creation.

### 10.7 `DELETE /v1/tokens/:id`

Auth required.

Rules:

- revoke the specified token
- return `404` if token does not exist
- return `400` if attempting to revoke the current token

Use `POST /v1/auth/logout` for the current token instead.

### 10.8 `GET /v1/bookmarks`

Auth required.

Query params:

- `q` optional search string
- `limit` optional, default `50`, max `100`
- `cursor` optional opaque cursor

Sort order:

- newest first by `created_at DESC, id DESC`

Search behavior:

- case-insensitive substring match against:
  - `title`
  - `url`
  - `site_name`

Response:

```json
{
  "items": [
    {
      "id": "b_123",
      "url": "https://example.com/article",
      "normalized_url": "https://example.com/article",
      "title": "Example article",
      "image_url": "https://example.com/og.jpg",
      "site_name": "Example",
      "saved_via": "extension",
      "created_at": "2026-03-09T22:20:00.000Z",
      "updated_at": "2026-03-09T22:20:00.000Z"
    }
  ],
  "next_cursor": null
}
```

Cursor format:

- implementation may use base64 of `created_at|id`
- cursor is an API detail and must be opaque to clients

### 10.9 `GET /v1/bookmarks/by-url?url=...`

Auth required.

Behavior:

- normalize the supplied URL
- look up by `user_id + normalized_url`
- return `404` if missing

Response:

```json
{
  "item": {
    "id": "b_123",
    "url": "https://example.com/article",
    "normalized_url": "https://example.com/article",
    "title": "Example article",
    "image_url": "https://example.com/og.jpg",
    "site_name": "Example",
    "saved_via": "extension",
    "created_at": "2026-03-09T22:20:00.000Z",
    "updated_at": "2026-03-09T22:20:00.000Z"
  }
}
```

### 10.10 `POST /v1/bookmarks`

Auth required.

Request body:

```json
{
  "url": "https://example.com/article",
  "title": "Example article",
  "image_url": "https://example.com/og.jpg",
  "site_name": "Example",
  "saved_via": "extension"
}
```

Validation:

- `url` required
- `url` must be valid `http` or `https`
- `title` optional, max length `300`
- `site_name` optional, max length `120`
- `image_url` optional, must be absolute `https` URL if present
- `saved_via` required and must be one of:
  - `web`
  - `mobile_web`
  - `extension`
  - `ios_shortcut`

Create behavior:

- normalize the URL
- if `title` is present and non-empty after trimming:
  - store trimmed title
  - set `title_source = 'client'`
- otherwise:
  - fill title with hostname or normalized URL
  - set `title_source = 'fallback'`
- create bookmark and return `201`

Duplicate behavior:

- if bookmark already exists for the normalized URL:
  - do not create a second row
  - keep `saved_via` unchanged
  - if existing `title_source` is `user`, keep existing `title` unchanged
  - if existing `title_source` is `fallback` and incoming `title` is present and non-empty, replace the title and set `title_source = 'client'`
  - if existing `title_source` is `client`, keep existing `title` unchanged
  - if existing `image_url` is null and incoming `image_url` is present, fill it
  - if existing `site_name` is null and incoming `site_name` is present, fill it
  - update `updated_at`
  - return `200`

This keeps user edits authoritative while still allowing a later client save to upgrade a placeholder title.

### 10.11 `PATCH /v1/bookmarks/:id`

Auth required.

Request body:

```json
{
  "title": "New title"
}
```

Rules:

- `title` required
- trim whitespace
- must be non-empty after trimming
- max length `300`
- set `title_source = 'user'`

Response:

```json
{
  "item": {
    "id": "b_123",
    "title": "New title"
  }
}
```

### 10.12 `DELETE /v1/bookmarks/by-url?url=...`

Auth required.

Behavior:

- normalize supplied URL
- delete matching bookmark if present
- return `204` whether or not it existed

This makes extension un-save idempotent.

## 11. Preview Metadata Rules

The server must never fetch remote bookmark URLs in v1.

Preview metadata is client-supplied only.

### Allowed client-supplied fields

- `title`
- `image_url`
- `site_name`

### Source-specific expectations

- web paste form: usually only `url`
- mobile web `/save`: usually only `url`
- iOS Shortcut: `url`, sometimes `title`
- extension: `url`, usually `title`, sometimes `image_url` and `site_name`

### Image rules

- store only remote image URLs
- accept only absolute `https` image URLs
- if image fails to load in the UI, hide it
- no server-side proxy

Privacy tradeoff:

- viewing bookmarks with remote images will make the browser request those third-party image URLs
- this is acceptable for v1

## 12. Web App Specification

### 12.1 Routes

- `/login`
- `/`
- `/save`
- `/settings/tokens`

### 12.2 Global app behavior

- store bearer token in `localStorage`
- on app start:
  - if token exists, call `GET /v1/auth/me`
  - if `401`, clear token and route to `/login`
- all authenticated API calls use the shared API client
- keep the search query mirrored to the `q` URL parameter

### 12.3 `/login`

UI:

- email input
- password input
- `log in` button

Behavior:

- submit to `POST /v1/auth/login`
- send `client_name: "web app"`
- on success, store token and route to `/`

### 12.4 `/`

This is the main bookmark screen.

### Top area

- URL input for manual paste-to-save
- `save` button
- search input
- link to token settings
- `log out` action

### Save form behavior

- single URL input only
- do not ask for title at create time
- submit as:

```json
{
  "url": "...",
  "saved_via": "web"
}
```

- on success:
  - clear the input
  - prepend or refetch the list

### Bookmark list behavior

- initialize the search input from the `q` URL parameter
- update the `q` URL parameter as the search input changes
- fetch newest-first bookmarks
- support search via `q`
- show optional preview image when `image_url` exists
- clicking title opens bookmark in a new tab
- open links with `rel="noopener noreferrer"`

### Row layout

Desktop:

- left column: date + saved-via label
- middle column: title + domain
- right column: optional image + actions

Mobile:

- stacked layout
- title first
- image optional
- actions as plain text buttons

### Row actions

- `open`
- `edit`
- `delete`

### Edit-title behavior

- clicking `edit` turns the title into an input
- show `save` and `cancel` actions
- Enter saves
- Escape cancels
- successful save calls `PATCH /v1/bookmarks/:id`

### Delete behavior

- delete calls `DELETE /v1/bookmarks/by-url?url=...`
- a simple confirm step is acceptable
- on success, remove row from local state

### 12.5 `/save`

This is the mobile-friendly save page.

Behavior:

- read `?url=...` query param if present
- prefill the URL input
- submit to `POST /v1/bookmarks` with `saved_via: "mobile_web"`
- if not logged in, redirect to `/login` and then back to `/save`

### 12.6 `/settings/tokens`

UI:

- list active tokens
- create token form
- revoke token action
- one-time display area for newly created token
- short instructions for iOS Shortcut setup

Behavior:

- `GET /v1/tokens` on load
- `POST /v1/tokens` to create named tokens
- `DELETE /v1/tokens/:id` to revoke non-current tokens

### 12.7 Visual style

`STYLEGUIDE.md` is the authoritative reference for visual presentation across the web app, mobile `/save` page, and extension popup.

If this section and `STYLEGUIDE.md` ever diverge, follow `STYLEGUIDE.md` for UI decisions and update this spec to match.

Required look:

- white background
- black text
- black borders
- monospace font stack
- divider-led structure instead of heavy cards
- no gradients
- no shadows
- no rounded corners beyond browser defaults unless required
- no icons unless they clearly reduce text clutter
- preview images stay visually subordinate to text

Recommended font stack:

```css
font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
```

Use plain CSS variables:

```css
:root {
  --bg: #ffffff;
  --fg: #000000;
  --border: #000000;
  --muted: #666666;
}
```

Implementation note:

- prefer row dividers over card grids
- keep the main content width constrained and document-like
- keep controls text-led and plain

## 13. Extension Specification

### 13.1 Manifest

Required permissions:

- `activeTab`
- `scripting`
- `storage`

No host permissions are required for v1.

### 13.2 Popup states

- unauthenticated
- loading active tab
- unsupported page
- saved
- not saved
- request in progress
- error

### 13.3 Unsupported pages

The extension must refuse to operate on non-HTTP pages such as:

- `chrome://`
- `brave://`
- `edge://`
- `about:`
- `file://`

### 13.4 Login flow

- popup shows email + password form if no token
- submit to `POST /v1/auth/login` with `client_name: "browser extension"`
- store returned token in `chrome.storage.local`

### 13.5 Saved-state check

On popup open:

1. get active tab
2. validate the URL is `http` or `https`
3. call `GET /v1/bookmarks/by-url?url=...`
4. if `200`, show `unsave`
5. if `404`, show `save`

### 13.6 Metadata extraction

When saving, inject a tiny function into the active page to read:

- `document.title`
- `meta[property="og:image"]`
- `meta[property="og:site_name"]`

Rules:

- resolve relative `og:image` values against the page URL
- ignore non-HTTPS image URLs
- if extraction fails, continue without preview metadata

### 13.7 Save flow

Request body:

```json
{
  "url": "https://example.com/article",
  "title": "Example article",
  "image_url": "https://example.com/og.jpg",
  "site_name": "Example",
  "saved_via": "extension"
}
```

Behavior:

- on success, call `window.close()`
- on failure, keep popup open and show text error

### 13.8 Un-save flow

- call `DELETE /v1/bookmarks/by-url?url=...`
- on success, call `window.close()`

### 13.9 Popup UI

Minimal text UI only:

- current domain
- current saved state
- one primary action button
- link to open full web app
- optional error line

The popup should also follow `STYLEGUIDE.md`, adapted to a tighter surface.

## 14. iOS Shortcut Specification

### 14.1 Setup

The user creates a token in `/settings/tokens`, then adds that token to the Shortcut.

Suggested token name:

- `iphone shortcut`

### 14.2 Shortcut input

- accepts a shared URL from the iOS share sheet

### 14.3 Shortcut request

Method:

- `POST`

URL:

- `https://api.url-keep.yourdomain.com/v1/bookmarks`

Headers:

- `Authorization: Bearer <token>`
- `Content-Type: application/json`

Body:

```json
{
  "url": "shared-url-here",
  "saved_via": "ios_shortcut"
}
```

If iOS provides title text, the Shortcut may include:

```json
{
  "url": "shared-url-here",
  "title": "optional title",
  "saved_via": "ios_shortcut"
}
```

### 14.4 Shortcut UX

- on success, show `saved`
- on failure, show the API error message if available

## 15. Deployment Specification

### 15.1 API

- deploy to Cloudflare Workers
- attach one D1 database
- configure custom domain for production

Required environment variables:

- `APP_ORIGIN`
- `API_ORIGIN`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD_HASH`
- `TOKEN_PEPPER`
- `ALLOWED_EXTENSION_ORIGINS`

Notes:

- `ADMIN_PASSWORD_HASH` is used by the bootstrap script to seed the single user
- `ALLOWED_EXTENSION_ORIGINS` should be a comma-separated allowlist like `chrome-extension://abc123,chrome-extension://def456`

### 15.2 Web app

- must produce a static build
- must be deployable on Vercel or Cloudflare Pages
- default production target should be Cloudflare Pages if choosing one vendor is operationally simpler

Runtime config:

- `VITE_API_ORIGIN`

### 15.3 CORS

Allow:

- `APP_ORIGIN`
- each origin from `ALLOWED_EXTENSION_ORIGINS`
- local dev web origin, if configured

Allow methods:

- `GET`
- `POST`
- `PATCH`
- `DELETE`
- `OPTIONS`

Allow headers:

- `Authorization`
- `Content-Type`

The API remains publicly reachable.

### 15.4 Bootstrap

Implementation must include a one-time bootstrap path for the single admin user.

Recommended approach:

- provide a script in `apps/api/scripts`
- script inserts the single admin row if absent
- script uses `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH`

## 16. Security and Privacy

- Passwords use scrypt.
- Access tokens are stored only as hashes.
- All traffic is HTTPS only.
- Login endpoint must be rate-limited.
- Cloudflare rate limiting on `/v1/auth/login` is acceptable and preferred over custom app logic.
- Web app uses a strict CSP.
- Links open with `noopener noreferrer`.
- Images load directly from third-party hosts only when `image_url` exists.
- Use `referrerpolicy="no-referrer"` on image elements.

## 17. Testing Requirements

### 17.1 API automated tests

Must cover:

- URL normalization
- login success and failure
- bearer-token auth
- bookmark create
- duplicate bookmark upsert behavior
- fallback-title upgrade behavior
- `saved_via` immutability on duplicate saves
- title edit behavior
- delete by URL idempotency
- token creation and revocation

### 17.2 Web app checks

Must verify:

- login works
- manual paste save works
- search works
- title edit works
- delete works
- token creation UI works
- mobile `/save` route works

### 17.3 Extension checks

Must verify:

- login works
- saved-state detection works
- save works on a normal `https` page
- un-save works
- popup auto-closes on success
- unsupported-page state works

### 17.4 iOS Shortcut check

Must verify:

- token-created shortcut can save a shared URL successfully

## 18. Acceptance Criteria

The implementation is complete for v1 when all of the following are true:

1. A single admin user can log into the web app with email and password.
2. The web app can save a pasted URL.
3. The web app lists bookmarks newest first.
4. The web app can search bookmarks by title, URL, or site name.
5. The web app can edit bookmark titles.
6. The web app can delete bookmarks.
7. The web app can create and revoke tokens.
8. The extension can log in directly with email and password.
9. The extension can detect whether the current page is already saved.
10. The extension can save the current page in one click.
11. The extension can un-save the current page in one click.
12. The extension popup closes automatically after a successful save or un-save.
13. The iOS Shortcut can save a shared URL directly to the API with a token.
14. The UI stays black-and-white, monospace, and low-friction.
15. No server-side remote metadata fetching exists anywhere in the v1 codepath.

## 19. Implementation Order

Build in this order:

1. Create repo scaffolding and shared packages.
2. Implement D1 schema and bootstrap script.
3. Implement API auth and token routes.
4. Implement bookmark routes and normalization logic.
5. Build the web app login flow.
6. Build the web app bookmark list, manual save, title edit, and delete.
7. Build the token settings page.
8. Build the mobile `/save` route.
9. Build the extension login and save-state check.
10. Build extension save/un-save and auto-close.
11. Document and test the iOS Shortcut flow.

## 20. Explicit Non-Requirements

Do not add these during v1 implementation unless requirements change:

- SSR
- background jobs
- server-side scraping
- Pocket-style article extraction
- design system package
- analytics
- email
- onboarding flow beyond login
- websocket updates
- offline sync
