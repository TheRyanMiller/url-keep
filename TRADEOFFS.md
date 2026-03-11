# Extraction Tradeoffs

## Recommendation

Do not keep investing in a server-only extraction model as the primary path.

Use a **hybrid architecture**:

- **Client capture first** when the browser already has access to the fully rendered article.
- **Server extraction as fallback** for save flows that do not have page access.

This is the best fit for the actual problem: "save what I can read," not "save what a Cloudflare Worker can fetch."

## Why Server-Only Breaks

The NYTimes example is not an edge case. It is a representative failure mode.

A Worker only sees the public internet. It does not have:

- your logged-in browser session
- your subscription cookies
- your client-rendered page state
- your personalized or paywalled access

That means any site where the user can read the content but the Worker cannot fetch it will keep failing. This includes paywalled news sites, logged-in apps, some JS-heavy pages, and some anti-bot protected domains.

## Tradeoffs

### Server-Only

Pros:

- One extraction path for extension, web paste, and iOS shortcut
- Simpler operational model
- Easy to run asynchronously after save
- Good for public articles

Cons:

- Cannot access subscriber-only or logged-in content
- Can fail on anti-bot protections
- Can miss client-rendered content
- Will mark many user-readable pages as failed even though the user could read them in-browser

Conclusion:

Good fallback. Bad primary strategy.

### Client-Only

Pros:

- Highest fidelity
- Can capture exactly what the user can see
- Works for paywalled and logged-in content in the extension
- Better for JS-rendered pages

Cons:

- Only works where a trusted client has DOM access
- Does not cover simple web paste or iOS shortcut saves
- More client complexity
- Different clients would need different capture capabilities

Conclusion:

Best fidelity, but not enough coverage on its own.

### Hybrid

Pros:

- Solves the NYTimes class of problem for extension saves
- Preserves universal save flows
- Uses the best available source of truth per context
- Avoids forcing everything through one flawed model

Cons:

- More moving parts
- Need content provenance and conflict rules
- Some flows still remain server-fallback only

Conclusion:

This is the right architecture.

## Recommended Product Model

Change the mental model from:

- "extract article on the server"

to:

- "capture readable content when possible, extract otherwise"

That means:

1. If the extension can access the live page, capture from the client.
2. If the client cannot capture, fall back to server extraction.
3. If the server is blocked, surface that clearly instead of generic failure.

## Concrete Recommendation

Implement a hybrid path with these rules:

### 1. Extension capture becomes the preferred path

For extension saves:

- run Readability against the live DOM in the tab
- capture the cleaned article content client-side
- upload that content to the API after bookmark save
- mark the stored content source as client-derived

This should become the primary way authenticated/logged-in content is saved.

### 2. Keep server extraction as fallback

Use server extraction for:

- iOS shortcut saves
- web paste saves
- any bookmark saved without browser DOM access

This keeps "save from anywhere" intact.

### 3. Add provenance

Track how content was obtained, e.g.:

- `client_capture`
- `server_fetch`

If client-captured content exists, do not automatically overwrite it with server-fetched content.

### 4. Improve failure semantics

Do not show generic `FAILED` for access-blocked fetches.

Treat server-side `401` / `403` style failures as something closer to:

- `blocked`
- or `needs browser capture`

That better reflects reality: the site blocked server extraction, not the bookmark itself.

### 5. Keep initial client capture text-first

Do not block this architecture shift on perfect authenticated image capture.

The highest-value part is article text. Images can remain best-effort at first.

## What Not To Do

Do not keep spending much time trying to make the Worker impersonate a real browser session.

Specifically:

- do not try to pipe user cookies through the server
- do not assume better headers will solve this class of problem
- do not pivot to a fully client-only system and lose universal save flows

Better headers may improve some public-site extraction rates, but they will not solve the core issue of authenticated access.

## Important Limitation

A hybrid model will solve this well for the browser extension, but not fully for mobile share flows.

For example:

- iOS Shortcut still will not have rich DOM access
- a PWA share target still will not have access to the source page DOM

So mobile authenticated capture remains limited unless you later build a more privileged client surface.

## PWA Share Target On Mobile

This needs to be stated very clearly:

An installed PWA launched from the mobile share sheet is **not** equivalent to an extension content script running inside the page.

### What the PWA actually receives

A Web Share Target receives only the share payload that the browser/app passes into it:

- `url`
- `title`
- `text`
- optionally files

It is launched with that shared data. It does **not** get:

- the source page DOM
- the rendered article HTML
- the source tab's JS context
- the source origin's cookies or local storage

### What that means for a logged-in NYTimes article

If you are on `nytimes.com` on mobile, logged in, and reading a paywalled article, then share it to the installed `url-keep` PWA:

- the PWA will **not** inherit your NYTimes session
- the PWA will **not** be able to read the article body from the NYTimes page directly
- the fact that *you* can read it in Safari/Chrome does **not** mean the PWA can capture it client-side

So in the normal PWA share-target flow, that bookmark would still be effectively **demoted to server-side fetch** unless the source app explicitly shared enough article text in the payload.

### Could the share payload include the article content?

In theory, yes, if the source app shared the actual article text or a file containing it.

In practice, for normal browser page sharing, that is not what happens. The share payload is usually just:

- page URL
- page title
- maybe some plain text

It is not a full-fidelity transfer of the rendered page content.

That means a PWA share target is useful for:

- one-tap mobile save
- capturing the shared URL/title cleanly
- preserving installable/mobile UX

But it is **not** a substitute for authenticated client-side DOM capture.

### Recommendation for the PWA path

Treat the mobile PWA share target as a convenience save surface, not as the solution for authenticated content capture.

For mobile PWA shares:

- save the URL and any shared metadata
- attempt server extraction as fallback
- do not promise full-fidelity capture for paywalled/logged-in pages

### Bottom line on the NYTimes example

For the specific case:

- logged into NYTimes on mobile
- reading a paywalled article
- using the system share sheet into the `url-keep` PWA

Recommendation:

- assume it will **not** capture the readable article body client-side
- assume it will fall back to **server-side fetch**
- therefore assume it may end up blocked or incomplete

So the browser extension remains the best path for authenticated client-side capture. The PWA share target does not close that gap.

## Recommended Next Steps

1. Add a richer extraction state model:
   `pending`, `complete`, `blocked`, `failed`, `skipped`
2. Add `content_source` metadata:
   `client_capture` vs `server_fetch`
3. Implement extension-side DOM capture and upload
4. Prefer client-captured content over server-fetched content
5. Update the UI copy to say `site blocked server extraction` instead of `FAILED`

## Bottom Line

If the product promise is "save what I can actually read," then the browser session must be part of the architecture.

The right move is:

- **hybrid capture/extraction**
- **client-first where the browser has access**
- **server fallback everywhere else**
