# Style Guide

url-keep should feel like a quiet typed index: obvious, compact, and durable. It is intentionally document-like rather than dashboard-like.

## Foundation

- Use the existing monospace stack everywhere.
- Keep the palette white, near-black, and restrained grays.
- Build hierarchy with spacing, alignment, weight, and rules—not color or decoration.
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

Installed PWA Share and Refresh controls belong in the existing header. They must not create a toolbar, bottom bar, modal, or standalone-only layout. Regular browser tabs render neither control.

## Reader

- Reader text gets space and line height, not decorative chrome.
- Title, source metadata, reading time, date, text size, and **Read on web** stay compact.
- Keep **Read on web** explicit and visibly disabled offline.
- Article links remain recognizable and open safely in a new tab.
- Text size is the only reader preference; do not add routing or capture settings.

## Responsive behavior

- Collapse horizontal layout before reducing text size.
- Mobile bookmark rows keep title/domain first and actions secondary.
- Respect safe-area insets in sticky headers and page padding.
- Avoid content jumps while images, sync state, or extraction state changes.

## Motion and feedback

- Use little to no animation.
- Status copy and the existing live-region notice are enough for transient feedback.
- Do not add shimmer, decorative transitions, progress theater, or onboarding panels.

## Avoid

- Bright accents, gradients, shadows, glass effects, pills, or rounded card systems.
- Floating actions, sidebars, multi-panel dashboards, and bottom navigation.
- Decorative illustration, marketing copy, empty-state art, or dense iconography.
- Pull-to-refresh, modal explanations, or complex conflict/offline UI.

If a UI choice feels stylish before it feels obvious, it is probably wrong for url-keep.
