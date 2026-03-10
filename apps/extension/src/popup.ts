import { UrlKeepClient, ApiError } from "@url-keep/api-client";

declare const __API_ORIGIN__: string;
declare const __APP_ORIGIN__: string;

const TOKEN_KEY = "url_keep_token";
const API_ORIGIN_KEY = "url_keep_api_origin";
const APP_ORIGIN_KEY = "url_keep_app_origin";
const DEFAULT_API_ORIGIN = __API_ORIGIN__;
const DEFAULT_APP_ORIGIN = __APP_ORIGIN__;

const loginForm = document.getElementById("login-form") as HTMLFormElement;
const bookmarkView = document.getElementById("bookmark-view") as HTMLElement;
const settingsForm = document.getElementById("settings-form") as HTMLFormElement;
const settingsToggleButton = document.getElementById("settings-toggle") as HTMLButtonElement;
const emailInput = document.getElementById("email") as HTMLInputElement;
const passwordInput = document.getElementById("password") as HTMLInputElement;
const domainElement = document.getElementById("domain") as HTMLElement;
const stateLabel = document.getElementById("state-label") as HTMLElement;
const actionButton = document.getElementById("action-button") as HTMLButtonElement;
const openAppLink = document.getElementById("open-app-link") as HTMLAnchorElement;
const settingsApiOriginInput = document.getElementById(
  "settings-api-origin",
) as HTMLInputElement;
const settingsAppOriginInput = document.getElementById(
  "settings-app-origin",
) as HTMLInputElement;
const resetSettingsButton = document.getElementById(
  "reset-settings",
) as HTMLButtonElement;
const errorElement = document.getElementById("error") as HTMLElement;

type ExtractedMetadata = {
  title?: string;
  image_url?: string;
  site_name?: string;
};

type PopupState = {
  saved: boolean;
  url: string;
  title: string;
  metadata: ExtractedMetadata;
};

type RuntimeSettings = {
  apiOrigin: string;
  appOrigin: string;
};

let currentToken: string | null = null;
let popupState: PopupState | null = null;
let currentSettings: RuntimeSettings = {
  apiOrigin: DEFAULT_API_ORIGIN,
  appOrigin: DEFAULT_APP_ORIGIN,
};
let client = createClient(currentSettings.apiOrigin);

function createClient(baseUrl: string) {
  return new UrlKeepClient({
    baseUrl,
    getToken: () => currentToken,
  });
}

function normalizeOrigin(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("origin must use http or https");
  }

  return url.origin;
}

function setSettings(settings: RuntimeSettings) {
  currentSettings = settings;
  client = createClient(settings.apiOrigin);
  openAppLink.href = settings.appOrigin;
  settingsApiOriginInput.value = settings.apiOrigin;
  settingsAppOriginInput.value = settings.appOrigin;
}

function coerceStoredOrigin(value: string | undefined, fallback: string) {
  if (!value) {
    return fallback;
  }

  try {
    return normalizeOrigin(value);
  } catch {
    return fallback;
  }
}

async function loadSettings() {
  const result = await chrome.storage.local.get([API_ORIGIN_KEY, APP_ORIGIN_KEY]);
  setSettings({
    apiOrigin: coerceStoredOrigin(
      result[API_ORIGIN_KEY] as string | undefined,
      DEFAULT_API_ORIGIN,
    ),
    appOrigin: coerceStoredOrigin(
      result[APP_ORIGIN_KEY] as string | undefined,
      DEFAULT_APP_ORIGIN,
    ),
  });
}

async function getToken() {
  const result = await chrome.storage.local.get(TOKEN_KEY);
  return (result[TOKEN_KEY] as string | undefined) ?? null;
}

async function setToken(token: string | null) {
  currentToken = token;
  if (token) {
    await chrome.storage.local.set({ [TOKEN_KEY]: token });
  } else {
    await chrome.storage.local.remove(TOKEN_KEY);
  }
}

function showError(message: string | null) {
  errorElement.textContent = message ?? "";
}

function getRequestErrorMessage(caught: unknown, fallback: string) {
  if (caught instanceof ApiError) {
    if (caught.code === "network_error") {
      return "request blocked; check api origin and ALLOWED_EXTENSION_ORIGINS";
    }

    return caught.message;
  }

  return fallback;
}

function showLogin() {
  settingsForm.classList.add("hidden");
  loginForm.classList.remove("hidden");
  bookmarkView.classList.add("hidden");
  settingsToggleButton.textContent = "settings";
}

function showBookmarkView() {
  settingsForm.classList.add("hidden");
  loginForm.classList.add("hidden");
  bookmarkView.classList.remove("hidden");
  settingsToggleButton.textContent = "settings";
}

function showSettings() {
  showError(null);
  loginForm.classList.add("hidden");
  bookmarkView.classList.add("hidden");
  settingsForm.classList.remove("hidden");
  settingsToggleButton.textContent = "back";
}

function restoreMainView() {
  if (!currentToken) {
    showLogin();
    return;
  }

  showBookmarkView();
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function isSupportedUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function extractMetadata(tabId: number): Promise<ExtractedMetadata> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const title = document.title || undefined;
      const image =
        document
          .querySelector<HTMLMetaElement>('meta[property="og:image"]')
          ?.content?.trim() || undefined;
      const site =
        document
          .querySelector<HTMLMetaElement>('meta[property="og:site_name"]')
          ?.content?.trim() || undefined;

      const imageUrl = image ? new URL(image, location.href).toString() : undefined;
      return {
        title,
        image_url:
          imageUrl && imageUrl.startsWith("https://") ? imageUrl : undefined,
        site_name: site,
      };
    },
  });

  return result?.result ?? {};
}

function renderState(state: PopupState) {
  popupState = state;
  showBookmarkView();
  showError(null);
  domainElement.textContent = new URL(state.url).hostname;
  stateLabel.textContent = state.saved ? "saved" : "not saved";
  actionButton.textContent = state.saved ? "unsave" : "save";
}

async function loadBookmarkState() {
  const tab = await getCurrentTab();
  if (!tab?.id || !tab.url || !isSupportedUrl(tab.url)) {
    popupState = null;
    showBookmarkView();
    showError("unsupported page");
    domainElement.textContent = "";
    stateLabel.textContent = "unsupported";
    actionButton.disabled = true;
    actionButton.textContent = "save";
    return;
  }

  actionButton.disabled = false;
  const metadata = await extractMetadata(tab.id);

  try {
    await client.getBookmarkByUrl(tab.url);
    renderState({
      saved: true,
      url: tab.url,
      title: tab.title ?? metadata.title ?? tab.url,
      metadata,
    });
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) {
      renderState({
        saved: false,
        url: tab.url,
        title: tab.title ?? metadata.title ?? tab.url,
        metadata,
      });
      return;
    }

    if (caught instanceof ApiError && caught.status === 401) {
      await setToken(null);
      popupState = null;
      showLogin();
      showError(null);
      return;
    }

    showError(getRequestErrorMessage(caught, "load failed"));
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(null);

  try {
    const response = await client.login({
      email: emailInput.value,
      password: passwordInput.value,
      client_name: "browser extension",
    });
    await setToken(response.token);
    await loadBookmarkState();
  } catch (caught) {
    showError(getRequestErrorMessage(caught, "login failed"));
  }
});

settingsToggleButton.addEventListener("click", () => {
  if (!settingsForm.classList.contains("hidden")) {
    restoreMainView();
    return;
  }

  showSettings();
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(null);

  try {
    const nextSettings = {
      apiOrigin: normalizeOrigin(settingsApiOriginInput.value),
      appOrigin: normalizeOrigin(settingsAppOriginInput.value),
    };

    await chrome.storage.local.set({
      [API_ORIGIN_KEY]: nextSettings.apiOrigin,
      [APP_ORIGIN_KEY]: nextSettings.appOrigin,
    });

    setSettings(nextSettings);
    popupState = null;
    await setToken(null);
    showLogin();
  } catch (caught) {
    showError(caught instanceof Error ? caught.message : "invalid settings");
  }
});

resetSettingsButton.addEventListener("click", async () => {
  await chrome.storage.local.remove([API_ORIGIN_KEY, APP_ORIGIN_KEY]);
  setSettings({
    apiOrigin: DEFAULT_API_ORIGIN,
    appOrigin: DEFAULT_APP_ORIGIN,
  });
  popupState = null;
  await setToken(null);
  showLogin();
  showError(null);
});

actionButton.addEventListener("click", async () => {
  if (!popupState) {
    return;
  }

  actionButton.disabled = true;
  showError(null);

  try {
    if (popupState.saved) {
      await client.deleteBookmarkByUrl(popupState.url);
    } else {
      await client.saveBookmark({
        url: popupState.url,
        title: popupState.title,
        image_url: popupState.metadata.image_url,
        site_name: popupState.metadata.site_name,
        saved_via: "extension",
      });
    }

    window.close();
  } catch (caught) {
    actionButton.disabled = false;
    showError(getRequestErrorMessage(caught, "request failed"));
  }
});

async function init() {
  await loadSettings();
  currentToken = await getToken();
  if (!currentToken) {
    showLogin();
    return;
  }

  showBookmarkView();
  await loadBookmarkState();
}

void init();
