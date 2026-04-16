# Multimedia Organization Plan

## 1. Goal

`url-keep` should stay one personal list.

The v1 problem is narrower than "support multimedia":

- stop treating obvious non-article URLs like broken articles
- make video links easier to scan
- keep the current black-and-white, text-first product shape

The plan should stay boring and reversible. If a decision adds taxonomy, schema, or UI branches without a clear UX win, that is a red flag.

## 2. Product Shape

Add one small filter control above the list:

- `ALL`
- `READING`
- `VIDEOS`

Rules:

- `ALL` shows every bookmark in the current newest-first order
- `READING` means "everything that is not an obvious video destination"
- `VIDEOS` means "obvious watch-first URLs"
- default stays `ALL`
- keep the state in the URL: `/?tab=reading`, `/?tab=videos`
- keep search scoped to the active tab

Do not add `SOCIAL`, `AUDIO`, `PODCASTS`, `DOCS`, or any other tabs in v1.

## 3. Simplicity Rules

These constraints should drive the implementation:

- prefer derived state over stored state, except when one stored field materially simplifies correctness
- use one shared classifier instead of multiple enums and columns
- bias toward false negatives over false positives
- keep the current row layout in v1
- change behavior before changing visual complexity
- tabs must return complete results across the full list, not just the currently loaded page

The biggest risk in the original draft was over-modeling the problem. `article | social | video | link` plus `list_bucket` plus `provider` is more structure than the UX actually needs.

## 4. Minimal Decision Model

V1 should use a shared pure helper in `packages/shared`, for example:

```ts
type BookmarkBucket = "reading" | "videos";

type BookmarkClassification = {
  bucket: BookmarkBucket;
  autoExtract: boolean;
  defaultAction: "open" | "watch" | null;
};
```

There should be only two product groupings:

- `reading`
- `videos`

Everything else is behavior, not category.

Recommended rules:

- obvious video URLs
  bucket `videos`, `autoExtract = false`, `defaultAction = "watch"`
- a short allowlist of non-reader reading URLs such as X status pages
  bucket `reading`, `autoExtract = false`, `defaultAction = "open"`
- everything else
  bucket `reading`, `autoExtract = true`, `defaultAction = null`

Persist only `bucket` in the database.

Migration and backfill plan:

1. Add `bucket` to `bookmarks` as a nullable field.
2. Run a one-time backfill script that classifies every existing bookmark by URL and writes `reading` or `videos`.
3. Verify there are no null buckets left.
4. Make `bucket` required and restrict it to `reading | videos`.
5. Do not ship the tab UI until backfill is complete.

Do not default old rows to `reading` and call it done. That would make older video bookmarks disappear from `VIDEOS` until they were manually touched again.

Why:

- correct server-side filtering and pagination for `READING` and `VIDEOS`
- only one new field instead of duplicated fields like `media_kind` and `list_bucket`
- the same logic can run in API, web, extension, and offline mode
- classification rules stay easy to adjust

Keep `autoExtract` and `defaultAction` derived from the shared helper. Only `bucket` needs to be persisted.

## 5. Detection Rules

Keep the rules small and deterministic.

### `video`

Only classify as `video` when the URL is obviously a watch destination:

- `youtube.com/watch`
- `youtu.be/*`
- `youtube.com/shorts/*`
- `loom.com/share/*`
- clear Vimeo watch pages

Behavior:

- bucket `videos`
- `autoExtract = false`
- default action `watch`

### non-reader reading rule

For a short allowlist of URLs that belong in `READING` but should not use the article-reader flow:

- `x.com/*/status/*`
- `twitter.com/*/status/*`

Behavior:

- bucket `reading`
- `autoExtract = false`
- default action `open`

### default

Everything else falls back to:

- bucket `reading`
- `autoExtract = true`
- `defaultAction = null`

This default matters. It keeps the system predictable and avoids accidentally hiding useful reader behavior for normal pages.

## 6. UX Rules

The UI should stay close to the current app.

### Tab control

Use one segmented filter control directly under the page header.

Behavior:

- tabs are `ALL`, `READING`, `VIDEOS`
- missing or invalid `tab` query param falls back to `ALL`
- switching tabs preserves `q` if a search is active
- search remains scoped to the active tab
- do not show counts in v1

Implementation:

- treat the control as URL-backed navigation, not a JavaScript tab widget
- render it as a simple `nav` with three links
- use `aria-current="page"` on the active tab
- do not use a complex ARIA `tablist` / `tabpanel` pattern here

Layout:

- desktop: tabs on the left, search input on the right, same row when space allows
- mobile: stack tabs above search
- mobile tabs should share the row width evenly

Visual treatment:

- one outer border around the control
- one divider between each tab
- text only: no icons, no badges, no counts
- active tab: black background, white text
- inactive tab: white background, black text
- no animation beyond normal hover and focus states

Empty states:

- `ALL`: `no bookmarks yet`
- `READING`: `no reading links yet`
- `VIDEOS`: `no videos yet`

When search is active, use the same empty states with `matching` added, for example `no videos matching your search`.

### Normal reading rows

- keep the current row layout
- keep the current extraction and reader flow
- show `read` when extracted content exists
- otherwise let the title link open the source
- keep extraction status and retry only here

### Non-reader reading URLs

- keep the same row layout
- primary text action should be `open`
- hide extraction failure and retry UI

This is the right behavior for X posts. They stay in `READING`, but the source page is the real destination.

Do not show `read` for this exception path in v1. If client-captured social-reader support ever proves valuable, that can be added later as a separate decision.

### Video rows

- keep the same row layout in v1
- primary text action should be `watch`
- hide extraction failure and retry UI
- keep thumbnails if already available, but do not introduce a special large-card layout yet

The original plan's 16:9 video row is a reasonable later enhancement, but it is not necessary for the first UX win.

## 7. Reader And Extraction Behavior

This is the main product improvement.

### normal reading URLs

- keep automatic extraction as it works today

### non-reader reading URLs

- do not auto-queue server extraction
- do not attempt automatic extension capture in v1
- keep the bookmark opening at the source URL

### `video`

- do not auto-queue server extraction
- do not create pending extraction noise
- never show a failed article state for a watch-first URL

Implementation detail that keeps the system clean:

- when `autoExtract = false`, do not create a pending `article_content` row just to represent "not applicable"
- return `extraction_status = null` for these bookmarks

That is simpler than creating fake pending or skipped records and then teaching the UI to ignore them.

## 8. API, Extension, And Offline Impact

V1 should avoid broad API and schema changes.

### API

- call the shared classifier during bookmark save
- persist bookmark `bucket`
- only queue extraction when `autoExtract = true`
- add server-side list filtering by bucket so tabs paginate correctly

Recommended API shape:

- `GET /v1/bookmarks`
- `GET /v1/bookmarks?bucket=reading`
- `GET /v1/bookmarks?bucket=videos`

Explicit request and response contract:

- add optional `bucket` query param to `GET /v1/bookmarks`
- allowed values: `reading`, `videos`
- omit `bucket` for `ALL`
- invalid `bucket` returns `400`
- when both `bucket` and `q` are present, both filters apply server-side before pagination
- pagination cursors must stay scoped to the same `bucket` and `q`

Expose `bucket` in every bookmark payload that the web app and offline cache use:

- bookmark create response
- bookmark list response
- bookmark by-url response
- offline bundle `bookmark` payload

Make this explicit in:

- `packages/shared/src/index.ts`
- `SPEC.md`
- API handlers and store types
- offline cache schema

### Extension

- call the same shared classifier before capture
- skip content capture and server-extraction fallback for URLs where `autoExtract = false`

### Web app

- use the tab state in the URL
- request `READING` and `VIDEOS` from the API with `bucket=...`
- adjust action labels from `bucket`, `autoExtract`, and `extraction_status`

### Offline mode

- include `bucket` in cached bookmark payloads so offline tabs stay correct without extra scanning

This is the one schema/API change that is worth making. Without it, client-side-only tab filtering would be incomplete as soon as the list grows beyond one page.

## 9. Recommended V1 Scope

Ship the smallest version that clearly improves UX:

- add shared URL classification
- add one bookmark `bucket` field
- add `ALL | READING | VIDEOS`
- add API-side bucket filtering
- change primary action labels to `read`, `open`, or `watch`
- skip extraction noise for URLs where `autoExtract = false`
- keep the current visual row structure

Do not include in v1:

- multiple media columns
- provider APIs
- detailed media metadata
- separate social or audio tabs
- special video cards
- broader content taxonomy

## 10. Examples

| URL example | Bucket | Auto extract | Default UX |
|-------------|--------|--------------|------------|
| New York Times article | `reading` | yes | current row, `read` when content exists |
| `https://youtu.be/...` | `videos` | no | current row, `watch` |
| `https://x.com/.../status/...` | `reading` | no | current row, `open` |
| GitHub issue or README | `reading` | yes | current row, `open` or `read` depending on content |

## 11. Recommendation

The best v1 is smaller than the original draft:

- one stored `bucket` field only
- no duplicate classification fields
- one shared URL rules helper
- three tabs only
- same list UI, clearer actions
- no extraction failures for URLs that were never reader content

That gives a cleaner code path and a much clearer UX without turning `url-keep` into a media platform.
