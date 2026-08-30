# Style Guide

url-keep should feel like a quiet typed index: obvious, compact, and durable. It is intentionally document-like rather than dashboard-like.

## Foundation

- Use the existing monospace stack everywhere.
- Keep the palette white, near-black, and restrained grays.
- Build hierarchy with spacing, alignment, weight, and rules. Reserve the single blue accent for audio progress and ready state.
- Prefer a single column, roughly 760–920 px wide, with dense left-aligned content.
- Use the 4 px spacing rhythm already present in `styles.css`.

The current tokens are `#fff` background, `#111` text/strong rules, `#666` secondary text, `#999` faint text, `#d9d9d9` subtle rules, and an almost-transparent black hover.

## Structure

- Use thin dividers instead of cards, panels, shadows, or tinted surfaces.
- Keep bookmark rows text-led; preview images are optional scanning aids.
- Preserve stable image dimensions and hide failed images without placeholders.
- Let the reading list dominate the main page.
- Keep login, save, token, and extension flows narrow and direct.

## Controls

- Controls are square, text-first, and visually quiet.
- Icon-only actions use the existing Lucide line weight, clear accessible labels, and visible focus/hover treatment.
- Destructive actions require confirmation and remain monochrome until armed.
- Direct mobile actions need a comfortable hit area even when the icon itself stays small.
- External navigation uses a small arrow only when it clarifies behavior.
- The logo is always a home link; do not hide secondary behavior behind it.

Installed PWA Refresh belongs in the existing header outside the reader. It must not create a bottom bar, modal, or standalone-only layout. Regular browser tabs do not render it.

## Reader

- Reader text gets space and line height, not decorative chrome.
- Put Back on the left of the sticky header and group Share, Listen, text size, and Read on web as square icon actions on the right.
- Keep title and metadata below that utility row. Separate source, author, reading time, and date with compact middle dots; use normal casing and a readable date such as `Aug 26, 2026`.
- Use accessible labels and titles for icon-only actions. Read on web remains visibly disabled offline.
- Article links remain recognizable and open safely in a new tab.
- Narration uses the authenticated, integrity-checked Blob URL as a hidden native audio engine. Do not expose credentials or a direct service URL.
- The custom player matches the Wavey Gist transport: play/pause, 10-second skips, elapsed and total time, seek, and the six shared playback speeds. Persist speed and per-narration position locally, clearing position near the end.
- Anchor the player to the sticky reader header with CSS. Do not add scroll listeners, docking state, a second player, waveform, artwork, volume control, or global playback store.
- Keep the player square, monochrome, and compact. Blue is limited to ready glow, progress, and the seek thumb.

## Settings

- Use one direct `/settings` page without redirects or alternate routes.
- Offline audio gets one enable control, one native size select, factual usage, and one confirmed clear action.
- Notifications get one enable/disable action for the current browser, with short unsupported or blocked copy.
- Keep these sections above account and token controls; do not turn settings into a dashboard.

## Responsive behavior

- Collapse horizontal layout before reducing text size.
- Mobile bookmark rows keep title/domain first and actions secondary.
- Respect safe-area insets in sticky headers and page padding.
- Avoid content jumps while images, sync state, or extraction state changes.

## Motion and feedback

- Use little to no animation.
- Status copy, the existing live-region notice, and a restrained narration spinner are enough for transient feedback.
- Do not add shimmer, decorative transitions, progress theater, or onboarding panels.

## Avoid

- Bright or competing accents, gradients, decorative shadows, glass effects, pills, or rounded card systems.
- Floating actions, sidebars, multi-panel dashboards, and bottom navigation.
- Decorative illustration, marketing copy, empty-state art, or dense iconography.
- Pull-to-refresh, modal explanations, or complex conflict/offline UI.

If a UI choice feels stylish before it feels obvious, it is probably wrong for url-keep.
