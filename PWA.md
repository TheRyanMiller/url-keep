# Progressive Web App Plan

## 1. Overview

url-keep is currently a static React SPA deployed to Vercel. This plan turns it into an installable Progressive Web App. The primary motivations:

1. **Share target** — an installed PWA appears in the OS share sheet on iOS and Android, giving users a one-tap save flow that replaces the iOS Shortcut for most users.
2. **Offline shell** — the app loads instantly from cache even without a network, which is a prerequisite for the offline reading feature described in `OFFLINE_MODE.md`.
3. **Home screen presence** — the app feels like a native tool rather than a browser tab.

The PWA transition is mostly additive: a manifest file, a service worker, icon assets, and behavioral changes to the `/save` page. The existing web app architecture (React + Vite + React Router) stays the same.

## 2. What Changes

| Before | After |
|--------|-------|
| Static SPA in a browser tab | Installable PWA with standalone window |
| Mobile save via iOS Shortcut or `/save` page | Share sheet save via PWA share target |
| No offline capability | App shell loads offline, service worker caches API data |
| No install prompt | Install guidance on mobile, `beforeinstallprompt` on Android/desktop Chrome |
| Favicon only | Full icon set (192, 512, maskable) + Apple splash screens |
| No `<meta name="theme-color">` | Black-and-white theme color matching the design language |

## 3. Web App Manifest

Create `apps/web/public/manifest.json`:

```json
{
  "name": "url-keep",
  "short_name": "url-keep",
  "description": "personal bookmark keeper",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#111111",
  "orientation": "any",
  "icons": [
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-512-maskable.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ],
  "share_target": {
    "action": "/save",
    "method": "GET",
    "params": {
      "url": "url",
      "title": "title",
      "text": "text"
    }
  }
}
```

### 3.1 Key manifest fields

- **`display: standalone`** — removes the browser chrome. The app runs in its own window with a status bar colored by `theme_color`.
- **`theme_color: #111111`** — dark status bar, matches the app's black-on-white design. The page content is white; the status bar contrast makes the app feel intentional.
- **`scope: /`** — the entire app is within PWA scope. Navigation to external URLs (opening a bookmarked article) will open in the system browser, not inside the PWA window. This is correct behavior.
- **`share_target`** — covered in detail in section 4.

### 3.2 HTML additions

Update `apps/web/index.html`:

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#111111" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <link rel="manifest" href="/manifest.json" />
  <link rel="icon" type="image/png" href="/url-keep-favicon.png" />
  <link rel="apple-touch-icon" href="/icons/icon-192.png" />
  <title>url-keep</title>
</head>
```

## 4. Share Target

This is the most impactful part of the PWA transition. It replaces the iOS Shortcut as the primary mobile save flow.

### 4.1 How it works

When the user shares a URL from any app (Safari, Chrome, Twitter, Slack, etc.):

1. The OS share sheet shows "url-keep" as a target (because the installed PWA registered a `share_target` in its manifest).
2. The user taps "url-keep."
3. The OS opens the PWA at `/save?url=<shared-url>&title=<shared-title>`.
4. The `/save` page receives the URL, saves it to the API, and shows confirmation.

### 4.2 Share target params

Different apps populate share data differently:

| Source app | `url` param | `title` param | `text` param |
|------------|-------------|---------------|--------------|
| Safari (iOS) | Page URL | Page title | Sometimes empty, sometimes URL again |
| Chrome (Android) | Page URL | Page title | Page URL (duplicated) |
| Twitter/X | Tweet URL | Empty | Tweet text + URL |
| Slack | Link URL | Empty | Message text + URL |
| Other apps | Varies | Varies | Varies |

The `/save` page must handle all combinations:

```typescript
// Extract the best URL from share params
function resolveSharedUrl(params: URLSearchParams): string {
  // Prefer explicit url param
  const url = params.get('url')?.trim();
  if (url && isValidHttpUrl(url)) return url;

  // Fall back to text param (some apps put the URL here)
  const text = params.get('text')?.trim();
  if (text) {
    // Extract URL from text if it contains one
    const urlMatch = text.match(/https?:\/\/\S+/);
    if (urlMatch) return urlMatch[0];
  }

  return '';
}

// Extract title if available
function resolveSharedTitle(params: URLSearchParams): string | undefined {
  const title = params.get('title')?.trim();
  return title || undefined;
}
```

### 4.3 Enhanced `/save` page: auto-save behavior

The current `/save` page pre-fills the URL and waits for the user to tap "save." For share target flow, this extra tap is unnecessary friction — the user already chose to share to url-keep, expressing clear intent.

New behavior:

```
If ?url= is present and contains a valid URL:
  → If authenticated:
      1. Auto-save immediately on mount.
      2. Show "saved" confirmation with the title/domain.
      3. Show "undo" link (deletes the bookmark).
      4. Show "open reading list" link to go to /.
      5. If running in standalone mode (PWA), offer to close the window.
  → If not authenticated:
      1. Redirect to /login with redirect back to /save?url=...
      2. After login, auto-save triggers.

If ?url= is empty or absent:
  → Show the current manual form (unchanged).
```

The auto-save only fires when the URL comes from a query param. If the user navigates to `/save` manually and types a URL, the existing form-with-button flow remains.

### 4.4 Title forwarding

The share target can provide a title. The current `POST /v1/bookmarks` already accepts an optional `title` field. The enhanced `/save` page should forward it:

```typescript
await auth.client.saveBookmark({
  url: resolvedUrl,
  title: resolvedTitle,  // from share target's ?title= param
  saved_via: 'mobile_web',
});
```

This means share-target saves from Safari/Chrome will get proper page titles on first save, matching what the extension provides. Currently, saves from the `/save` page only send the URL and rely on the server's fallback title (just the hostname). This is a meaningful improvement.

### 4.5 Comparison with iOS Shortcut

| | iOS Shortcut (current) | PWA Share Target (new) |
|-|------------------------|------------------------|
| Setup required | Create token, copy it, install Shortcut, paste token on first run | Install PWA to home screen (one tap) |
| Authentication | Separate per-device token | Shares web app's existing login session |
| Save UX | Completely silent (runs in background) | Opens PWA briefly, auto-saves, shows confirmation |
| Title capture | Only if iOS share payload includes it | Yes, from share params |
| Works offline | No (needs network) | No — offline mode is read-only (see OFFLINE_MODE.md) |
| Platform | iOS only | iOS 16.4+, Android, ChromeOS |
| Maintenance | Shortcut can break on iOS updates | Standard web API, maintained by browser vendors |

### 4.6 Shortcut coexistence

The iOS Shortcut should **not** be removed. It remains valuable for:

- Users on iOS < 16.4 (no Share Target support).
- Users who prefer completely silent saves (no app window opening).
- Automation workflows (Shortcuts can be chained with other actions).

The PWA share target becomes the **recommended** primary flow. The Shortcut becomes the **alternative** for power users and older devices.

Update the profile page copy:

```
Before:
  "create a token, copy it, then install the shortcut."

After:
  "install url-keep to your home screen for one-tap saving from the share sheet."
  Below: "alternatively, use an iOS Shortcut for silent background saves. [show setup]"
```

## 5. Installation UX

There is no way to force-install a PWA — the browser controls the install flow. The app's job is to guide the user.

### 5.1 Detecting install state

```typescript
function useInstallState() {
  const [isInstalled, setIsInstalled] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // Check if running as installed PWA
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true; // Safari on iOS
    setIsInstalled(isStandalone);

    // Capture Chrome/Edge install prompt
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  return { isInstalled, installPrompt };
}
```

### 5.2 Install banner

Show a subtle, dismissible install banner on mobile when:
- The app is **not** already installed (not in standalone mode).
- The user **is** authenticated (don't nag before login).
- The user has **not** dismissed the banner in this session.

Banner content varies by platform:

**Android (or when `beforeinstallprompt` is available):**
```
install url-keep for quick saving from the share sheet
[install]  [dismiss]
```
Tapping "install" calls `installPrompt.prompt()`.

**iOS Safari:**
```
install url-keep: tap the share button ↗ then "add to home screen"
[dismiss]
```
No programmatic install on iOS — the banner teaches the user the manual steps.

**Desktop Chrome:**
```
install url-keep as a desktop app
[install]  [dismiss]
```

### 5.3 Banner design

Following the style guide:
- Full-width bar at the top of the page, below the header.
- Thin top and bottom border (`1px solid var(--border)`).
- Muted text (`var(--muted)`).
- Plain text "install" and "dismiss" actions.
- No icons, no illustrations, no animation.
- Stores dismissal in `localStorage` (`url_keep_install_dismissed`). Reappears after 30 days.

### 5.4 Profile page install section

Add a permanent "install" section to the profile page (above or instead of the current Shortcut section when the app isn't installed):

```
## install

add url-keep to your home screen to save links from the share
sheet. no token setup required.

  [install]  (on Android/Desktop with beforeinstallprompt)

  on iphone: tap the share button in safari, then "add to home screen"
```

When the app **is** already installed, this section shows:

```
## install

url-keep is installed. share any link and choose url-keep to save it.
```

## 6. Standalone Mode Behavior

When the PWA runs in standalone mode (installed to home screen), the browser chrome is gone. The app needs to compensate.

### 6.1 Navigation

- There is no browser back button. iOS has swipe-back gesture; Android has the system back button. Both trigger `history.back()` in a standalone PWA.
- The `/read/:id` page (reader view from OFFLINE_MODE.md) and `/save` page must have an explicit back/home link in the header.
- The app already has a brand logo that links to `/` — this serves as the home button.

### 6.2 External links

- Clicking a bookmarked article's URL (`<a href="..." target="_blank">`) opens the system browser, not the PWA. This is correct — the user wants to see the original site.
- The "open original" link in the reader view should do the same.
- Links within the app (navigation between routes) stay inside the PWA.

### 6.3 Status bar

- `theme_color: #111111` gives a dark status bar on both iOS and Android.
- `apple-mobile-web-app-status-bar-style: black-translucent` allows the app content to extend under the iOS status bar with a translucent overlay.
- The app's white background means the dark status bar creates a clean contrast line — matches the document-like aesthetic.

### 6.4 Safe areas

On devices with notches or dynamic islands, use CSS `env()` for safe area insets:

```css
.page {
  padding-top: env(safe-area-inset-top, 0);
  padding-left: env(safe-area-inset-left, 0);
  padding-right: env(safe-area-inset-right, 0);
  padding-bottom: env(safe-area-inset-bottom, 0);
}
```

This prevents content from being hidden behind hardware features.

## 7. Service Worker

The service worker strategy is detailed in `OFFLINE_MODE.md` sections 6.2 and 6.3. This section covers only the PWA-specific aspects.

### 7.1 Registration

Use `vite-plugin-pwa` with `registerType: 'autoUpdate'`:

```
npm install -D vite-plugin-pwa
```

```typescript
// vite.config.ts
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        navigateFallback: '/index.html',
        navigateFallbackAllowlist: [/^(?!\/?v1\/).*/],
        // Runtime caching config from OFFLINE_MODE.md section 6.2
      },
      manifest: false, // Use the static manifest.json
    }),
  ],
});
```

`navigateFallback` ensures that deep links (like `/save?url=...` from the share target) work even when the page isn't in the precache. The service worker serves `index.html` and React Router handles the route.

`navigateFallbackAllowlist` excludes API paths (`/v1/...`) from the fallback, so API requests don't accidentally get the HTML shell.

### 7.2 Update behavior

`registerType: 'autoUpdate'` means:
- New service worker versions are detected automatically.
- The new version activates immediately on the next navigation (no "update available" prompt needed).
- For a single-user personal tool, this is the right default. No need for update UI.

### 7.3 Share target and offline

If the user shares a URL to url-keep while offline:

1. The service worker intercepts the navigation to `/save?url=...`.
2. It serves the cached `index.html` (from precache).
3. React Router renders the `/save` page.
4. The auto-save fires but the API call fails (offline).
5. The UI shows "saving requires a connection" with the URL displayed so the user can try again later.

Offline mode is read-only (see OFFLINE_MODE.md section 7.3). The share target gracefully handles the offline case but does not silently queue saves — the user gets clear feedback that the save didn't go through.

## 8. Icons and Splash Screens

### 8.1 Required icons

Generate from the existing `url-keep-favicon.png` (the globe+document icon):

| File | Size | Purpose |
|------|------|---------|
| `icons/icon-192.png` | 192x192 | Standard PWA icon, Android home screen |
| `icons/icon-512.png` | 512x512 | Splash screen, install dialog |
| `icons/icon-512-maskable.png` | 512x512 | Android adaptive icon (content in safe zone) |
| `icons/apple-touch-icon.png` | 180x180 | iOS home screen |

All icons should be the globe+document mark on a white background, black stroke, matching the existing favicon style.

### 8.2 Maskable icon

Android's adaptive icons crop to different shapes (circle, squircle, etc.). The maskable variant must keep the icon content within the inner 80% "safe zone" — a circle with diameter 80% of the icon size.

The existing favicon icon is centered with comfortable margins, so it should work as-is within the safe zone. Verify visually with https://maskable.app/.

### 8.3 Apple splash screens

iOS shows a splash screen while the PWA launches. Without explicit splash images, it shows a white screen with the icon. For url-keep's austere design, this is acceptable — no custom splash screens needed. The white background matches the app.

If desired later, `apple-touch-startup-image` media queries can target specific device sizes, but this is not worth the maintenance burden for v1.

### 8.4 Icon generation

Use a simple script or tool to resize from the existing high-res favicon:

```bash
# Using ImageMagick (or sips on macOS)
convert url-keep-favicon.png -resize 192x192 icons/icon-192.png
convert url-keep-favicon.png -resize 512x512 icons/icon-512.png
convert url-keep-favicon.png -resize 180x180 icons/apple-touch-icon.png

# Maskable: add padding so the icon sits in the center 80%
convert url-keep-favicon.png -resize 410x410 -gravity center \
  -extent 512x512 -background white icons/icon-512-maskable.png
```

Place all icons in `apps/web/public/icons/`.

## 9. Platform Behavior Matrix

| Capability | Chrome Android | Safari iOS (16.4+) | Safari iOS (<16.4) | Chrome Desktop | Firefox Desktop |
|------------|---------------|-------------------|-------------------|----------------|-----------------|
| Install to home screen | Yes | Yes (manual) | Yes (manual) | Yes | No |
| `beforeinstallprompt` | Yes | No | No | Yes | No |
| Share Target | Yes | Yes | No | No | No |
| Service Worker | Yes | Yes | Yes | Yes | Yes |
| Background Sync | Yes | No | No | Yes | No |
| Persistent storage | Yes | Yes (limited) | Yes (limited) | Yes | Yes |
| Push notifications | Yes | Yes | No | Yes | Yes |
| Standalone display | Yes | Yes | Yes | Yes | Yes |
| `navigator.share()` | Yes | Yes | Yes | Yes | Yes (partial) |

### 9.1 iOS-specific caveats

- **No `beforeinstallprompt`**: Cannot programmatically trigger install. Must teach users the "share → add to home screen" flow.
- **Cache eviction**: Safari may evict service worker caches after ~7 days of inactivity. Mitigated by storing critical data (bookmarks, articles) in IndexedDB, which is more persistent than Cache API on iOS.
- **Share Target requires iOS 16.4+**: Released March 2023. Older devices fall back to the iOS Shortcut.
- **Storage limits**: Safari grants ~1GB per origin. Sufficient for article text + images (see OFFLINE_MODE.md section 7.4).
- **No Background Sync**: Offline mode is read-only. Saves require a connection.

### 9.2 Android advantages

Android treats PWAs most favorably:
- Real install prompt via `beforeinstallprompt`.
- Share Target works reliably.
- Background Sync available (useful if offline writes are added later).
- Larger storage budgets.
- PWA shows in app switcher with its own icon.

This is relevant because url-keep currently has **no Android save path** (the iOS Shortcut is iOS-only). The PWA share target gives Android users a first-class save experience for the first time.

## 10. How the Mobile Save Flow Changes

### 10.1 Before (current state)

**iOS (primary):**
1. User goes to profile page in web app.
2. Creates a token, copies it.
3. Installs iOS Shortcut from iCloud link.
4. Runs Shortcut once, pastes token.
5. From then on: share URL → Shortcut saves silently.

**iOS (fallback):**
1. User copies a URL.
2. Opens url-keep in Safari, navigates to `/save`.
3. Pastes URL, taps "save."

**Android:**
1. User copies a URL.
2. Opens url-keep in browser, navigates to `/save`.
3. Pastes URL, taps "save."

### 10.2 After (with PWA)

**iOS 16.4+ and Android (primary):**
1. User opens url-keep in browser, logs in.
2. Installs PWA to home screen (one-time).
3. From then on: share URL → tap "url-keep" → saved automatically.

**iOS (alternative — power users):**
- iOS Shortcut remains available for silent background saves.
- Setup instructions move to a collapsible section on the profile page.

**Desktop Chrome:**
- Install PWA from browser.
- Opens as a standalone desktop window.
- No share target (desktop doesn't have a share sheet), but the app works as a dedicated window with offline support.

**Unsupported browsers:**
- Same as today: manual `/save` page, no install.

### 10.3 Reduction in friction

The iOS Shortcut setup requires **5 distinct actions** (create token, copy, install shortcut, run once, paste token). The PWA install requires **1 action** (add to home screen). After install, the save UX is comparable: share → one tap → saved.

## 11. Changes to Existing Code

### 11.1 `/save` page (MobileSavePage component)

This is the biggest code change. The page needs to handle three modes:

**Mode 1: Share target auto-save** (URL present in query params)
```
→ Resolve URL from ?url= or ?text= params.
→ Resolve optional title from ?title= param.
→ If authenticated, auto-save on mount.
→ Show confirmation with undo.
```

**Mode 2: Manual form** (no URL in query params)
```
→ Show current form (unchanged).
→ User types/pastes URL, taps save.
```

**Mode 3: Offline share** (URL present, no network)
```
→ Attempt save, catch network error.
→ Show "saving requires a connection" with the URL displayed.
→ User can retry when back online.
```

Rough component structure:

```typescript
function SavePage() {
  const auth = useAuth();
  const [searchParams] = useSearchParams();
  const sharedUrl = resolveSharedUrl(searchParams);
  const sharedTitle = resolveSharedTitle(searchParams);

  if (sharedUrl) {
    return (
      <AutoSave
        url={sharedUrl}
        title={sharedTitle}
      />
    );
  }

  return <ManualSaveForm />;  // current form
}
```

### 11.2 Profile page

Restructure the mobile setup section:

```
## save from your phone

  install url-keep to your home screen for one-tap saving
  from the share sheet.

  [install] or "tap share → add to home screen" (on iOS)

  ────────────────────────────────────

  ▸ alternative: ios shortcut (silent save)
    [collapsed by default, expands to show current token + shortcut setup]
```

When the app is already installed (detected via `display-mode: standalone`):

```
## save from your phone

  url-keep is installed. share any link and choose url-keep to save it.

  ▸ ios shortcut setup (alternative)
```

### 11.3 Navigation in standalone mode

When running as an installed PWA, add a back-arrow on pages that aren't `/`:

```typescript
function PageHeader({ showBack = false }: { showBack?: boolean }) {
  const navigate = useNavigate();
  const isStandalone = useIsStandalone();

  return (
    <header className="page-header row-between">
      <div className="header-left">
        {showBack && isStandalone ? (
          <button className="text-action" onClick={() => navigate(-1)}>
            &larr; back
          </button>
        ) : null}
        <BrandLogo />
      </div>
      <Nav />
    </header>
  );
}
```

### 11.4 `vercel.json`

The existing `vercel.json` already rewrites all paths to `index.html` for client-side routing. This also handles the share target's `/save?url=...` deep link. No changes needed.

## 12. Implementation Plan

### Step 1: Icons and manifest

- Generate icon set from existing favicon.
- Create `apps/web/public/manifest.json` with share target.
- Create `apps/web/public/icons/` directory.
- Update `apps/web/index.html` with manifest link, theme-color, apple meta tags.

### Step 2: Service worker

- Install `vite-plugin-pwa`.
- Configure in `apps/web/vite.config.ts`.
- Add precache patterns and navigate fallback.
- Runtime caching config (API, images) as per OFFLINE_MODE.md.
- Verify the service worker registers and precaches the app shell.

### Step 3: Install UX

- Add `useInstallState` hook (detect standalone, capture `beforeinstallprompt`).
- Add `useIsStandalone` hook.
- Add install banner component (dismissible, platform-aware).
- Add install section to profile page.
- Store dismissal state in localStorage.

### Step 4: Enhanced `/save` page

- Add `resolveSharedUrl` and `resolveSharedTitle` utilities.
- Split `SavePage` into auto-save and manual modes.
- Implement auto-save on mount when URL param is present.
- Add "saved" confirmation with undo action.
- Add "open reading list" link.
- Test with simulated share params (`/save?url=https://example.com&title=Test`).

### Step 5: Standalone mode polish

- Add safe-area-inset CSS.
- Add explicit back navigation on sub-pages when in standalone mode.
- Test standalone behavior on iOS and Android.

### Step 6: Profile page update

- Restructure mobile save section to lead with PWA install.
- Move iOS Shortcut setup to a collapsible alternative section.
- Show install state awareness (installed vs not).

### Step 7: Testing

- Test install flow on iOS Safari, Android Chrome, Desktop Chrome.
- Test share target on iOS 16.4+ and Android.
- Test share target with various source apps (Safari, Chrome, Twitter, Slack).
- Test fallback behavior on iOS < 16.4 (share target absent, Shortcut works).
- Test offline share target (shows connection-required message, URL is preserved).
- Test service worker update cycle.
- Test deep link behavior (opened via share target when app is not running).

## 13. Files Summary

```
New files:
  apps/web/public/manifest.json
  apps/web/public/icons/icon-192.png
  apps/web/public/icons/icon-512.png
  apps/web/public/icons/icon-512-maskable.png
  apps/web/public/icons/apple-touch-icon.png

Modified files:
  apps/web/index.html                   (manifest link, meta tags)
  apps/web/vite.config.ts               (vite-plugin-pwa)
  apps/web/src/App.tsx                   (SavePage rewrite, install banner,
                                          standalone nav, profile page update)
  apps/web/src/styles.css                (safe areas, install banner styles)
  apps/web/package.json                  (add vite-plugin-pwa dev dependency)
```

No API changes required. No shared package changes. No extension changes. The PWA is entirely a web-app-layer concern.

## 14. Relationship to OFFLINE_MODE.md

This plan and OFFLINE_MODE.md are designed to work together but can be implemented independently:

| PWA.md | OFFLINE_MODE.md |
|--------|-----------------|
| Manifest + install UX | Article extraction + D1 storage |
| Service worker (app shell) | Service worker (data caching) |
| Share target save flow | Offline bundle sync |
| Install banner | IndexedDB + SyncManager |
| Standalone mode polish | Reader view |
| — | R2 image storage |

**Recommended order**: Implement PWA.md first. It's smaller (no backend changes), immediately useful (share target replaces Shortcut complexity), and sets up the service worker foundation that OFFLINE_MODE.md builds on.

The service worker config in this plan (precaching + navigate fallback) is a subset of what OFFLINE_MODE.md describes. When implementing offline reading later, extend the existing service worker config rather than replacing it.

## 15. Open Questions

1. **Auto-save vs confirm**: Should the share target auto-save silently, or show the URL and require one tap? This plan recommends auto-save with an undo option. If users find accidental saves annoying, add a confirmation tap.

2. **`saved_via` value**: Share target saves currently use `saved_via: 'mobile_web'` (same as the manual `/save` form). Worth adding a `'share_target'` value to distinguish them? Requires a schema migration and CHECK constraint update. Not critical but useful for analytics. Can be added later.

3. **Close-on-save**: When running as a standalone PWA, should the app close after a successful share-target save? `window.close()` works in some contexts but not all. On iOS, the PWA stays open after share target activation — the user swipes away manually. Trying to auto-close may not be worth the platform inconsistency.

4. **Desktop PWA value**: The share target doesn't work on desktop. Is the desktop PWA install still worth supporting? Yes — it provides a dedicated window, offline app shell, and home screen/dock presence. The install banner should still show on desktop Chrome.
