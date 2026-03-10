# URL Keep Style Guide

This guide defines the visual language for `url-keep`.

It is intentionally narrow and should be applied to:

- the web app
- the mobile `/save` page
- the browser extension popup

The goal is not to make the product look designed in a flashy way.
The goal is to make it feel quiet, obvious, and durable.

## Core aesthetic

- **Document-like, not app-like**
  The interface should feel closer to a typed index or ledger than a consumer product.
- **Monochrome first**
  Hierarchy comes from spacing, alignment, weight, borders, and type size.
- **Text is the interface**
  Buttons, links, and controls should feel like text controls, not glossy components.
- **Lines over surfaces**
  Prefer dividers and rules over cards, shadows, fills, or decoration.
- **Preview media is secondary**
  If a bookmark has an image, it should support scanning, not dominate the layout.

## Product-specific design rules

- Monospace is the default font for the entire product.
- Default presentation is light mode.
- v1 should not depend on dark mode to feel complete.
- No decorative icons, illustrations, hero sections, or onboarding panels.
- No accent color system.
- No status badges unless a future feature truly requires them.
- No empty-state illustrations.
- No cards with shadows.
- No rounded, soft, friendly visual language.
- Every screen should still feel correct if printed on paper.

## Color palette

Use a very small grayscale palette.

### Light mode

- Background: `#FFFFFF`
- Primary text: `#111111`
- Secondary text: `#666666`
- Faint text: `#999999`
- Strong divider: `#111111`
- Subtle divider: `#D9D9D9`
- Hover background: `rgba(0, 0, 0, 0.03)`

### Optional dark mode

Dark mode is not required for v1.

If added later, invert the palette without changing the visual system:

- Background: `#111111`
- Primary text: `#F5F5F5`
- Secondary text: `#CFCFCF`
- Faint text: `#999999`
- Strong divider: `#F5F5F5`
- Subtle divider: `#333333`
- Hover background: `rgba(255, 255, 255, 0.04)`

## Typography

Use monospace everywhere.

Recommended stack:

```css
font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
```

### Type scale

- Page title: `18px`, medium
- Section heading: `14px`, medium
- Body text: `13px`, regular
- Meta text: `11px`, regular
- Dense labels: `10px`, regular, uppercase, slightly letter-spaced

### Rules

- Headings get hierarchy from size and weight, not color.
- Labels should be muted.
- URLs, domains, token strings, and timestamps should remain monospace.
- Do not mix in a sans-serif display font.

## Spacing

Use a 4px rhythm:

- `4`
- `8`
- `12`
- `16`
- `24`
- `32`

Guidelines:

- Tight spacing within rows
- Clear spacing between sections
- No oversized hero padding

## Layout philosophy

- Single-column by default
- Constrain the main app width to roughly `760px` to `920px`
- Dense content should align to the left
- Avoid multi-panel dashboards
- Avoid decorative sidebars

### Layout stability

- Reserve space for list containers to reduce jumpiness
- Keep button labels stable
- Do not let preview images reflow the whole row when they appear
- Use `overflow-y: scroll` on the root element to reduce layout shift from scrollbar changes

## Structure and dividers

Dividers should do most of the structural work.

- Section separators: `1px` strong divider
- Row separators: `1px` subtle divider
- No vertical grid lines unless the data becomes hard to scan without them

Think ledger, not dashboard.

## Controls

Controls should be plain and legible.

### Buttons

- Text-first appearance
- Square corners or browser-default corners only
- Thin border
- White background
- Black text
- No filled black buttons unless absolutely necessary

### Inputs

- Single thin border
- White background
- Black text
- No inset shadows
- Placeholder text should be faint, not italic

### Links

- Same color as text
- Underline on hover or focus
- External links may use `↗` if it clarifies behavior

## Bookmark list

The bookmark list is the main visual surface of the product.

### Row structure

Desktop rows should read as three logical zones:

- left: saved date and saved-via label
- center: title and domain
- right: optional preview image, then actions

Mobile rows should collapse to:

- title
- domain
- date and saved-via
- optional image
- actions

### Row styling

- Prefer divider-separated rows over freestanding cards
- If a border container is used, it should be thin and rectangular
- Row padding should stay compact, around `12px` to `16px`
- Hover state should be a very subtle background shift only

### Bookmark title

- Most visually prominent text in the row
- One to two lines maximum before truncation
- Edited titles should not look visually different from non-edited titles

### Domain and metadata

- Smaller than title
- Muted color
- Keep aligned and predictable

### Actions

- Text buttons are preferred
- `open`, `edit`, and `delete` should read as lightweight inline actions
- Do not use icon-only destructive actions in v1

## Preview images

Preview images are optional and should be treated as supporting material.

Rules:

- Never reserve more visual weight for the image than for the title
- Keep aspect ratio stable if possible
- Use a thin border if needed for separation
- If the image fails to load, hide it without showing a broken image placeholder
- Do not apply shadows, gradients, overlays, or glossy framing

Images should feel like clipped references, not featured media.

## Page-specific guidance

## Login

- Keep it narrow
- Title, fields, one submit action
- No welcome copy, feature lists, or marketing language

## Main page

- Save input and search should sit near the top
- Token settings and logout should be visually quiet
- The bookmark list should dominate the page

## Mobile `/save`

- One input
- One action
- Minimal framing
- Large enough touch targets, but still visually austere

## Token settings

- Present tokens as a plain list
- New token output should be clearly separated with a border or rule
- Warn clearly that token values are shown once
- Avoid “security dashboard” styling

## Extension popup

- Extremely compact
- Domain, state, one primary action, one link out
- No multi-step interface unless required for login
- On success, the popup closes, so feedback only needs to exist for failure cases

## Motion and loading

- Little to no animation
- No shimmer effects
- No decorative transitions
- If loading placeholders are used, they should be static blocks or a subtle pulse
- Do not delay rendering to wait for preview images

## Responsive behavior

- Desktop density is acceptable
- Mobile usability must remain intact
- Collapse horizontally before shrinking text
- Prevent important text controls from wrapping awkwardly
- Keep primary touch targets at least `44px` tall where they are tapped directly

## URL and state behavior

The app should preserve its document-like feel even when interactive.

- Search state may live in the URL query string
- Default values should be omitted from URLs
- URLs should stay readable

Example:

```text
/?q=database
```

## Things to avoid

- Bright colors
- Brand gradients
- Shadows
- Glassmorphism
- Floating action buttons
- Marketing copy
- Pill tabs
- Colored badges
- Dense iconography
- Empty-state illustrations
- Centered dashboard cards
- Over-animated loading states

## Summary checklist

- [ ] Monospace everywhere
- [ ] White background, black text, gray secondary text
- [ ] Lines and dividers do the structural work
- [ ] Bookmark rows stay compact and text-led
- [ ] Preview images are optional and subordinate
- [ ] Controls are plain and square
- [ ] No decorative color
- [ ] No shadows or glossy surfaces
- [ ] Desktop feels like a ledger
- [ ] Mobile remains clean and tappable

If a UI choice feels stylish before it feels obvious, it is probably wrong for `url-keep`.
