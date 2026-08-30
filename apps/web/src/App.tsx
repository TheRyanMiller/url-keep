import { ApiError, UrlKeepClient } from "@url-keep/api-client";
import {
  classifyBookmarkUrl,
  toReadableBookmarkUrl,
  type ArticleContent,
  type Bookmark,
  type CreateBookmarkRequest,
  type LoginResponse,
  type PublicShareArticle,
  type TokenItem,
  type User,
} from "@url-keep/shared";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  PencilLine,
  RefreshCw,
  Share2,
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
  getOfflineDb,
  getOfflineReadableBookmarkIds,
} from "./offline/db";
import { SyncManager } from "./offline/sync";
import { ArticleAudio } from "./audio/ArticleAudio";
import { auditOfflineAudio } from "./audio/offline-audio";
import { NotificationSettings } from "./settings/NotificationSettings";
import { OfflineAudioSettings } from "./settings/OfflineAudioSettings";

const TOKEN_KEY = "url_keep_token";
const USER_KEY = "url_keep_user";
const IOS_SHORTCUT_TOKEN_NAME = "iphone shortcut";
const READER_TEXT_SIZE_KEY = "url_keep_reader_text_size";
type ReaderTextSize = "s" | "m" | "l";
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
  loading: boolean;
  client: UrlKeepClient;
  setToken: (token: string | null) => void;
  refreshMe: () => Promise<void>;
  logout: () => Promise<void>;
};

type OfflineState = {
  online: boolean;
  syncing: boolean;
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
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
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
  const [standalone, setStandalone] = useState(false);

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
      <img alt="url-keep" className="brand-logo" src={BRAND_LOGO_URL} />
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
  const [loading, setLoading] = useState(true);

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

  const setToken = (value: string | null) => {
    if (value) {
      setTokenState(value);
      writeStoredToken(value);
    } else {
      clearLocalAuth();
    }
  };

  const refreshMe = async () => {
    if (!token) {
      setUser(null);
      writeStoredUser(null);
      setLoading(false);
      return;
    }

    try {
      const response = await client.me();
      setUser(response.user);
      writeStoredUser(response.user);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setToken(null);
      }
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    try {
      await client.logout();
    } catch {
      // Local auth still needs clearing even if the network request fails.
    } finally {
      setToken(null);
    }
  };

  useEffect(() => {
    setLoading(true);
    void refreshMe();
  }, [token]);

  const value = useMemo<AuthState>(
    () => ({ token, user, loading, client, setToken, refreshMe, logout }),
    [token, user, loading, client],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function OfflineProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const online = useOnlineStatus();
  const [syncing, setSyncing] = useState(false);
  const [syncVersion, setSyncVersion] = useState(0);

  const manager = useMemo(
    () => new SyncManager(auth.client, API_ORIGIN),
    [auth.client],
  );

  const managerRef = useRef(manager);
  managerRef.current = manager;

  useEffect(() => {
    void auditOfflineAudio();
  }, []);

  const refresh = useCallback(async (force = false) => {
    if (!auth.token || !online) {
      return;
    }

    if (!force) {
      if (!(await managerRef.current.isStale())) {
        return;
      }

      try {
        if (!(await managerRef.current.hasChanges())) {
          return;
        }
      } catch {
        // If change detection fails (network error), fall through to full sync
      }
    }

    setSyncing(true);
    try {
      await managerRef.current.syncOnce();
      setSyncVersion((current) => current + 1);
    } catch {
      // Foreground state remains usable; the next foreground trigger retries.
    } finally {
      setSyncing(false);
    }
  }, [auth.token, online]);

  // Mount sync
  useEffect(() => {
    if (!auth.token || !online) {
      return;
    }

    void refresh(true);
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
      syncing,
      syncVersion,
      manager,
      refresh,
    }),
    [online, syncing, syncVersion, manager, refresh],
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();

  if (auth.loading) {
    return <div className="page"><p>loading</p></div>;
  }

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
      auth.setToken(response.token);
      writeStoredUser(response.user);
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
  if (!src || hidden) {
    return null;
  }

  return (
    <img
      alt={alt}
      className="bookmark-image"
      loading="lazy"
      referrerPolicy="no-referrer"
      src={src}
      onError={() => setHidden(true)}
    />
  );
}

function ReaderDocument({
  header,
  title,
  sourceUrl,
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
  const [textSizeMenuOpen, setTextSizeMenuOpen] = useState(false);
  const textSizeControlRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    writeStoredReaderTextSize(textSize);
  }, [textSize]);

  useEffect(() => {
    if (!textSizeMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (textSizeControlRef.current?.contains(target)) {
        return;
      }

      setTextSizeMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTextSizeMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [textSizeMenuOpen]);

  const html = contentHtml ? sanitizeArticleHtml(contentHtml, API_ORIGIN) : null;
  const resolvedPublishedDate = formatOptionalDate(publishedDate);
  const readMinutes = wordCount ? estimateReadMinutes(wordCount) : null;
  const sourceHref = toReadableBookmarkUrl(sourceUrl);
  const normalizedAuthor = normalizeMetadataLabel(author);
  const normalizedSiteName = normalizeMetadataLabel(siteName);
  const primarySourceLabel = siteName?.trim() || author?.trim() || null;
  const secondaryAuthorLabel =
    siteName?.trim() && author?.trim() && normalizedAuthor !== normalizedSiteName
      ? author.trim()
      : null;

  return (
    <>
      <header className="page-header reader-page-header">{header}</header>
      <article className="reader-shell">
        <header className="reader-header">
          <h1>{title}</h1>
          <div className="reader-meta">
            {shareAction ? (
              <button
                aria-label={shareAction.busy ? "copying public reader link" : "copy public reader link"}
                className="icon-action reader-inline-share"
                disabled={shareAction.busy}
                onClick={shareAction.onClick}
                title={shareAction.busy ? "Copying public reader link" : "Copy public reader link"}
                type="button"
              >
                <Share2 aria-hidden="true" size={14} strokeWidth={1.75} />
              </button>
            ) : null}
            {primarySourceLabel ? <span>{primarySourceLabel}</span> : null}
            {secondaryAuthorLabel ? <span>{secondaryAuthorLabel}</span> : null}
            {readMinutes && wordCount ? (
              <span
                aria-label={`${readMinutes} min read, ${wordCount.toLocaleString()} words`}
                className="reader-meta-tooltip"
                title={`${wordCount.toLocaleString()} words`}
              >
                {readMinutes} min read
              </span>
            ) : null}
            {resolvedPublishedDate ? <span>{resolvedPublishedDate}</span> : null}
            <div className="reader-text-size-control" ref={textSizeControlRef}>
              <button
                aria-expanded={textSizeMenuOpen}
                aria-haspopup="true"
                aria-label="Text size"
                className="reader-text-size-trigger"
                onClick={() => setTextSizeMenuOpen((open) => !open)}
                type="button"
              >
                Aa
              </button>
              {textSizeMenuOpen ? (
                <div className="reader-text-size-menu" role="menu" aria-label="Text size options">
                  {READER_TEXT_SIZE_OPTIONS.map((option) => (
                    <button
                      aria-pressed={textSize === option.value}
                      className={`reader-text-size-option${textSize === option.value ? " is-active" : ""}`}
                      key={option.value}
                      onClick={() => {
                        setTextSize(option.value);
                        setTextSizeMenuOpen(false);
                      }}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {audioControl}
            {sourceAvailable ? (
              <a
                className="reader-meta-link"
                href={sourceHref}
                rel="noopener noreferrer"
                target="_blank"
              >
                Read on web
                <ArrowUpRight aria-hidden="true" size={11} strokeWidth={1.8} />
              </a>
            ) : (
              <span
                aria-disabled="true"
                className="reader-meta-link is-disabled"
                title="Unavailable offline"
              >
                Read on web
                <ArrowUpRight aria-hidden="true" size={11} strokeWidth={1.8} />
              </span>
            )}
          </div>
        </header>

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
  onDelete: (bookmark: Bookmark) => Promise<void>;
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
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [title, setTitle] = useState(bookmark.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const copyLinkLabel = canRead ? "copy public reader link" : "copy source link";
  const copyingLinkLabel = canRead ? "copying public reader link" : "copying source link";

  useEffect(() => {
    setTitle(bookmark.title);
  }, [bookmark.title]);

  useEffect(() => {
    if (!deleteArmed) {
      return;
    }

    const id = setTimeout(() => setDeleteArmed(false), 3000);
    return () => clearTimeout(id);
  }, [deleteArmed]);

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
    setDeleteArmed(false);
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
          <BookmarkImage alt={bookmark.title} src={bookmark.image_url} />
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
                  setDeleteArmed(false);
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
                aria-label={deleteArmed ? "confirm delete" : "delete bookmark"}
                className={`icon-action${deleteArmed ? " icon-action--danger" : ""}`}
                disabled={!online}
                onClick={() => {
                  if (deleteArmed) {
                    void onDelete(bookmark);
                  } else {
                    setDeleteArmed(true);
                  }
                }}
                title={online ? (deleteArmed ? "Confirm delete" : "Delete bookmark") : "Deleting requires a connection"}
                type="button"
              >
                <Trash2 aria-hidden="true" size={16} strokeWidth={deleteArmed ? 2.25 : 1.75} />
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
  const activeTab = parseMainTab(searchParams.get("tab"));
  const query = searchParams.get("q") ?? "";
  const hasQuery = query.trim().length > 0;

  const loadOfflineBookmarks = async () => {
    const [items, readableIds] = await Promise.all([
      offline.manager.getBookmarks(),
      getOfflineReadableBookmarkIds(),
    ]);
    setBookmarks(filterBookmarksByTab(items, query, activeTab));
    setOfflineReadableIds(readableIds);
  };

  const loadBookmarks = async () => {
    setLoading(true);
    setError(null);

    if (!offline.online) {
      await loadOfflineBookmarks();
      setLoading(false);
      return;
    }

    try {
      const response = await auth.client.listBookmarks({
        bucket: activeTab === "all" ? undefined : activeTab,
        q: query || undefined,
      });
      setBookmarks(filterBookmarksByTab(response.items, query, activeTab));
      setOfflineReadableIds(await getOfflineReadableBookmarkIds());
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 0) {
        await loadOfflineBookmarks();
      } else {
        setError(formatError(caught, "load failed"));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBookmarks();
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

  const onDeleteConfirm = async (bookmark: Bookmark) => {
    if (!offline.online) {
      setError("deleting requires a connection");
      return;
    }

    try {
      await auth.client.deleteBookmarkByUrl(bookmark.url);
      setBookmarks((current) => current.filter((item) => item.id !== bookmark.id));
      void offline.refresh(true);
    } catch (caught) {
      setError(formatError(caught, "delete failed"));
    }
  };

  const onTitleUpdated = async (bookmark: Bookmark, title: string) => {
    if (!offline.online) {
      throw new Error("editing requires a connection");
    }

    const response = await auth.client.updateBookmarkTitle(bookmark.id, { title });
    setBookmarks((current) =>
      current.map((item) => (item.id === bookmark.id ? response.item : item)),
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
          ? { ...item, extraction_status: response.extraction_status }
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
        {offline.syncing ? (
          <p className="muted block-muted">syncing offline cache</p>
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
      {loading ? <p>loading</p> : null}
      {!loading && !error && bookmarks.length === 0 ? (
        <p className="muted block-muted">{getEmptyStateMessage(activeTab, hasQuery)}</p>
      ) : null}

      <section className="bookmark-list">
        {bookmarks.map((bookmark) => (
          <BookmarkRow
            key={bookmark.id}
            availableOffline={offlineReadableIds.has(bookmark.id)}
            bookmark={bookmark}
            online={offline.online}
            onDelete={onDeleteConfirm}
            onRetryExtraction={onRetryExtraction}
            onShareNotice={showNotice}
            onTitleUpdated={onTitleUpdated}
          />
        ))}
      </section>
    </div>
  );
}

function AddPage() {
  const auth = useAuth();
  const offline = useOffline();
  const [urlInput, setUrlInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);

    if (!offline.online) {
      setError("saving requires a connection");
      return;
    }

    try {
      await auth.client.saveBookmark({
        url: urlInput,
        saved_via: "web",
      } as CreateBookmarkRequest);
      setSaved(true);
      setUrlInput("");
      void offline.refresh(true);
    } catch (caught) {
      setError(formatError(caught, "save failed"));
    }
  };

  return (
    <div className="page narrow">
      <header className="page-header row-between">
        <BrandLogo />
        <Nav />
      </header>
      <form className="stack" onSubmit={onSubmit}>
        <label className="field">
          <span>url</span>
          <input
            placeholder="https://..."
            value={urlInput}
            onChange={(event) => {
              setUrlInput(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <button className="button" disabled={!offline.online} type="submit">
          save
        </button>
        {!offline.online ? <p className="muted">saving requires a connection</p> : null}
        {saved ? <p>saved</p> : null}
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
        const response = await auth.client.saveBookmark({
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

  const domain = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();

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
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const sharedUrl = resolveSharedUrl(searchParams);
  const sharedTitle = resolveSharedTitle(searchParams);

  const [urlInput, setUrlInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.loading && !auth.token) {
      const redirect = `${location.pathname}${location.search}`;
      navigate(`/login?redirect=${encodeURIComponent(redirect)}`, { replace: true });
    }
  }, [auth.loading, auth.token, location.pathname, location.search, navigate]);

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
      await auth.client.saveBookmark({
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
    <div className="page narrow">
      <header className="page-header row-between">
        <BrandLogo />
        <Nav />
      </header>

      {!offline.online ? (
        <p className="muted block-muted">online settings require a connection</p>
      ) : null}

      <OfflineAudioSettings />
      <NotificationSettings client={auth.client} online={offline.online} />

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
  const [article, setArticle] = useState<ArticleContent | null>(null);
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

      setLoading(true);
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
      if (cachedArticle) {
        setArticle(cachedArticle);
      }

      if (!offline.online) {
        if (
          !cachedBookmark
          || cachedArticle?.extraction_status !== "complete"
          || !cachedArticle.content_html
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

        const response = await auth.client.getBookmarkContent(id);
        if (!active) {
          return;
        }

        setArticle(response.item);
        const db = await getOfflineDb();
        await db.put("articles", {
          ...response.item,
          synced_at: new Date().toISOString(),
        });
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 0) {
          if (!cachedArticle) {
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

  const copyArticleLink = async () => {
    if (!bookmark) {
      return;
    }

    setShareBusy(true);
    try {
      await copyPreferredArticleLink({
        client: auth.client,
        bookmarkId: bookmark.id,
        sourceUrl: bookmark.url,
        extractionStatus: article?.extraction_status ?? bookmark.extraction_status,
        preferReaderLink: true,
        online: offline.online,
        onNotice: showNotice,
      });
    } finally {
      setShareBusy(false);
    }
  };

  return (
    <div className="page reader-page">
      {notice ? (
        <div aria-live="polite" className="app-notice" role="status">
          {notice.message}
        </div>
      ) : null}
      {loading ? <p>loading</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {bookmark ? (
        <ReaderDocument
          audioControl={
            article?.id && article.extraction_status === "complete" && article.content_html ? (
              <ArticleAudio
                articleId={article.id}
                bookmarkId={bookmark.id}
                client={auth.client}
                key={article.id}
              />
            ) : null
          }
          author={article?.author}
          contentHtml={article?.content_html}
          extractionError={article?.extraction_error}
          extractionStatus={article?.extraction_status ?? "pending"}
          header={(
            <>
              <Link aria-label="back" className="text-action reader-back-link" to="/">&#x2190;</Link>
              {!offline.online ? <span className="offline-badge">offline</span> : null}
              <StandaloneControls
                onNotice={showNotice}
                share={{ title: bookmark.title, url: bookmark.url }}
              />
            </>
          )}
          publishedDate={article?.published_date}
          shareAction={{
            busy: shareBusy,
            onClick: () => {
              void copyArticleLink();
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
  const [article, setArticle] = useState<PublicShareArticle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ id: number; message: string } | null>(null);

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
        const response = await auth.client.getPublicShareArticle(token);
        if (!active) {
          return;
        }
        setArticle(response.item);
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

  return (
    <div className="page reader-page">
      {notice ? (
        <div aria-live="polite" className="app-notice" role="status">
          {notice.message}
        </div>
      ) : null}
      {loading ? <p>loading</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {article ? (
        <ReaderDocument
          author={article.author}
          contentHtml={article.content_html}
          extractionStatus="complete"
          header={(
            <>
              <span className="reader-page-label">url-keep</span>
              <StandaloneControls
                onNotice={(message) => setNotice({ id: Date.now(), message })}
                share={{
                  title: article.title,
                  url: new URL(`/s/${encodeURIComponent(token ?? "")}`, window.location.origin).toString(),
                }}
              />
            </>
          )}
          publishedDate={article.published_date}
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
