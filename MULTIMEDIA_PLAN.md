# Multimedia Organization Plan

## 1. Overview

`url-keep` should stay one personal list, but it should stop pretending every saved URL is an article.

The goal is not to build a full media platform. The goal is:

- detect obvious media types from the URL
- organize the list into a few useful buckets
- give each bucket the right default action
- avoid noisy extraction failures for URLs that were never meant for the reader

## 2. Chosen Product Shape

Add a tabbed filter to the main list:

- `ALL`
- `READING`
- `VIDEOS`

Rules:

- `ALL` shows every bookmark in the current newest-first order.
- `READING` shows text-first URLs: articles, docs, newsletters, blog posts, Reddit posts, X posts, and general links.
- `VIDEOS` shows URLs whose primary destination is watching a video.

This should stay intentionally small. Do not add separate tabs for `SOCIAL`, `AUDIO`, `PODCASTS`, or `LINKS` in v1.

## 3. Classification Model

Add a small media classification layer to bookmarks.

Suggested fields:

- `media_kind`: `article | social | video | link`
- `list_bucket`: `reading | videos`
- `provider`: nullable short string like `youtube`, `x`, `vimeo`, `loom`

Why both `media_kind` and `list_bucket`:

- `media_kind` is the precise internal classification.
- `list_bucket` is the simple UI grouping used by the tabs.

This lets X bookmarks be treated as `social` internally while still appearing in `READING`.

## 4. Detection Rules

Detection should be deterministic and cheap. Do not depend on provider APIs in v1.

At save time:

1. Normalize the URL as usual.
2. Classify by hostname and path rules.
3. Store `media_kind`, `list_bucket`, and `provider`.
4. Keep existing `title`, `image_url`, and `site_name` behavior.

Initial rules:

- `youtube.com/watch`, `youtu.be/*`, `youtube.com/shorts/*` -> `video`, bucket `videos`, provider `youtube`
- `vimeo.com/*` video pages -> `video`, bucket `videos`, provider `vimeo`
- `loom.com/share/*` -> `video`, bucket `videos`, provider `loom`
- `x.com/*/status/*`, `twitter.com/*/status/*` -> `social`, bucket `reading`, provider `x`
- everything else -> `article` or `link`, bucket `reading`

Important default:

- only move a URL into `VIDEOS` when it is clearly a video destination
- everything else stays in `READING`

That rule is predictable and avoids surprising users.

## 5. List UX

### 5.1 Tabs

The tab strip should sit above the list and update the URL, for example:

- `/`
- `/?tab=reading`
- `/?tab=videos`

Behavior:

- default to `ALL`
- keep search scoped to the active tab
- keep newest-first sort everywhere
- preserve the current black-and-white text-first UI

### 5.2 Row Treatment By Type

#### Reading items

Use the current row layout with small adjustments:

- primary action: `read` when readable content exists
- fallback action: `open` when readable content does not exist
- keep extraction status only for URLs that are meant to become readable

Examples:

- news article
- blog post
- documentation page
- newsletter archive page

#### Video items

Video rows should feel different immediately:

- larger 16:9 thumbnail if one is available
- provider label such as `youtube`
- primary action: `watch`
- do not show article extraction retry/failure UI

If richer metadata becomes available later, add:

- channel or creator name
- duration

But those are optional for v1.

#### X and other social items

Social URLs should live in `READING`, not `VIDEOS`.

Recommended behavior:

- provider badge such as `x`
- title should prefer captured post text when available, otherwise the existing page title
- primary action: `open`
- secondary action: `read` only if client-captured text exists

This avoids sending users to an empty reader page for content that is usually better opened at the source.

## 6. Reader And Extraction Rules

The current reader should become more selective.

### 6.1 Articles and normal reading URLs

- keep the current extraction and reader flow
- show `read` when extracted content exists

### 6.2 Video URLs

- skip article extraction by default
- do not show extraction failures for video URLs
- default action is always `watch`

This is the biggest UX win. A saved YouTube link should never look broken because article extraction failed.

### 6.3 Social URLs

For X and similar sources:

- do not rely on server extraction as the main path
- if the extension captures readable text, allow `/read/:id`
- otherwise treat the bookmark as open-first

This keeps the product useful without pretending social sites are reliable reader inputs.

## 7. API And Data Changes

Keep this small.

### 7.1 Schema

Add bookmark fields:

- `media_kind`
- `list_bucket`
- `provider`

Expose them in:

- bookmark create response
- bookmark list response
- bookmark by-url response
- offline bundle payload

### 7.2 List API

Add an optional list filter:

- `GET /v1/bookmarks?bucket=reading`
- `GET /v1/bookmarks?bucket=videos`

Default remains all bookmarks.

This is better than client-only filtering because the list already has paging, search, and offline sync concerns.

## 8. Suggested UX Rules

Use the bucket and media kind to decide the primary button label:

| Type | Tab | Primary action |
|------|-----|----------------|
| Article | `READING` | `read` |
| General link | `READING` | `open` |
| X post | `READING` | `open` |
| Video | `VIDEOS` | `watch` |

Secondary rules:

- never show `read` for a video unless a transcript or captured text exists
- avoid `failed extraction` messaging on URLs that were intentionally classified as non-reader media
- keep `ALL` mixed, but let the row styling and action labels explain the type

## 9. Recommended V1 Scope

Ship this in two small phases.

### Phase 1

- add URL classification
- add `media_kind`, `list_bucket`, `provider`
- add `ALL | READING | VIDEOS`
- update action labels to `read`, `open`, or `watch`
- skip extraction noise for video URLs

### Phase 2

- improve video row layout
- improve X/social row treatment
- allow client-captured social text to open in the reader when available

## 10. Examples

| URL example | Classification | Tab | Default UX |
|-------------|----------------|-----|------------|
| New York Times article | `article` | `READING` | standard row, `read` |
| `https://youtu.be/...` | `video` | `VIDEOS` | large thumbnail, `watch` |
| `https://x.com/.../status/...` | `social` | `READING` | compact row, `open` |
| GitHub README or issue | `link` or `article` | `READING` | `open` or `read` depending on content availability |

## 11. Recommendation

The best v1 is:

- classify only obvious video providers into `VIDEOS`
- keep X and similar social bookmarks inside `READING`
- make the primary action reflect the content type
- stop showing article-reader failure states for links that are not articles

That gives the list a much better UX without making the product complicated.
