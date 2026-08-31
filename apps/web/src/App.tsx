import { ApiError, UrlKeepClient } from "@url-keep/api-client";
import {
  classifyBookmarkUrl,
  toReadableBookmarkUrl,
  type ArticleContent,
  type Bookmark,
  type LoginResponse,
  type PublicShareArticle,
  type TokenItem,
  type User,
} from "@url-keep/shared";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  Moon,
  PencilLine,
  RefreshCw,
  Share2,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import {
  Navigate,
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { resolveBookmarkDestination } from "./bookmark-destination";
import { sanitizeArticleHtml } from "./article-sanitize";
import { detectStandaloneMode, shareLink } from "./pwa";
import {
  clearOfflineData,
  getOfflineReadableBookmarkIds,
  type OfflineArticle,
} from "./offline/db";
import { SyncManager } from "./offline/sync";
import { ArticleAudio } from "./audio/ArticleAudio";
import { auditOfflineAudio } from "./audio/offline-audio";
import { OfflineAudioSettings } from "./settings/OfflineAudioSettings";
import { saveBookmarkWithReader } from "./save-workflow";

const TOKEN_KEY = "url_keep_token";
const USER_KEY = "url_keep_user";
const IOS_SHORTCUT_TOKEN_NAME = "iphone shortcut";
const READER_TEXT_SIZE_KEY = "url_keep_reader_text_size";
const READER_THEME_KEY = "url_keep_reader_theme";
type ReaderTextSize = "s" | "m" | "l";
type ReaderTheme = "light" | "dark";
type MainTab = "all" | Bookmark["bucket"];

type ReaderLocationState = {
  bookmark?: Bookmark;
};

const READER_TEXT_SIZE_OPTIONS: Array<{ label: string; value: ReaderTextSize }> = [
  { label: "S", value: "s" },
  { label: "M", value: "m" },
  { label: "L", value: "l" },
];

function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(token: string | null) {
  try {
    if (token) {
      window.localStorage.setItem(TOKEN_KEY, token);
    } else {
      window.localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Ignore storage errors and keep in-memory auth.
  }
}

function readStoredUser(): User | null {
  try {
    const raw = window.localStorage.getItem(USER_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as User;
    return parsed?.id && parsed?.email ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredUser(user: User | null) {
  try {
    if (user) {
      window.localStorage.setItem(USER_KEY, JSON.stringify(user));
    } else {
      window.localStorage.removeItem(USER_KEY);
    }
  } catch {
    // Ignore storage errors and keep in-memory auth.
  }
}

function readStoredReaderTextSize(): ReaderTextSize {
  try {
    const raw = window.localStorage.getItem(READER_TEXT_SIZE_KEY);
    return raw === "s" || raw === "m" || raw === "l" ? raw : "m";
  } catch {
    return "m";
  }
}

function writeStoredReaderTextSize(value: ReaderTextSize) {
  try {
    window.localStorage.setItem(READER_TEXT_SIZE_KEY, value);
  } catch {
    // Ignore storage errors and keep the in-memory preference.
  }
}

function readStoredReaderTheme(): ReaderTheme {
  try {
    return window.localStorage.getItem(READER_THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function writeStoredReaderTheme(value: ReaderTheme) {
  try {
    window.localStorage.setItem(READER_THEME_KEY, value);
  } catch {
    // Ignore storage errors and keep the in-memory preference.
  }
}

function normalizeApiOrigin(value: string | undefined) {
  const fallback = "http://localhost:8787";
  const trimmed = value?.trim();

  if (!trimmed) {
    return fallback;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed.replace(/^\/+/, "")}`;

  try {
    return new URL(withProtocol).origin;
  } catch {
    return fallback;
  }
}

const API_ORIGIN = normalizeApiOrigin(import.meta.env.VITE_API_ORIGIN);
const BRAND_LOGO_URL = `${import.meta.env.BASE_URL}url-keep-logo.png`;

function normalizeOptionalAbsoluteUrl(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

const IOS_SHORTCUT_URL = normalizeOptionalAbsoluteUrl(
  import.meta.env.VITE_IOS_SHORTCUT_URL,
);

type AuthState = {
  token: string | null;
  user: User | null;
  client: UrlKeepClient;
  setSession: (session: LoginResponse) => void;
  logout: () => Promise<void>;
};

type OfflineState = {
  online: boolean;
  initialized: boolean;
  syncVersion: number;
  manager: SyncManager;
  refresh: (force?: boolean) => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);
const OfflineContext = createContext<OfflineState | null>(null);

function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("AuthContext not found");
  }
  return value;
}

function useOffline() {
  const value = useContext(OfflineContext);
  if (!value) {
    throw new Error("OfflineContext not found");
  }
  return value;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

function formatOptionalDate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

function formatSavedViaLabel(value: Bookmark["saved_via"]) {
  switch (value) {
    case "mobile_web":
      return "mobile web";
    case "ios_shortcut":
      return "iPhone shortcut";
    default:
      return value;
  }
}

function normalizeMetadataLabel(value: string | null | undefined) {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
}

function cleanMetadataLabel(value: string | null | undefined) {
  const cleaned = value?.trim().replace(/\s+/g, " ") ?? "";
  const pairs: Array<[string, string]> = [["\"", "\""], ["'", "'"], ["“", "”"]];
  const wrapping = pairs.find(([start, end]) => cleaned.startsWith(start) && cleaned.endsWith(end));
  return wrapping && cleaned.length > 2 ? cleaned.slice(1, -1).trim() : cleaned;
}

async function copyToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "absolute";
  input.style.left = "-9999px";
  document.body.append(input);
  input.select();

  const copied = document.execCommand("copy");
  input.remove();

  if (!copied) {
    throw new Error("copy failed");
  }
}

function useStandaloneMode() {
  const getStandaloneMode = () => {
    const media = window.matchMedia("(display-mode: standalone)");
    const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    return detectStandaloneMode(iosStandalone, media.matches);
  };
  const [standalone, setStandalone] = useState(getStandaloneMode);

  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    const update = () => {
      const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
      setStandalone(detectStandaloneMode(iosStandalone, media.matches));
    };
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  return standalone;
}

export function StandaloneControls({
  share,
  onNotice,
  reload = () => window.location.reload(),
}: {
  share?: { title: string; url: string };
  onNotice?: (message: string) => void;
  reload?: () => void;
}) {
  const standalone = useStandaloneMode();
  if (!standalone) return null;

  const onShare = async () => {
    if (!share) return;
    try {
      const result = await shareLink(
        share,
        navigator.share?.bind(navigator),
        copyToClipboard,
      );
      if (result === "copied") onNotice?.("link copied");
    } catch {
      onNotice?.("could not share link");
    }
  };

  return (
    <span className="standalone-controls">
      {share ? (
        <button
          aria-label="share"
          className="icon-action standalone-action"
          onClick={() => void onShare()}
          title="Share"
          type="button"
        >
          <Share2 aria-hidden="true" size={16} strokeWidth={1.75} />
        </button>
      ) : null}
      <button
        aria-label="refresh"
        className="icon-action standalone-action"
        onClick={reload}
        title="Refresh"
        type="button"
      >
        <RefreshCw aria-hidden="true" size={16} strokeWidth={1.75} />
      </button>
    </span>
  );
}

async function copyPreferredArticleLink({
  client,
  bookmarkId,
  sourceUrl,
  extractionStatus,
  preferReaderLink,
  online,
  onNotice,
}: {
  client: UrlKeepClient;
  bookmarkId: string;
  sourceUrl: string;
  extractionStatus?: Bookmark["extraction_status"] | ArticleContent["extraction_status"] | null;
  preferReaderLink: boolean;
  online: boolean;
  onNotice: (message: string) => void;
}) {
  if (preferReaderLink) {
    if (extractionStatus !== "complete") {
      onNotice("reader link unavailable");
      return;
    }

    if (!online) {
      onNotice("reader link requires a connection");
      return;
    }

    try {
      const response = await client.enableBookmarkShare(bookmarkId);
      if (response.item.share_url) {
        try {
          await copyToClipboard(response.item.share_url);
          onNotice("reader link copied");
        } catch {
          onNotice("reader link ready, but copy failed");
        }
        return;
      }
    } catch {
      onNotice("reader link unavailable");
      return;
    }

    onNotice("reader link unavailable");
    return;
  }

  const urlToCopy = toReadableBookmarkUrl(sourceUrl);
  try {
    await copyToClipboard(urlToCopy);
    onNotice("source link copied");
  } catch {
    onNotice("source link ready, but copy failed");
  }
}

function formatError(caught: unknown, fallback: string) {
  if (caught instanceof ApiError) {
    if (caught.code === "invalid_response") {
      return "the server returned something unexpected";
    }
    return caught.message;
  }

  return caught instanceof Error
    ? caught.message
    : fallback;
}

function getDomain(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function getBookmarkBucket(bookmark: Pick<Bookmark, "bucket" | "normalized_url">) {
  return bookmark.bucket ?? classifyBookmarkUrl(bookmark.normalized_url).bucket;
}

function filterBookmarksByTab(bookmarks: Bookmark[], query: string, tab: MainTab) {
  const needle = query.trim().toLowerCase();
  return bookmarks.filter((bookmark) => {
    if (tab !== "all" && getBookmarkBucket(bookmark) !== tab) {
      return false;
    }

    if (!needle) {
      return true;
    }

    return [bookmark.title, bookmark.url, bookmark.site_name ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
}

function parseMainTab(value: string | null): MainTab {
  return value === "reading" || value === "videos" ? value : "all";
}

function getEmptyStateMessage(tab: MainTab, hasQuery: boolean) {
  switch (tab) {
    case "reading":
      return hasQuery ? "no reading links matching your search" : "no reading links yet";
    case "videos":
      return hasQuery ? "no videos matching your search" : "no videos yet";
    default:
      return hasQuery ? "no bookmarks matching your search" : "no bookmarks yet";
  }
}

function estimateReadMinutes(wordCount: number) {
  return Math.max(1, Math.ceil(wordCount / 230));
}

function formatExtractionError(error: string | null | undefined): string {
  if (!error) {
    return "article extraction failed";
  }

  try {
    const parsed = JSON.parse(error) as Record<string, unknown>;
    const reason = parsed.reason as string | undefined;
    const httpStatus = parsed.http_status as number | undefined;

    switch (reason) {
      case "access_denied":
        return "this site blocked server access. save from the extension for full content.";
      case "fetch_error":
        return httpStatus
          ? `could not reach this page (HTTP ${httpStatus})`
          : "could not reach this page";
      case "timeout":
        return "page took too long to respond";
      case "unsupported_content_type":
        return `this page is not an article (${parsed.content_type ?? "unknown type"})`;
      case "transport_overflow":
        return "this page is too large for reader extraction";
      case "stored_content_too_large":
        return "the readable article is too large to store";
      case "no_readable_content":
        return "no article content found on this page";
      case "parse_error":
      case "readability_error":
        return "this page's markup confused the server reader. save from the extension for full content.";
      default:
        return error;
    }
  } catch {
    // Extraction errors created by the current API may still be plain text.
    return error;
  }
}

function BrandLogo() {
  return (
    <Link
      aria-label="url-keep home"
      className="brand-mark"
      to="/"
    >
      <img
        alt="url-keep"
        className="brand-logo"
        height={360}
        src={BRAND_LOGO_URL}
        width={1400}
      />
    </Link>
  );
}

function Nav() {
  const auth = useAuth();
  const offline = useOffline();

  return (
    <nav className="nav">
      <StandaloneControls />
      {!offline.online ? <span className="offline-badge">offline</span> : null}
      <Link className="text-action" to="/add">add url</Link>
      <span aria-hidden="true" className="nav-sep">|</span>
      <Link className="text-action" to="/settings">settings</Link>
      <span aria-hidden="true" className="nav-sep">|</span>
      <button className="text-action" onClick={() => void auth.logout()} type="button">
        log out
      </button>
    </nav>
  );
}

function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => readStoredToken());
  const [user, setUser] = useState<User | null>(() => readStoredUser());

  const clearLocalAuth = useCallback(() => {
    setTokenState(null);
    setUser(null);
    writeStoredToken(null);
    writeStoredUser(null);
    void clearOfflineData();
  }, []);

  const client = useMemo(
    () =>
      new UrlKeepClient({
        baseUrl: API_ORIGIN,
        getToken: () => token,
        onUnauthorized: clearLocalAuth,
      }),
    [token, clearLocalAuth],
  );

  const setSession = (session: LoginResponse) => {
    setTokenState(session.token);
    setUser(session.user);
    writeStoredToken(session.token);
    writeStoredUser(session.user);
  };

  const logout = async () => {
    try {
      await client.logout();
    } catch {
      // Local auth still needs clearing even if the network request fails.
    } finally {
      clearLocalAuth();
    }
  };

  useEffect(() => {
    let active = true;
    if (!token) {
      setUser(null);
      writeStoredUser(null);
      return;
    }

    void client.me().then((response) => {
      if (!active) return;
      setUser(response.user);
      writeStoredUser(response.user);
    }).catch((caught) => {
      if (active && caught instanceof ApiError && caught.status === 401) {
        clearLocalAuth();
      }
    });

    return () => {
      active = false;
    };
  }, [client, token, clearLocalAuth]);

  const value = useMemo<AuthState>(
    () => ({ token, user, client, setSession, logout }),
    [token, user, client],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function OfflineProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const online = useOnlineStatus();
  const [initialized, setInitialized] = useState(false);
  const [syncVersion, setSyncVersion] = useState(0);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);

  const manager = useMemo(
    () => new SyncManager(
      auth.client,
      (partial) => setStorageNotice(partial ? "offline article coverage is partial" : null),
    ),
    [auth.client],
  );

  const managerRef = useRef(manager);
  managerRef.current = manager;

  useEffect(() => {
    setInitialized(false);
  }, [manager]);

  useEffect(() => {
    void auditOfflineAudio();
    const onBlocked = (event: Event) => {
      setStorageNotice(
        (event as CustomEvent<string>).detail
          ?? "Close other URL Keep tabs, then reload.",
      );
    };
    window.addEventListener("url-keep:database-blocked", onBlocked);
    return () => window.removeEventListener("url-keep:database-blocked", onBlocked);
  }, []);

  const refresh = useCallback(async (force = false) => {
    if (!auth.token || !online) {
      return;
    }

    if (!force) {
      if (!(await managerRef.current.isStale())) {
        return;
      }
    }

    try {
      await managerRef.current.syncOnce();
      setSyncVersion((current) => current + 1);
    } catch {
      // Foreground state remains usable; the next foreground trigger retries.
    }
  }, [auth.token, online]);

  // Mount sync
  useEffect(() => {
    if (!auth.token || !online) {
      setInitialized(true);
      return;
    }

    void refresh(true).finally(() => setInitialized(true));
  }, [auth.token, online, manager]);

  // Visibility change sync
  useEffect(() => {
    if (!auth.token || !online) {
      return;
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [auth.token, online, refresh]);

  const value = useMemo<OfflineState>(
    () => ({
      online,
      initialized,
      syncVersion,
      manager,
      refresh,
    }),
    [online, initialized, syncVersion, manager, refresh],
  );

  return (
    <OfflineContext.Provider value={value}>
      {storageNotice ? <div className="app-notice" role="alert">{storageNotice}</div> : null}
      {children}
    </OfflineContext.Provider>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();

  if (!auth.token) {
    const redirect = `${location.pathname}${location.search}`;
    return <Navigate replace to={`/login?redirect=${encodeURIComponent(redirect)}`} />;
  }

  return <>{children}</>;
}

function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const redirect = searchParams.get("redirect") ?? "/";

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      const response: LoginResponse = await auth.client.login({
        email,
        password,
        client_name: "web app",
      });
      auth.setSession(response);
      navigate(redirect, { replace: true });
    } catch (caught) {
      setError(formatError(caught, "login failed"));
    }
  };

  return (
    <div className="page narrow">
      <header className="page-header standalone-header">
        <BrandLogo />
        <StandaloneControls />
      </header>
      <form className="stack" onSubmit={onSubmit}>
        <label className="field">
          <span>email</span>
          <input
            autoComplete="email"
            name="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="field">
          <span>password</span>
          <input
            autoComplete="current-password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button className="button" type="submit">
          log in
        </button>
        {error ? <p className="error">{error}</p> : null}
      </form>
    </div>
  );
}

function BookmarkImage({ src, alt }: { src?: string | null; alt: string }) {
  const [hidden, setHidden] = useState(false);
  if (!src) {
    return null;
  }

  return (
    <img
      alt={hidden ? "" : alt}
      aria-hidden={hidden || undefined}
      className={`bookmark-image${hidden ? " is-hidden" : ""}`}
      loading="lazy"
      referrerPolicy="no-referrer"
      src={src}
      onError={() => setHidden(true)}
    />
  );
}

function articleContainsImage(html: string, imageUrl: string, sourceUrl: string): boolean {
  const template = document.createElement("template");
  template.innerHTML = html;

  let target: string;
  try {
    target = new URL(imageUrl, sourceUrl).toString();
  } catch {
    return false;
  }

  return [...template.content.querySelectorAll("img[src]")].some((image) => {
    try {
      return new URL(image.getAttribute("src")!, sourceUrl).toString() === target;
    } catch {
      return false;
    }
  });
}

function ReaderLeadImage({ src }: { src: string }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  return (
    <figure className="reader-lead-image">
      <img
        alt=""
        referrerPolicy="no-referrer"
        src={src}
        onError={() => setHidden(true)}
      />
    </figure>
  );
}

export function ReaderDocument({
  header,
  title,
  sourceUrl,
  imageUrl,
  siteName,
  author,
  publishedDate,
  wordCount,
  contentHtml,
  extractionStatus,
  extractionError,
  sourceAvailable = true,
  shareAction,
  audioControl,
}: {
  header: ReactNode;
  title: string;
  sourceUrl: string;
  imageUrl?: string | null;
  siteName?: string | null;
  author?: string | null;
  publishedDate?: string | null;
  wordCount?: number | null;
  contentHtml?: string | null;
  extractionStatus: ArticleContent["extraction_status"];
  extractionError?: string | null;
  sourceAvailable?: boolean;
  shareAction?: {
    busy: boolean;
    onClick: () => void;
  };
  audioControl?: ReactNode;
}) {
  const [textSize, setTextSize] = useState<ReaderTextSize>(() => readStoredReaderTextSize());
  const [theme, setTheme] = useState<ReaderTheme>(() => readStoredReaderTheme());
  const [preferencesMenuOpen, setPreferencesMenuOpen] = useState(false);
  const preferencesControlRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    writeStoredReaderTextSize(textSize);
  }, [textSize]);

  useEffect(() => {
    writeStoredReaderTheme(theme);
  }, [theme]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.readerTheme = theme;

    return () => {
      delete root.dataset.readerTheme;
    };
  }, [theme]);

  useEffect(() => {
    if (!preferencesMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (preferencesControlRef.current?.contains(target)) {
        return;
      }

      setPreferencesMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreferencesMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [preferencesMenuOpen]);

  const html = useMemo(
    () => contentHtml ? sanitizeArticleHtml(contentHtml, API_ORIGIN) : null,
    [contentHtml],
  );
  const resolvedPublishedDate = formatOptionalDate(publishedDate);
  const readMinutes = wordCount ? estimateReadMinutes(wordCount) : null;
  const sourceHref = toReadableBookmarkUrl(sourceUrl);
  const cleanedAuthor = cleanMetadataLabel(author);
  const cleanedSiteName = cleanMetadataLabel(siteName);
  const normalizedAuthor = normalizeMetadataLabel(cleanedAuthor);
  const normalizedSiteName = normalizeMetadataLabel(cleanedSiteName);
  const primarySourceLabel = cleanedSiteName || cleanedAuthor || null;
  const secondaryAuthorLabel =
    cleanedSiteName && cleanedAuthor && normalizedAuthor !== normalizedSiteName
      ? cleanedAuthor
      : null;
  const showLeadImage = useMemo(
    () => Boolean(
      imageUrl
      && html
      && !articleContainsImage(html, imageUrl, sourceUrl),
    ),
    [html, imageUrl, sourceUrl],
  );

  return (
    <>
      <header className="page-header reader-page-header">
        <span className="reader-page-leading">{header}</span>
        <span aria-label="Reader controls" className="reader-toolbar" role="toolbar">
          {shareAction ? (
            <button
              aria-label={shareAction.busy ? "Sharing article" : "Share article"}
              className="reader-toolbar-action"
              disabled={shareAction.busy}
              onClick={shareAction.onClick}
              title={shareAction.busy ? "Sharing" : "Share"}
              type="button"
            >
              <Share2 aria-hidden="true" size={16} strokeWidth={1.8} />
            </button>
          ) : null}
          {audioControl}
          <span className="reader-preferences-control" ref={preferencesControlRef}>
            <button
              aria-expanded={preferencesMenuOpen}
              aria-label="Reading preferences"
              className="reader-toolbar-action reader-preferences-trigger"
              onClick={() => setPreferencesMenuOpen((open) => !open)}
              title="Reading preferences"
              type="button"
            >
              Aa
            </button>
            {preferencesMenuOpen ? (
              <span
                aria-label="Reading preferences"
                className="reader-preferences-menu"
                role="group"
              >
                <span aria-label="Text size" className="reader-preferences-options" role="group">
                  {READER_TEXT_SIZE_OPTIONS.map((option) => (
                    <button
                      aria-label={`${option.label} text size`}
                      aria-pressed={textSize === option.value}
                      className={`reader-preference-option${textSize === option.value ? " is-active" : ""}`}
                      key={option.value}
                      onClick={() => setTextSize(option.value)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </span>
                <span aria-hidden="true" className="reader-preferences-divider" />
                <button
                  aria-label={`Switch to ${theme === "light" ? "dark" : "light"} reader theme`}
                  className="reader-preference-option"
                  onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
                  title={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
                  type="button"
                >
                  {theme === "light"
                    ? <Moon aria-hidden="true" size={14} strokeWidth={1.8} />
                    : <Sun aria-hidden="true" size={14} strokeWidth={1.8} />}
                </button>
              </span>
            ) : null}
          </span>
          {sourceAvailable ? (
            <a
              aria-label="Read on web"
              className="reader-toolbar-action"
              href={sourceHref}
              rel="noopener noreferrer"
              target="_blank"
              title="Read on web"
            >
              <ArrowUpRight aria-hidden="true" size={16} strokeWidth={1.8} />
            </a>
          ) : (
            <span
              aria-disabled="true"
              aria-label="Read on web unavailable offline"
              className="reader-toolbar-action is-disabled"
              title="Unavailable offline"
            >
              <ArrowUpRight aria-hidden="true" size={16} strokeWidth={1.8} />
            </span>
          )}
        </span>
      </header>
      <article className="reader-shell">
        <header className="reader-header">
          <h1>{title}</h1>
          <div className="reader-meta">
            {primarySourceLabel ? <span className="reader-meta-item">{primarySourceLabel}</span> : null}
            {secondaryAuthorLabel ? <span className="reader-meta-item">{secondaryAuthorLabel}</span> : null}
            {readMinutes && wordCount ? (
              <span
                aria-label={`${readMinutes} min read, ${wordCount.toLocaleString()} words`}
                className="reader-meta-item reader-meta-tooltip"
                title={`${wordCount.toLocaleString()} words`}
              >
                {readMinutes} min read
              </span>
            ) : null}
            {resolvedPublishedDate ? <span className="reader-meta-item">{resolvedPublishedDate}</span> : null}
          </div>
        </header>

        {showLeadImage && imageUrl ? (
          <ReaderLeadImage key={imageUrl} src={imageUrl} />
        ) : null}

        {extractionStatus === "complete" && html ? (
          <div
            className={`reader-content reader-content-size-${textSize}`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="reader-empty">
            <p>
              {extractionStatus === "pending" && "article extraction is still running"}
              {extractionStatus === "failed" && formatExtractionError(extractionError)}
              {extractionStatus === "skipped" && formatExtractionError(extractionError)}
              {!contentHtml && extractionStatus === "complete" && "article content is not available yet"}
            </p>
          </div>
        )}
      </article>
    </>
  );
}

export function DeleteConfirmation({
  bookmark,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  bookmark: Bookmark;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      aria-labelledby="delete-bookmark-title"
      className="confirm-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      ref={dialogRef}
    >
      <h2 id="delete-bookmark-title">delete bookmark?</h2>
      <p>&ldquo;{bookmark.title}&rdquo;</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="confirm-dialog-actions">
        <button autoFocus className="button secondary-button" disabled={busy} onClick={onCancel} type="button">
          cancel
        </button>
        <button className="button button-danger" disabled={busy} onClick={onConfirm} type="button">
          {busy ? "deleting…" : "delete"}
        </button>
      </div>
    </dialog>
  );
}

function BookmarkRow({
  bookmark,
  availableOffline,
  online,
  onDelete,
  onShareNotice,
  onTitleUpdated,
  onRetryExtraction,
}: {
  bookmark: Bookmark;
  availableOffline: boolean;
  online: boolean;
  onDelete: (bookmark: Bookmark) => void;
  onShareNotice: (message: string) => void;
  onTitleUpdated: (bookmark: Bookmark, title: string) => Promise<void>;
  onRetryExtraction: (bookmark: Bookmark) => Promise<void>;
}) {
  const auth = useAuth();
  const classification = classifyBookmarkUrl(bookmark.normalized_url);
  const autoExtract = classification.autoExtract;
  const canRead = autoExtract && bookmark.extraction_status === "complete";
  const destination = resolveBookmarkDestination(bookmark, online, availableOffline);
  const primaryActionLabel = classification.defaultAction ?? (canRead ? "read" : "open");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(bookmark.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const copyLinkLabel = canRead ? "copy public reader link" : "copy source link";
  const copyingLinkLabel = canRead ? "copying public reader link" : "copying source link";

  useEffect(() => {
    setTitle(bookmark.title);
  }, [bookmark.title]);

  const saveEdit = async () => {
    if (!title.trim()) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onTitleUpdated(bookmark, title.trim());
      setEditing(false);
    } catch (caught) {
      setError(formatError(caught, "save failed"));
    } finally {
      setBusy(false);
    }
  };
  const copyArticleLink = async () => {
    setShareBusy(true);
    try {
      await copyPreferredArticleLink({
        client: auth.client,
        bookmarkId: bookmark.id,
        sourceUrl: bookmark.url,
        extractionStatus: bookmark.extraction_status,
        preferReaderLink: canRead,
        online,
        onNotice: onShareNotice,
      });
    } finally {
      setShareBusy(false);
    }
  };

  return (
    <article className="bookmark-row">
      <div className="bookmark-meta">
        <span
          aria-label={`Saved ${formatDate(bookmark.created_at)} via ${formatSavedViaLabel(bookmark.saved_via)}`}
          className="bookmark-meta-date"
          tabIndex={0}
        >
          <span>{formatDate(bookmark.created_at)}</span>
          <span className="bookmark-meta-tooltip-card" role="tooltip">
            saved via {formatSavedViaLabel(bookmark.saved_via)}
          </span>
        </span>
        <button
          aria-label={shareBusy ? copyingLinkLabel : copyLinkLabel}
          className="icon-action bookmark-meta-share"
          disabled={shareBusy}
          onClick={() => void copyArticleLink()}
          title={shareBusy ? copyingLinkLabel : copyLinkLabel}
          type="button"
        >
          <Share2 aria-hidden="true" size={16} strokeWidth={1.75} />
        </button>
        {autoExtract && bookmark.extraction_status && bookmark.extraction_status !== "complete" ? (
          <span className="extraction-status">
            {bookmark.extraction_status}
            {online && (bookmark.extraction_status === "pending" || bookmark.extraction_status === "failed" || bookmark.extraction_status === "skipped") ? (
              <button
                aria-label="retry extraction"
                className="retry-button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  onRetryExtraction(bookmark)
                    .then(() => setBusy(false))
                    .catch((caught) => {
                      setError(formatError(caught, "retry failed"));
                      setBusy(false);
                    });
                }}
                title="Retry article extraction"
                type="button"
              >
                <RefreshCw aria-hidden="true" size={11} strokeWidth={2} />
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="bookmark-main">
        <div className="bookmark-content">
          <div className="bookmark-copy">
            {editing ? (
              <div className="inline-edit">
                <input
                  aria-label="title"
                  disabled={!online || busy}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void saveEdit();
                    }
                    if (event.key === "Escape") {
                      setEditing(false);
                      setTitle(bookmark.title);
                    }
                  }}
                />
              </div>
            ) : (
              <>
                <div className="bookmark-title-row">
                  {destination.kind === "reader" ? (
                    <Link
                      className="bookmark-title"
                      state={{ bookmark }}
                      to={destination.href}
                    >
                      {bookmark.title}
                    </Link>
                  ) : destination.kind === "source" ? (
                    <a
                      className="bookmark-title"
                      href={destination.href}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {bookmark.title}
                    </a>
                  ) : (
                    <span className="bookmark-title bookmark-title--unavailable">
                      {bookmark.title}
                    </span>
                  )}
                </div>
                <p className="bookmark-domain">{getDomain(bookmark.url)}</p>
              </>
            )}
          </div>
          <BookmarkImage
            alt={bookmark.title}
            key={bookmark.image_url ?? "no-image"}
            src={bookmark.image_url}
          />
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>
      <div className="bookmark-side">
        <div className="bookmark-actions">
          <div className="bookmark-primary-actions">
            {destination.kind === "reader" ? (
              <Link
                className="text-action bookmark-primary-link"
                state={{ bookmark }}
                to={destination.href}
              >
                <BookOpen aria-hidden="true" size={14} strokeWidth={1.75} />
                <span>read</span>
              </Link>
            ) : destination.kind === "source" ? (
              <a
                className="text-action bookmark-primary-link"
                href={destination.href}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ArrowUpRight aria-hidden="true" size={13} strokeWidth={1.9} />
                <span>{primaryActionLabel}</span>
              </a>
            ) : (
              <span
                aria-disabled="true"
                className="text-action bookmark-primary-link is-disabled"
                title="Unavailable offline"
              >
                <ArrowUpRight aria-hidden="true" size={13} strokeWidth={1.9} />
                <span>{primaryActionLabel}</span>
              </span>
            )}
          </div>
          <div className="icon-actions">
            {editing ? (
              <button
                aria-label="save title"
                className="icon-action icon-action--confirm"
                disabled={!online || busy}
                onClick={() => void saveEdit()}
                title="Save title"
                type="button"
              >
                <Check aria-hidden="true" size={16} strokeWidth={2.25} />
              </button>
            ) : (
              <button
                aria-label="edit title"
                className="icon-action"
                disabled={!online}
                onClick={() => {
                  setEditing(true);
                }}
                title={online ? "Edit title" : "Editing requires a connection"}
                type="button"
              >
                <PencilLine aria-hidden="true" size={16} strokeWidth={1.75} />
              </button>
            )}

            {editing ? (
              <button
                aria-label="cancel edit"
                className="icon-action"
                onClick={() => {
                  setEditing(false);
                  setTitle(bookmark.title);
                }}
                title="Cancel edit"
                type="button"
              >
                <X aria-hidden="true" size={16} strokeWidth={1.75} />
              </button>
            ) : (
              <button
                aria-label="delete bookmark"
                className="icon-action"
                disabled={!online}
                onClick={() => onDelete(bookmark)}
                title={online ? "Delete bookmark" : "Deleting requires a connection"}
                type="button"
              >
                <Trash2 aria-hidden="true" size={16} strokeWidth={1.75} />
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function MainPage() {
  const auth = useAuth();
  const offline = useOffline();
  const [searchParams, setSearchParams] = useSearchParams();
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [offlineReadableIds, setOfflineReadableIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: number; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Bookmark | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const activeTab = parseMainTab(searchParams.get("tab"));
  const query = searchParams.get("q") ?? "";
  const hasQuery = query.trim().length > 0;

  useEffect(() => {
    let active = true;
    setError(null);
    void Promise.all([
      offline.manager.getBookmarks(),
      getOfflineReadableBookmarkIds(),
    ]).then(([items, readableIds]) => {
      if (!active) return;
      setBookmarks(filterBookmarksByTab(items, query, activeTab));
      setOfflineReadableIds(readableIds);
    }).catch((caught) => {
      if (active) setError(formatError(caught, "load failed"));
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [activeTab, query, offline.online, offline.syncVersion]);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const id = window.setTimeout(() => {
      setNotice((current) => (current?.id === notice.id ? null : current));
    }, 2800);

    return () => window.clearTimeout(id);
  }, [notice]);

  const showNotice = (message: string) => {
    setNotice({
      id: Date.now(),
      message,
    });
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    if (!offline.online) {
      setDeleteError("deleting requires a connection");
      return;
    }
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await auth.client.deleteBookmarkByUrl(deleteTarget.url);
      setBookmarks((current) => current.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
      void offline.refresh(true);
    } catch (caught) {
      setDeleteError(formatError(caught, "delete failed"));
    } finally {
      setDeleteBusy(false);
    }
  };

  const onTitleUpdated = async (bookmark: Bookmark, title: string) => {
    if (!offline.online) {
      throw new Error("editing requires a connection");
    }

    const response = await auth.client.updateBookmarkTitle(bookmark.id, { title });
    setBookmarks((current) =>
      current.map((item) => (item.id === bookmark.id ? response.item.bookmark : item)),
    );
    void offline.refresh(true);
  };

  const onRetryExtraction = async (bookmark: Bookmark) => {
    if (!offline.online) {
      throw new Error("retry requires a connection");
    }

    const response = await auth.client.extractBookmark(bookmark.id, true);
    setBookmarks((current) =>
      current.map((item) =>
        item.id === bookmark.id
          ? {
              ...response.item.bookmark,
              extraction_status: response.item.article?.status ?? null,
            }
          : item,
      ),
    );
    void offline.refresh(true);
  };

  const onSearchChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value.trim()) {
      next.set("q", value);
    } else {
      next.delete("q");
    }
    setSearchParams(next, { replace: true });
  };

  const getTabHref = (tab: MainTab) => {
    const next = new URLSearchParams(searchParams);
    if (tab === "all") {
      next.delete("tab");
    } else {
      next.set("tab", tab);
    }

    const serialized = next.toString();
    return serialized ? `/?${serialized}` : "/";
  };

  return (
    <div className="page">
      {notice ? (
        <div aria-live="polite" className="app-notice" role="status">
          {notice.message}
        </div>
      ) : null}
      <header className="page-header row-between">
        <BrandLogo />
        <Nav />
      </header>

      <section className="toolbar">
        {!offline.online ? (
          <p className="muted block-muted">offline mode is read-only</p>
        ) : null}
        <div className="toolbar-main">
          <nav aria-label="bookmark filters" className="list-tabs">
            {([
              { label: "ALL", value: "all" },
              { label: "READING", value: "reading" },
              { label: "VIDEOS", value: "videos" },
            ] as const).map((tab) => (
              <Link
                key={tab.value}
                aria-current={activeTab === tab.value ? "page" : undefined}
                className={`list-tab${activeTab === tab.value ? " is-active" : ""}`}
                to={getTabHref(tab.value)}
              >
                {tab.label}
              </Link>
            ))}
          </nav>
          <input
            aria-label="search"
            placeholder="search"
            value={query}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>
      </section>

      {error ? <p className="error">{error}</p> : null}
      {!loading && offline.initialized && !error && bookmarks.length === 0 ? (
        <p className="muted block-muted">{getEmptyStateMessage(activeTab, hasQuery)}</p>
      ) : null}

      <section aria-busy={loading || !offline.initialized} aria-label="bookmarks" className="bookmark-list">
        {bookmarks.map((bookmark) => (
          <BookmarkRow
            key={bookmark.id}
            availableOffline={offlineReadableIds.has(bookmark.id)}
            bookmark={bookmark}
            online={offline.online}
            onDelete={(item) => {
              setDeleteError(null);
              setDeleteTarget(item);
            }}
            onRetryExtraction={onRetryExtraction}
            onShareNotice={showNotice}
            onTitleUpdated={onTitleUpdated}
          />
        ))}
      </section>
      {deleteTarget ? (
        <DeleteConfirmation
          bookmark={deleteTarget}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => {
            setDeleteError(null);
            setDeleteTarget(null);
          }}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </div>
  );
}

function AddPage() {
  const auth = useAuth();
  const offline = useOffline();
  const [urlInput, setUrlInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "success">("idle");

  useEffect(() => {
    if (saveStatus !== "success") return;
    const timeoutId = window.setTimeout(() => setSaveStatus("idle"), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [saveStatus]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!offline.online) {
      setError("saving requires a connection");
      return;
    }

    setSaveStatus("saving");
    try {
      await saveBookmarkWithReader(auth.client, {
        url: urlInput,
        saved_via: "web",
      });
      setSaveStatus("success");
      setUrlInput("");
      void offline.refresh(true);
    } catch (caught) {
      setSaveStatus("idle");
      setError(formatError(caught, "save failed"));
    }
  };

  return (
    <div className="page">
      <header className="page-header row-between">
        <BrandLogo />
        <Nav />
      </header>
      <form className="stack add-url-form" onSubmit={onSubmit}>
        <label className="field">
          <span>url</span>
          <input
            placeholder="https://..."
            value={urlInput}
            onChange={(event) => {
              setUrlInput(event.target.value);
              setSaveStatus("idle");
            }}
          />
        </label>
        <button
          aria-live="polite"
          className={`button${saveStatus === "success" ? " button-success" : ""}`}
          disabled={!offline.online || saveStatus !== "idle"}
          type="submit"
        >
          {saveStatus === "idle" ? "save" : saveStatus === "saving" ? "saving…" : "success"}
        </button>
        {!offline.online ? <p className="muted">saving requires a connection</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </form>
    </div>
  );
}

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveSharedUrl(params: URLSearchParams): string {
  const url = params.get("url")?.trim();
  if (url && isValidHttpUrl(url)) return url;

  const text = params.get("text")?.trim();
  if (text) {
    const match = text.match(/https?:\/\/\S+/);
    if (match) return match[0];
  }

  return "";
}

function resolveSharedTitle(params: URLSearchParams): string | undefined {
  const title = params.get("title")?.trim();
  return title || undefined;
}

function AutoSave({
  url,
  title,
}: {
  url: string;
  title: string | undefined;
}) {
  const auth = useAuth();
  const offline = useOffline();
  const [status, setStatus] = useState<"saving" | "saved" | "error">("saving");
  const [error, setError] = useState<string | null>(null);
  const [undone, setUndone] = useState(false);
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;

    if (!offline.online) {
      setStatus("error");
      setError("saving requires a connection");
      return;
    }

    const save = async () => {
      try {
        await saveBookmarkWithReader(auth.client, {
          url,
          title,
          saved_via: "mobile_web",
        });
        setStatus("saved");
        void offline.refresh(true);
      } catch (caught) {
        setStatus("error");
        setError(formatError(caught, "save failed"));
      }
    };

    void save();
  }, []);

  const onUndo = async () => {
    try {
      await auth.client.deleteBookmarkByUrl(url);
      setUndone(true);
      void offline.refresh(true);
    } catch (caught) {
      setError(formatError(caught, "undo failed"));
    }
  };

  const domain = getDomain(url);

  return (
    <div className="page narrow">
      <header className="page-header standalone-header">
        <div className="page-heading-group">
          <BrandLogo />
          <p className="page-kicker">save</p>
        </div>
        <StandaloneControls />
      </header>
      <div className="stack">
        {status === "saving" ? <p>saving...</p> : null}
        {status === "saved" && !undone ? (
          <>
            <p>saved {title ?? domain}</p>
            <div className="inline-actions">
              <Link className="text-action" to="/">open reading list</Link>
              <button className="text-action" onClick={() => void onUndo()} type="button">
                undo
              </button>
            </div>
          </>
        ) : null}
        {undone ? <p className="muted">removed</p> : null}
        {status === "error" ? (
          <>
            <p className="error">{error}</p>
            <p className="muted">{url}</p>
          </>
        ) : null}
      </div>
    </div>
  );
}

function MobileSavePage() {
  const auth = useAuth();
  const offline = useOffline();
  const [searchParams] = useSearchParams();

  const sharedUrl = resolveSharedUrl(searchParams);
  const sharedTitle = resolveSharedTitle(searchParams);

  const [urlInput, setUrlInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (sharedUrl) {
    return <AutoSave url={sharedUrl} title={sharedTitle} />;
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (!offline.online) {
      setError("saving requires a connection");
      return;
    }

    try {
      await saveBookmarkWithReader(auth.client, {
        url: urlInput,
        saved_via: "mobile_web",
      });
      setMessage("saved");
      void offline.refresh(true);
    } catch (caught) {
      setError(formatError(caught, "save failed"));
    }
  };

  return (
    <div className="page narrow">
      <header className="page-header standalone-header">
        <div className="page-heading-group">
          <BrandLogo />
          <p className="page-kicker">save</p>
        </div>
        <StandaloneControls />
      </header>
      <form className="stack" onSubmit={onSubmit}>
        <label className="field">
          <span>url</span>
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
          />
        </label>
        <button className="button" disabled={!offline.online} type="submit">
          save
        </button>
        {!offline.online ? <p className="muted">saving requires a connection</p> : null}
        {message ? <p>{message}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </form>
    </div>
  );
}

function TokenRow({
  online,
  token,
  onRevoke,
}: {
  online: boolean;
  token: TokenItem;
  onRevoke: (id: string) => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) {
      return;
    }

    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);

  return (
    <div className="token-row">
      <span>{token.name}</span>
      <span className="muted">{formatDate(token.created_at)}</span>
      {token.current ? <span className="muted">current</span> : null}
      {!token.current ? (
        <button
          aria-label={armed ? "confirm revoke" : "revoke token"}
          className={`icon-action${armed ? " icon-action--danger" : ""}`}
          disabled={!online}
          onClick={() => {
            if (armed) {
              void onRevoke(token.id);
            } else {
              setArmed(true);
            }
          }}
          title={online ? (armed ? "Confirm revoke" : "Revoke token") : "Revoking requires a connection"}
          type="button"
        >
          <Trash2 aria-hidden="true" size={16} strokeWidth={armed ? 2.25 : 1.75} />
        </button>
      ) : <span className="icon-action-spacer" />}
    </div>
  );
}

function SettingsPage() {
  const auth = useAuth();
  const offline = useOffline();

  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  const [showTokenList, setShowTokenList] = useState(false);
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [tokenName, setTokenName] = useState(IOS_SHORTCUT_TOKEN_NAME);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadTokens = async () => {
    if (!offline.online) {
      return;
    }

    try {
      const response = await auth.client.listTokens();
      setTokens(response.items);
    } catch (caught) {
      setTokenError(formatError(caught, "load failed"));
    }
  };

  useEffect(() => {
    void loadTokens();
  }, [offline.online]);

  const onChangePassword = async (event: FormEvent) => {
    event.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

    if (!offline.online) {
      setPasswordError("updating password requires a connection");
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError("passwords do not match");
      return;
    }

    try {
      await auth.client.changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      });
      setPasswordSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (caught) {
      setPasswordError(formatError(caught, "update failed"));
    }
  };

  const onCreateToken = async (event: FormEvent) => {
    event.preventDefault();
    setTokenError(null);
    setCopied(false);

    if (!offline.online) {
      setTokenError("creating tokens requires a connection");
      return;
    }

    try {
      const response = await auth.client.createToken({ name: tokenName });
      setCreatedToken(response.token);
      setTokenName(IOS_SHORTCUT_TOKEN_NAME);
      await loadTokens();
    } catch (caught) {
      setTokenError(formatError(caught, "create failed"));
    }
  };

  const onCreateShortcutToken = async () => {
    setTokenError(null);
    setCopied(false);

    if (!offline.online) {
      setTokenError("creating tokens requires a connection");
      return;
    }

    try {
      const response = await auth.client.createToken({
        name: IOS_SHORTCUT_TOKEN_NAME,
      });
      setCreatedToken(response.token);
      await loadTokens();
    } catch (caught) {
      setTokenError(formatError(caught, "create failed"));
    }
  };

  const onCopyToken = async () => {
    if (!createdToken) {
      return;
    }

    try {
      await navigator.clipboard.writeText(createdToken);
      setCopied(true);
    } catch {
      setTokenError("copy failed");
    }
  };

  const onRevoke = async (id: string) => {
    if (!offline.online) {
      setTokenError("revoking tokens requires a connection");
      return;
    }

    try {
      await auth.client.revokeToken(id);
      await loadTokens();
    } catch (caught) {
      setTokenError(formatError(caught, "revoke failed"));
    }
  };

  return (
    <div className="page">
      <header className="page-header row-between">
        <BrandLogo />
        <Nav />
      </header>

      {!offline.online ? (
        <p className="muted block-muted">online settings require a connection</p>
      ) : null}

      <OfflineAudioSettings />

      <section className="profile-section">
        <h2 className="section-title">account</h2>
        <p>{auth.user?.email ?? "signed in"}</p>
        <button
          className="text-action"
          onClick={() => {
            setShowPasswordForm((value) => !value);
            setPasswordError(null);
            setPasswordSuccess(false);
          }}
          type="button"
        >
          {showPasswordForm ? "cancel" : "change password"}
        </button>
        {showPasswordForm ? (
          <form className="stack" onSubmit={onChangePassword}>
            <label className="field">
              <span>current password</span>
              <input
                autoComplete="current-password"
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
            <label className="field">
              <span>new password</span>
              <input
                autoComplete="new-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </label>
            <label className="field">
              <span>confirm new password</span>
              <input
                autoComplete="new-password"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </label>
            <button className="button" disabled={!offline.online} type="submit">
              update password
            </button>
            {passwordSuccess ? <p>password updated</p> : null}
            {passwordError ? <p className="error">{passwordError}</p> : null}
          </form>
        ) : null}
      </section>

      <section className="profile-section">
        <h2 className="section-title">save from your phone</h2>

        <div className="shortcut-setup stack">
          <p className="muted block-muted">
            install url-keep to your home screen for one-tap saving from the
            share sheet. on iphone, tap the share button in safari then
            &ldquo;add to home screen.&rdquo;
          </p>
        </div>
      </section>

      <section className="profile-section">
        <h2 className="section-title">tokens</h2>

        <div className="shortcut-setup stack">
          <p className="muted block-muted">
            alternatively, use an ios shortcut for silent background saves.
            create a token, copy it, then install the shortcut.
          </p>
          <div className="inline-actions">
            <button className="button" disabled={!offline.online} onClick={() => void onCreateShortcutToken()} type="button">
              create iphone token
            </button>
            {IOS_SHORTCUT_URL ? (
              <a
                className="button secondary-button"
                href={IOS_SHORTCUT_URL}
                rel="noreferrer noopener"
                target="_blank"
              >
                install shortcut
              </a>
            ) : null}
          </div>
          <p className="muted block-muted">
            {IOS_SHORTCUT_URL
              ? "after install, run the shortcut once and paste the token when asked"
              : "add VITE_IOS_SHORTCUT_URL to show an install shortcut link here"}
          </p>
        </div>

        <form className="stack" onSubmit={onCreateToken}>
          <label className="field">
            <span>name</span>
            <input value={tokenName} onChange={(event) => setTokenName(event.target.value)} />
          </label>
          <button className="button" disabled={!offline.online} type="submit">
            create token
          </button>
        </form>

        {createdToken ? (
          <section className="token-output">
            <p>copy this token now. it is shown once.</p>
            <code>{createdToken}</code>
            <div className="inline-actions">
              <button className="button" onClick={() => void onCopyToken()} type="button">
                {copied ? "copied" : "copy token"}
              </button>
              {IOS_SHORTCUT_URL ? (
                <a
                  className="button secondary-button"
                  href={IOS_SHORTCUT_URL}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  install shortcut
                </a>
              ) : null}
            </div>
          </section>
        ) : null}

        {tokenError ? <p className="error">{tokenError}</p> : null}

        <button
          className="text-action"
          onClick={() => setShowTokenList((value) => !value)}
          type="button"
        >
          {showTokenList ? "hide tokens" : `show all tokens (${tokens.length})`}
        </button>

        {showTokenList ? (
          <section className="token-list">
            {tokens.map((token) => (
              <TokenRow key={token.id} online={offline.online} token={token} onRevoke={onRevoke} />
            ))}
          </section>
        ) : null}
      </section>
    </div>
  );
}

function ReaderPage() {
  const auth = useAuth();
  const offline = useOffline();
  const { id } = useParams();
  const location = useLocation();
  const state = (location.state as ReaderLocationState | null) ?? null;
  const [bookmark, setBookmark] = useState<Bookmark | null>(state?.bookmark ?? null);
  const [article, setArticle] = useState<OfflineArticle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ id: number; message: string } | null>(null);
  const [shareBusy, setShareBusy] = useState(false);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setNotice((current) => (current?.id === notice.id ? null : current));
    }, 2800);

    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  const showNotice = (message: string) => {
    setNotice({
      id: Date.now(),
      message,
    });
  };

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (!id) {
        setError("bookmark not found");
        setLoading(false);
        return;
      }

      if (bookmark?.id !== id) {
        setBookmark(state?.bookmark?.id === id ? state.bookmark : null);
        setArticle(null);
        setLoading(true);
      }
      setError(null);

      const [cachedBookmark, cachedArticle] = await Promise.all([
        offline.manager.getBookmark(id),
        offline.manager.getArticle(id),
      ]);

      if (!active) {
        return;
      }

      if (cachedBookmark) {
        setBookmark(cachedBookmark);
      }
      const cachedArticleIsUsable = Boolean(
        cachedArticle
        && (cachedArticle.extraction_status !== "complete" || cachedArticle.content_html),
      );
      if (cachedArticleIsUsable) {
        setArticle(cachedArticle);
      }

      if (!offline.online) {
        if (
          !cachedBookmark
          || !cachedArticleIsUsable
          || cachedArticle?.extraction_status !== "complete"
        ) {
          setError("article not available offline");
          setArticle(null);
        }
        setLoading(false);
        return;
      }

      try {
        if (!cachedBookmark) {
          await offline.refresh(true);
          const syncedBookmark = await offline.manager.getBookmark(id);
          if (active && syncedBookmark) {
            setBookmark(syncedBookmark);
          }
        }
        let currentArticle = await offline.manager.getArticle(id);
        if (currentArticle?.extraction_status === "complete" && !currentArticle.content_html) {
          await offline.manager.hydrateArticle(currentArticle.id);
          currentArticle = await offline.manager.getArticle(id);
        }
        if (!active) return;
        setArticle(currentArticle);
        if (!currentArticle) {
          setError("article content is not available");
        }
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 0) {
          if (!cachedArticleIsUsable) {
            setError("article not available offline");
          }
        } else {
          setError(formatError(caught, "load failed"));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      active = false;
    };
  }, [id, offline.online, offline.syncVersion]);

  const shareArticle = async () => {
    if (!bookmark) {
      return;
    }

    setShareBusy(true);
    try {
      let url = toReadableBookmarkUrl(bookmark.url);
      if (
        offline.online
        && (article?.extraction_status ?? bookmark.extraction_status) === "complete"
      ) {
        const response = await auth.client.enableBookmarkShare(bookmark.id).catch(() => null);
        url = response?.item.share_url ?? url;
      }
      const result = await shareLink(
        { title: article?.title ?? bookmark.title, url },
        navigator.share?.bind(navigator),
        copyToClipboard,
      );
      if (result === "copied") showNotice("link copied");
    } catch {
      showNotice("could not share link");
    } finally {
      setShareBusy(false);
    }
  };

  return (
    <div aria-busy={loading} className="page reader-page">
      {notice ? (
        <div aria-live="polite" className="app-notice" role="status">
          {notice.message}
        </div>
      ) : null}
      {error ? <p className="error">{error}</p> : null}

      {bookmark && bookmark.id === id && article ? (
        <ReaderDocument
          audioControl={
            article?.id && article.extraction_status === "complete" && article.content_html ? (
              <ArticleAudio
                articleId={article.id}
                artist={article.author ?? bookmark.site_name}
                bookmarkId={bookmark.id}
                client={auth.client}
                initialNarration={article.narration}
                key={article.id}
                reveal={location.hash === "#audio"}
                title={article.title ?? bookmark.title}
              />
            ) : null
          }
          author={article?.author}
          contentHtml={article?.content_html}
          extractionError={article?.extraction_error}
          extractionStatus={article?.extraction_status ?? "pending"}
          header={(
            <>
              <Link aria-label="Back to reading list" className="reader-back-link" to="/">
                <ArrowLeft aria-hidden="true" size={20} strokeWidth={1.8} />
              </Link>
              {!offline.online ? <span className="offline-badge">offline</span> : null}
            </>
          )}
          imageUrl={bookmark.image_url}
          publishedDate={article?.published_date}
          shareAction={{
            busy: shareBusy,
            onClick: () => {
              void shareArticle();
            },
          }}
          siteName={bookmark.site_name}
          sourceAvailable={offline.online}
          sourceUrl={bookmark.url}
          title={article?.title ?? bookmark.title}
          wordCount={article?.word_count}
        />
      ) : null}
    </div>
  );
}

function PublicSharePage() {
  const auth = useAuth();
  const { token } = useParams();
  const [article, setArticle] = useState<(
    PublicShareArticle & { content_html: string }
  ) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ id: number; message: string } | null>(null);
  const [shareBusy, setShareBusy] = useState(false);

  useEffect(() => {
    if (!notice) return;
    const timeoutId = window.setTimeout(() => setNotice(null), 2800);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (!token) {
        setError("share not found");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const [response, contentHtml] = await Promise.all([
          auth.client.getPublicShareArticle(token),
          auth.client.getPublicShareBody(token),
        ]);
        if (!active) {
          return;
        }
        setArticle({ ...response.item, content_html: contentHtml });
      } catch (caught) {
        if (!active) {
          return;
        }
        if (caught instanceof ApiError && caught.status === 404) {
          setError("share not found");
        } else {
          setError(formatError(caught, "load failed"));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      active = false;
    };
  }, [auth.client, token]);

  const shareArticle = async () => {
    if (!article || !token) return;
    setShareBusy(true);
    try {
      const result = await shareLink(
        {
          title: article.title,
          url: new URL(`/s/${encodeURIComponent(token)}`, window.location.origin).toString(),
        },
        navigator.share?.bind(navigator),
        copyToClipboard,
      );
      if (result === "copied") {
        setNotice({ id: Date.now(), message: "link copied" });
      }
    } catch {
      setNotice({ id: Date.now(), message: "could not share link" });
    } finally {
      setShareBusy(false);
    }
  };

  return (
    <div aria-busy={loading} className="page reader-page">
      {notice ? (
        <div aria-live="polite" className="app-notice" role="status">
          {notice.message}
        </div>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {article ? (
        <ReaderDocument
          author={article.author}
          contentHtml={article.content_html}
          extractionStatus="complete"
          header={(
            <span className="reader-page-label">url-keep</span>
          )}
          imageUrl={article.image_url}
          publishedDate={article.published_date}
          shareAction={{
            busy: shareBusy,
            onClick: () => {
              void shareArticle();
            },
          }}
          siteName={article.site_name}
          sourceUrl={article.url}
          title={article.title}
          wordCount={article.word_count}
        />
      ) : null}
    </div>
  );
}

function AppRoutes() {
  const location = useLocation();

  useLayoutEffect(() => {
    if (!/^\/(?:read|s)\//.test(location.pathname)) {
      delete document.documentElement.dataset.readerTheme;
    }
  }, [location.pathname]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <MainPage />
          </RequireAuth>
        }
      />
      <Route
        path="/add"
        element={
          <RequireAuth>
            <AddPage />
          </RequireAuth>
        }
      />
      <Route
        path="/save"
        element={
          <RequireAuth>
            <MobileSavePage />
          </RequireAuth>
        }
      />
      <Route
        path="/read/:id"
        element={
          <RequireAuth>
            <ReaderPage />
          </RequireAuth>
        }
      />
      <Route path="/s/:token" element={<PublicSharePage />} />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <SettingsPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <OfflineProvider>
        <AppRoutes />
      </OfflineProvider>
    </AuthProvider>
  );
}
