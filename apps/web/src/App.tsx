import { UrlKeepClient, ApiError } from "@url-keep/api-client";
import { Check, PencilLine, Trash2, X } from "lucide-react";
import type {
  Bookmark,
  CreateBookmarkRequest,
  LoginResponse,
  TokenItem,
  User,
} from "@url-keep/shared";
import {
  Navigate,
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

const TOKEN_KEY = "url_keep_token";
const IOS_SHORTCUT_TOKEN_NAME = "iphone shortcut";

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
    // Keep the in-memory auth state even if storage is unavailable.
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
    const url = new URL(trimmed);
    return url.toString();
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

const AuthContext = createContext<AuthState | null>(null);

function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("AuthContext not found");
  }
  return value;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

function getDomain(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function BrandLogo() {
  return (
    <Link aria-label="url-keep home" className="brand-mark" to="/">
      <img alt="url-keep" className="brand-logo" src={BRAND_LOGO_URL} />
    </Link>
  );
}

function Nav() {
  const auth = useAuth();
  return (
    <nav className="nav">
      <Link className="text-action" to="/add">add url</Link>
      <span className="nav-sep" aria-hidden="true">|</span>
      <Link className="text-action" to="/profile">profile</Link>
      <span className="nav-sep" aria-hidden="true">|</span>
      <button className="text-action" onClick={() => void auth.logout()} type="button">
        log out
      </button>
    </nav>
  );
}

function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => readStoredToken());
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const client = useMemo(
    () =>
      new UrlKeepClient({
        baseUrl: API_ORIGIN,
        getToken: () => token,
      }),
    [token],
  );

  const setToken = (value: string | null) => {
    setTokenState(value);
    writeStoredToken(value);
    if (!value) {
      setUser(null);
    }
  };

  const refreshMe = async () => {
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }

    try {
      const response = await client.me();
      setUser(response.user);
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
      // Ignore logout failures; local auth still needs clearing.
    } finally {
      setToken(null);
    }
  };

  useEffect(() => {
    void refreshMe();
  }, [token]);

  const value = useMemo<AuthState>(
    () => ({ token, user, loading, client, setToken, refreshMe, logout }),
    [token, user, loading, client],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();

  if (auth.loading) {
    return <div className="page"><p>loading</p></div>;
  }

  if (!auth.token) {
    const redirect = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?redirect=${encodeURIComponent(redirect)}`} replace />;
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
      navigate(redirect, { replace: true });
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "login failed",
      );
    }
  };

  return (
    <div className="page narrow">
      <header className="page-header">
        <BrandLogo />
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

function BookmarkRow({
  bookmark,
  onDelete,
  onTitleUpdated,
}: {
  bookmark: Bookmark;
  onDelete: (bookmark: Bookmark) => Promise<void>;
  onTitleUpdated: (bookmark: Bookmark, title: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [title, setTitle] = useState(bookmark.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(bookmark.title);
  }, [bookmark.title]);

  useEffect(() => {
    if (!deleteArmed) return;
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
      setError(caught instanceof Error ? caught.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="bookmark-row">
      <div className="bookmark-meta">
        <span>{formatDate(bookmark.created_at)}</span>
        <span>{bookmark.saved_via}</span>
      </div>
      <div className="bookmark-main">
        <div className={`bookmark-content${bookmark.image_url ? " has-image" : ""}`}>
          <BookmarkImage alt={bookmark.title} src={bookmark.image_url} />
          <div className="bookmark-copy">
            {editing ? (
              <div className="inline-edit">
                <input
                  aria-label="title"
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
                <a
                  className="bookmark-title"
                  href={bookmark.url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {bookmark.title}
                </a>
                <p className="bookmark-domain">{getDomain(bookmark.url)}</p>
              </>
            )}
          </div>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>
      <div className="bookmark-side">
        <div className="icon-actions">
          {editing ? (
            <button
              aria-label="save title"
              className="icon-action icon-action--confirm"
              disabled={busy}
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
              onClick={() => {
                setDeleteArmed(false);
                setEditing(true);
              }}
              title="Edit title"
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
              onClick={() => {
                if (deleteArmed) {
                  void onDelete(bookmark);
                } else {
                  setDeleteArmed(true);
                }
              }}
              title={deleteArmed ? "Confirm delete" : "Delete bookmark"}
              type="button"
            >
              <Trash2 aria-hidden="true" size={16} strokeWidth={deleteArmed ? 2.25 : 1.75} />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function MainPage() {
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const query = searchParams.get("q") ?? "";

  const loadBookmarks = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await auth.client.listBookmarks({
        q: query || undefined,
      });
      setBookmarks(response.items);
    } catch (caught) {
      const detail = caught instanceof ApiError
        ? `ApiError(${caught.status}, ${caught.code}): ${caught.message}`
        : caught instanceof Error
          ? `${caught.constructor.name}: ${caught.message}`
          : String(caught);
      setError(detail);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBookmarks();
  }, [query]);

  const onDeleteConfirm = async (bookmark: Bookmark) => {
    try {
      await auth.client.deleteBookmarkByUrl(bookmark.url);
      setBookmarks((current) => current.filter((item) => item.id !== bookmark.id));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "delete failed");
    }
  };

  const onTitleUpdated = async (bookmark: Bookmark, title: string) => {
    const response = await auth.client.updateBookmarkTitle(bookmark.id, { title });
    setBookmarks((current) =>
      current.map((item) => (item.id === bookmark.id ? response.item : item)),
    );
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

  return (
    <div className="page">
      <header className="page-header row-between">
        <BrandLogo />
        <Nav />
      </header>

      <section className="toolbar">
        <input
          aria-label="search"
          placeholder="search"
          value={query}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </section>

      {error ? <p className="error">{error}</p> : null}
      {loading ? <p>loading</p> : null}

      <section className="bookmark-list">
        {bookmarks.map((bookmark) => (
          <BookmarkRow
            key={bookmark.id}
            bookmark={bookmark}
            onDelete={onDeleteConfirm}
            onTitleUpdated={onTitleUpdated}
          />
        ))}
      </section>
    </div>
  );
}

function AddPage() {
  const auth = useAuth();
  const [urlInput, setUrlInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await auth.client.saveBookmark({
        url: urlInput,
        saved_via: "web",
      } as CreateBookmarkRequest);
      setSaved(true);
      setUrlInput("");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "save failed");
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
        <button className="button" type="submit">
          save
        </button>
        {saved ? <p>saved</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </form>
    </div>
  );
}

function MobileSavePage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [urlInput, setUrlInput] = useState(searchParams.get("url") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.loading && !auth.token) {
      const redirect = `${location.pathname}${location.search}`;
      navigate(`/login?redirect=${encodeURIComponent(redirect)}`, { replace: true });
    }
  }, [auth.loading, auth.token, location.pathname, location.search, navigate]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await auth.client.saveBookmark({
        url: urlInput,
        saved_via: "mobile_web",
      });
      setMessage("saved");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "save failed");
    }
  };

  return (
    <div className="page narrow">
      <header className="page-header">
        <div className="page-heading-group">
          <BrandLogo />
          <p className="page-kicker">save</p>
        </div>
      </header>
      <form className="stack" onSubmit={onSubmit}>
        <label className="field">
          <span>url</span>
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
          />
        </label>
        <button className="button" type="submit">
          save
        </button>
        {message ? <p>{message}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </form>
    </div>
  );
}

function TokenRow({
  token,
  onRevoke,
}: {
  token: TokenItem;
  onRevoke: (id: string) => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
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
          onClick={() => {
            if (armed) {
              void onRevoke(token.id);
            } else {
              setArmed(true);
            }
          }}
          title={armed ? "Confirm revoke" : "Revoke token"}
          type="button"
        >
          <Trash2 aria-hidden="true" size={16} strokeWidth={armed ? 2.25 : 1.75} />
        </button>
      ) : <span className="icon-action-spacer" />}
    </div>
  );
}

function ProfilePage() {
  const auth = useAuth();

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
    try {
      const response = await auth.client.listTokens();
      setTokens(response.items);
    } catch (caught) {
      setTokenError(caught instanceof ApiError ? caught.message : "load failed");
    }
  };

  useEffect(() => {
    void loadTokens();
  }, []);

  const onChangePassword = async (event: FormEvent) => {
    event.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

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
      setPasswordError(caught instanceof ApiError ? caught.message : "update failed");
    }
  };

  const onCreateToken = async (event: FormEvent) => {
    event.preventDefault();
    setTokenError(null);
    setCopied(false);
    try {
      const response = await auth.client.createToken({ name: tokenName });
      setCreatedToken(response.token);
      setTokenName(IOS_SHORTCUT_TOKEN_NAME);
      await loadTokens();
    } catch (caught) {
      setTokenError(caught instanceof ApiError ? caught.message : "create failed");
    }
  };

  const onCreateShortcutToken = async () => {
    setTokenError(null);
    setCopied(false);
    try {
      const response = await auth.client.createToken({
        name: IOS_SHORTCUT_TOKEN_NAME,
      });
      setCreatedToken(response.token);
      await loadTokens();
    } catch (caught) {
      setTokenError(caught instanceof ApiError ? caught.message : "create failed");
    }
  };

  const onCopyToken = async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopied(true);
    } catch {
      setTokenError("copy failed");
    }
  };

  const onRevoke = async (id: string) => {
    try {
      await auth.client.revokeToken(id);
      await loadTokens();
    } catch (caught) {
      setTokenError(caught instanceof ApiError ? caught.message : "revoke failed");
    }
  };

  return (
    <div className="page narrow">
      <header className="page-header row-between">
        <BrandLogo />
        <Nav />
      </header>

      <section className="profile-section">
        <h2 className="section-title">account</h2>
        <p>{auth.user?.email}</p>
        <button
          className="text-action"
          onClick={() => {
            setShowPasswordForm((v) => !v);
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
            <button className="button" type="submit">
              update password
            </button>
            {passwordSuccess ? <p>password updated</p> : null}
            {passwordError ? <p className="error">{passwordError}</p> : null}
          </form>
        ) : null}
      </section>

      <section className="profile-section">
        <h2 className="section-title">tokens</h2>

        <div className="shortcut-setup stack">
          <p className="muted block-muted">
            create a token, copy it, then install the shortcut. on first run,
            the shortcut will ask for that token once and then save shared urls
            directly to url-keep.
          </p>
          <div className="inline-actions">
            <button className="button" onClick={() => void onCreateShortcutToken()} type="button">
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
          <button className="button" type="submit">
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
          onClick={() => setShowTokenList((v) => !v)}
          type="button"
        >
          {showTokenList ? "hide tokens" : `show all tokens (${tokens.length})`}
        </button>

        {showTokenList ? (
          <section className="token-list">
            {tokens.map((token) => (
              <TokenRow key={token.id} token={token} onRevoke={onRevoke} />
            ))}
          </section>
        ) : null}
      </section>
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
        path="/profile"
        element={
          <RequireAuth>
            <ProfilePage />
          </RequireAuth>
        }
      />
      <Route path="/settings/tokens" element={<Navigate replace to="/profile" />} />
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
