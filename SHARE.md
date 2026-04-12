# Public Share Links Plan

## 1. Overview

Add a public share link for saved articles so an authenticated user can share the clean reader view with someone who is not logged in.

The core requirement is simple:

- keep the existing private reader route, `/read/:id`, exactly as-is
- add a separate public route, `/s/:token`
- render the same reader content
- track a raw hit count in the database

This feature should stay small. It does not need social preview rendering, unique-visitor analytics, expiring links, or multiple share links per bookmark.

## 2. Chosen Shape

Use these routes:

- private reader: `/read/:id`
- public reader: `/s/:token`
- public API payload: `GET /v1/public/shares/:token`

Why `/s/:token`:

- short for copy/paste
- clearly separate from the private `/read/:id` route
- no need to support both `/s/:token` and `/share/:token` in v1

Keep `/read/:id` authenticated. Do not relax auth on the existing route.

## 3. Product Rules

These rules keep the feature clear and small:

1. One active public share link per bookmark.
2. A public share link is read-only.
3. Share links are only available when extraction is complete.
4. Public links should default to server-extracted content only.
5. Hit count is a simple raw count of successful public reads.
6. Revoking a share makes the old URL stop working immediately.

### 3.1 Why restrict to server content

This is the safest default.

`content_source === "client"` may contain content captured from a logged-in page, a paywalled page, or other private context. Making that publicly shareable should be a separate product decision, not the default behavior.

So the simplest clean rule is:

- allow share when `extraction_status === "complete"` and `content_source === "server"`
- return `409` for anything else

If later you intentionally want "publish my captured copy" behavior, that can be added explicitly.

## 4. Data Model

Do not add a new table for v1.

Because the product only needs one active share link per bookmark, the simplest implementation is to store the share state directly on the `bookmarks` row.

### 4.1 Migration

Create `apps/api/migrations/0004_bookmark_share.sql`:

```sql
ALTER TABLE bookmarks ADD COLUMN share_id TEXT;
ALTER TABLE bookmarks ADD COLUMN share_enabled_at TEXT;
ALTER TABLE bookmarks ADD COLUMN share_revoked_at TEXT;
ALTER TABLE bookmarks ADD COLUMN share_view_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookmarks ADD COLUMN share_last_accessed_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmarks_share_id
  ON bookmarks(share_id);
```

### 4.2 Notes

- Store a random `share_id` on the bookmark row.
- The public URL token is derived from that `share_id` plus a server-side signature using `TOKEN_PEPPER`.
- This lets the app re-derive the same share URL later without storing the full public token in D1.
- `share_id` is nullable because most bookmarks will never be shared.
- `share_view_count` is a raw integer counter.
- `share_last_accessed_at` gives one useful piece of owner-facing metadata without building analytics infrastructure.

## 5. API Design

Add three authenticated management endpoints and one unauthenticated read endpoint.

### 5.1 Authenticated share management

#### `GET /v1/bookmarks/:id/share`

Returns the current share state for the bookmark.

Response shape:

```json
{
  "item": {
    "enabled": true,
    "share_url": "https://www.url-keep.com/s/uk_...",
    "hit_count": 12,
    "created_at": "2026-04-12T12:00:00.000Z",
    "last_accessed_at": "2026-04-12T14:07:00.000Z"
  }
}
```

If the bookmark is not currently shared:

```json
{
  "item": {
    "enabled": false,
    "share_url": null,
    "hit_count": 0,
    "created_at": null,
    "last_accessed_at": null
  }
}
```

#### `PUT /v1/bookmarks/:id/share`

Enables sharing for the bookmark.

Behavior:

- `404` if the bookmark does not exist
- `409` if extraction is not complete
- `409` if `content_source !== "server"`
- if already enabled, return the existing share URL and metadata
- if not enabled, generate a new `share_id`, reset counters, and return the signed share URL

This should be idempotent for the common case. A second `PUT` should not silently rotate the token.

#### `DELETE /v1/bookmarks/:id/share`

Revokes the current share link.

Behavior:

- `204` whether the share was active or already disabled
- clear `share_id`
- set `share_revoked_at`
- keep the route simple; no separate "regenerate" endpoint

If the user wants a fresh link, they can disable and then enable again.

### 5.2 Public read endpoint

#### `GET /v1/public/shares/:token`

This is the anonymous payload that powers `/s/:token`.

Return only the data the reader page needs:

```json
{
  "item": {
    "title": "Article title",
    "url": "https://example.com/article",
    "site_name": "Example",
    "author": "Jane Doe",
    "published_date": "2026-04-10T00:00:00.000Z",
    "word_count": 1450,
    "content_html": "<article>...</article>"
  }
}
```

Do not return:

- `bookmark_id`
- `user_id`
- `normalized_url`
- `saved_via`
- any token/hash fields
- any internal moderation/debug state

### 5.3 Public endpoint behavior

For `GET /v1/public/shares/:token`:

1. Parse the token into `share_id` plus signature.
2. Verify the signature with `TOKEN_PEPPER`.
3. Look up the bookmark by `share_id`.
4. Require `share_revoked_at IS NULL`.
5. Load the matching article content.
6. Require `extraction_status === "complete"`.
7. Require `content_source === "server"`.
8. Increment `share_view_count` and update `share_last_accessed_at`.
9. Return the reader payload.

If any lookup fails, return `404`.

Use `404`, not `401` or `403`, so the response does not reveal whether the token used to exist.

### 5.4 Headers for public responses

Set:

- `Cache-Control: no-store`
- `X-Robots-Tag: noindex, nofollow`

Why:

- revoke should take effect immediately
- search engines should not index public share pages by default

## 6. Hit Count

Keep hit counting intentionally simple.

### 6.1 What counts as a hit

A hit is:

- one successful `200` response from `GET /v1/public/shares/:token`

This means:

- refresh counts again
- opening in a second tab counts again
- a second person opening the link counts again

Do not try to deduplicate by IP, cookie, session, or user agent.

### 6.2 Why raw count is enough

Raw count is easy to explain and easy to trust:

- no client-side analytics scripts
- no cookies
- no bot heuristics
- no event pipeline

It is not a marketing metric. It is just a simple "this link has been opened N times" counter.

### 6.3 Counter reset behavior

When a new share is enabled:

- set `share_view_count = 0`
- set `share_last_accessed_at = NULL`

This keeps the counter tied to the current active link, not to the bookmark's lifetime.

## 7. Backend Changes

### 7.1 Store layer

Add targeted share methods to the store instead of stuffing share fields into normal bookmark API payloads.

Recommended internal methods:

- `getBookmarkShare(userId, bookmarkId)`
- `enableBookmarkShare(userId, bookmarkId, shareId, now)`
- `disableBookmarkShare(userId, bookmarkId, now)`
- `getPublicShareById(shareId)`
- `recordBookmarkShareHit(bookmarkId, accessedAt)`

The share data can live on the `bookmarks` table while still using dedicated store methods.

That keeps the normal bookmark list and bookmark response shapes clean.

### 7.2 API app changes

Update the auth middleware exception in `apps/api/src/app.ts` so this route is public:

- `/v1/public/shares/*`

Do not make broader auth exceptions than that.

Then add the three authenticated routes plus the one public route.

## 8. Shared Schemas and API Client

### 8.1 Shared types

Add new schemas in `packages/shared/src/index.ts`:

- `bookmarkShareSchema`
- `bookmarkShareResponseSchema`
- `publicShareArticleSchema`
- `publicShareArticleResponseSchema`

Keep them small and purpose-built.

### 8.2 API client

Add these methods in `packages/api-client/src/index.ts`:

- `getBookmarkShare(id)`
- `enableBookmarkShare(id)`
- `disableBookmarkShare(id)`
- `getPublicShareArticle(token)`

`getPublicShareArticle(token)` should explicitly use `token: null` so the request never sends the user's bearer token by accident.

## 9. Web App Changes

### 9.1 Reader rendering

The current private reader page already has the rendering logic you want.

Do this:

- extract the shared rendering into a presentational component
- keep the private `/read/:id` page as the authenticated loader
- add a new public `/s/:token` page as the anonymous loader

Both pages should use the same content sanitizer and the same article layout.

### 9.2 Public route

Add a React route:

- `/s/:token`

This route must not be wrapped in `RequireAuth`.

It should:

- fetch `GET /v1/public/shares/:token`
- render the same reader UI
- show a simple error message for invalid or revoked links

### 9.3 Public page header

Do not reuse the private back arrow to `/`, because `/` requires login.

Keep the public header minimal:

- small `url-keep` mark or title
- existing `Read on web` link to the source page

No extra public navigation is required.

### 9.4 Owner-facing share UI

Add a simple inline share control on the bookmark row.

Recommended behavior:

- show `share` as a text action next to `read`
- clicking `share` calls `PUT /v1/bookmarks/:id/share`
- reveal a compact inline section with:
  - the share URL
  - a copy action
  - the hit count
  - the last accessed time
  - a `disable share` action

Do not use a modal for v1.
Do not add a complex "share settings" screen.

### 9.5 Visibility rules in the UI

Keep the UI simple:

- show the `share` action only when the bookmark has readable content
- if the API returns `409` because the content is not shareable, show the server message inline

Do not expand the bookmark list payload just to precompute shareability on the client.

## 10. Security and Privacy

### 10.1 Token format

Use the same random opaque ID style already used elsewhere for the stored `share_id`:

- random 32 bytes
- hex string
- existing `uk_` prefix is fine

The public path token can then be:

- `<share_id>.<signature>`

The public URL should not expose bookmark IDs or user IDs.

### 10.2 At-rest storage

Store only `share_id` plus the share metadata fields.

Do not store the final signed public URL token in D1.

### 10.3 Failure behavior

Return `404` for:

- unknown token
- revoked token
- bookmark deleted
- content deleted
- content no longer shareable

This keeps the public surface quiet and predictable.

### 10.4 Private route remains private

Do not special-case `/read/:id`.

That route should continue to work only for authenticated owners and offline local reads.

## 11. Testing

Add focused tests, not a giant matrix.

### 11.1 API tests

Add coverage for:

- enable share for an extracted server article
- second `PUT` returns the same active link
- enable share fails for missing bookmark
- enable share fails for incomplete extraction
- enable share fails for client-captured content
- public token returns reader payload without auth
- public token increments hit count and `last_accessed_at`
- revoked token returns `404`
- invalid token returns `404`

### 11.2 Web tests

If you add web tests later, cover:

- `/s/:token` renders without auth
- invalid share link shows a clean error
- owner share UI shows the URL and hit count
- disabling a share removes access

## 12. Implementation Order

Build this in a tight sequence:

1. Add the D1 migration.
2. Add store methods in D1 + memory store.
3. Add shared schemas and client methods.
4. Add API routes and tests.
5. Extract the shared reader component.
6. Add the public `/s/:token` route.
7. Add the owner-facing share control in the bookmark list.

This keeps the public route working before any UI polish.

## 13. Files To Touch

Expected files:

- `SHARE.md`
- `apps/api/migrations/0004_bookmark_share.sql`
- `apps/api/src/types.ts`
- `apps/api/src/store.ts`
- `apps/api/src/d1-store.ts`
- `apps/api/src/memory-store.ts`
- `apps/api/src/app.ts`
- `apps/api/src/app.test.ts`
- `packages/shared/src/index.ts`
- `packages/api-client/src/index.ts`
- `apps/web/src/App.tsx`

## 14. Out of Scope

Keep these out of v1:

- multiple active share links per bookmark
- expiring links
- password-protected links
- unique visitor analytics
- bot filtering
- link preview SSR or Open Graph metadata
- public profile pages
- search or listing of public shares

If later you need richer publishing behavior, that should be a separate feature, not an extension of this first pass.
