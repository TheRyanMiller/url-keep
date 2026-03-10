import { UrlKeepClient, ApiError } from "@url-keep/api-client";
import { PencilLine, Trash2 } from "lucide-react";
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

function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(
    window.localStorage.getItem(TOKEN_KEY),
  );
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const client = useMemo(
    () =>
      new UrlKeepClient({
        baseUrl: API_ORIGIN,
        getToken: () => window.localStorage.getItem(TOKEN_KEY),
      }),
    [],
  );

  const setToken = (value: string | null) => {
    setTokenState(value);
    if (value) {
      window.localStorage.setItem(TOKEN_KEY, value);
    } else {
      window.localStorage.removeItem(TOKEN_KEY);
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
    } catch {
      setToken(null);
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
        <h1>url-keep</h1>
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
  const [title, setTitle] = useState(bookmark.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
                <div className="inline-actions">
                  <button className="text-action" disabled={busy} onClick={() => void saveEdit()} type="button">
                    save
                  </button>
                  <button
                    className="text-action"
                    onClick={() => {
                      setEditing(false);
                      setTitle(bookmark.title);
                    }}
                    type="button"
                  >
                    cancel
                  </button>
                </div>
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
        {!editing ? (
          <div className="icon-actions">
            <button
              aria-label="edit title"
              className="icon-action"
              onClick={() => setEditing(true)}
              title="Edit title"
              type="button"
            >
              <PencilLine aria-hidden="true" size={16} strokeWidth={1.75} />
            </button>
            <button
              aria-label="delete bookmark"
              className="icon-action"
              onClick={() => void onDelete(bookmark)}
              title="Delete bookmark"
              type="button"
            >
              <Trash2 aria-hidden="true" size={16} strokeWidth={1.75} />
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function MainPage() {
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [urlInput, setUrlInput] = useState("");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
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
      setError(caught instanceof ApiError ? caught.message : "load failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBookmarks();
  }, [query]);

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setSaveError(null);
    try {
      await auth.client.saveBookmark({
        url: urlInput,
        saved_via: "web",
      } as CreateBookmarkRequest);
      setUrlInput("");
      await loadBookmarks();
    } catch (caught) {
      setSaveError(caught instanceof ApiError ? caught.message : "save failed");
    }
  };

  const onDelete = async (bookmark: Bookmark) => {
    if (!window.confirm("delete bookmark?")) {
      return;
    }

    await auth.client.deleteBookmarkByUrl(bookmark.url);
    setBookmarks((current) => current.filter((item) => item.id !== bookmark.id));
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
        <h1>url-keep</h1>
        <nav className="inline-actions">
          <Link className="text-action" to="/settings/tokens">
            tokens
          </Link>
          <button className="text-action" onClick={() => void auth.logout()} type="button">
            log out
          </button>
        </nav>
      </header>

      <section className="toolbar">
        <form className="row-form" onSubmit={onSave}>
          <input
            aria-label="url"
            placeholder="paste a url"
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
          />
          <button className="button" type="submit">
            save
          </button>
        </form>
        <input
          aria-label="search"
          placeholder="search"
          value={query}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        {saveError ? <p className="error">{saveError}</p> : null}
      </section>

      {error ? <p className="error">{error}</p> : null}
      {loading ? <p>loading</p> : null}

      <section className="bookmark-list">
        {bookmarks.map((bookmark) => (
          <BookmarkRow
            key={bookmark.id}
            bookmark={bookmark}
            onDelete={onDelete}
            onTitleUpdated={onTitleUpdated}
          />
        ))}
      </section>
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
        <h1>save</h1>
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

function TokensPage() {
  const auth = useAuth();
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [name, setName] = useState(IOS_SHORTCUT_TOKEN_NAME);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadTokens = async () => {
    try {
      const response = await auth.client.listTokens();
      setTokens(response.items);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "load failed");
    }
  };

  useEffect(() => {
    void loadTokens();
  }, []);

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setCopied(false);
    try {
      const response = await auth.client.createToken({ name });
      setCreatedToken(response.token);
      setName(IOS_SHORTCUT_TOKEN_NAME);
      await loadTokens();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "create failed");
    }
  };

  const onCreateShortcutToken = async () => {
    setError(null);
    setCopied(false);
    try {
      const response = await auth.client.createToken({
        name: IOS_SHORTCUT_TOKEN_NAME,
      });
      setCreatedToken(response.token);
      await loadTokens();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "create failed");
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
      setError("copy failed");
    }
  };

  const onRevoke = async (id: string) => {
    try {
      await auth.client.revokeToken(id);
      await loadTokens();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "revoke failed");
    }
  };

  return (
    <div className="page narrow">
      <header className="page-header row-between">
        <div>
          <Link className="text-action" to="/">
            ← back
          </Link>
          <h1>tokens</h1>
        </div>
      </header>

      <section className="shortcut-setup stack">
        <div>
          <h2 className="section-title">iphone shortcut</h2>
          <p className="muted block-muted">
            create a token, copy it, then install the shortcut. on first run,
            the shortcut will ask for that token once and then save shared urls
            directly to url-keep.
          </p>
        </div>
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
      </section>

      <form className="stack" onSubmit={onCreate}>
        <label className="field">
          <span>name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
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

      {error ? <p className="error">{error}</p> : null}

      <section className="stack">
        {tokens.map((token) => (
          <div className="token-row" key={token.id}>
            <div>
              <p>{token.name}</p>
              <p className="muted">
                {formatDate(token.created_at)}
                {token.current ? " / current" : ""}
              </p>
            </div>
            {!token.current ? (
              <button
                className="text-action"
                onClick={() => void onRevoke(token.id)}
                type="button"
              >
                revoke
              </button>
            ) : null}
          </div>
        ))}
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
        path="/save"
        element={
          <RequireAuth>
            <MobileSavePage />
          </RequireAuth>
        }
      />
      <Route
        path="/settings/tokens"
        element={
          <RequireAuth>
            <TokensPage />
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
      <AppRoutes />
    </AuthProvider>
  );
}
