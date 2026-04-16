import { ApiError } from "@url-keep/api-client";
import {
  TOKEN_KEY,
  API_ORIGIN_KEY,
  APP_ORIGIN_KEY,
  QUICK_SAVE_KEY,
  DEFAULT_API_ORIGIN,
  createClient,
  getStoredToken,
} from "./settings";

declare const __APP_ORIGIN__: string;

const DEFAULT_APP_ORIGIN = __APP_ORIGIN__;

const loginForm = document.getElementById("login-form") as HTMLFormElement;
const bookmarkView = document.getElementById("bookmark-view") as HTMLElement;
const settingsForm = document.getElementById("settings-form") as HTMLFormElement;
const settingsToggleButton = document.getElementById("settings-toggle") as HTMLButtonElement;
const emailInput = document.getElementById("email") as HTMLInputElement;
const passwordInput = document.getElementById("password") as HTMLInputElement;
const domainElement = document.getElementById("domain") as HTMLElement;
const actionButton = document.getElementById("action-button") as HTMLButtonElement;
const stateNoteElement = document.getElementById("state-note") as HTMLElement;
const deleteLink = document.getElementById("delete-link") as HTMLButtonElement;
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
const quickSaveCheckbox = document.getElementById(
  "settings-quick-save",
) as HTMLInputElement;
const successView = document.getElementById("success-view") as HTMLElement;
const successDomain = document.getElementById("success-domain") as HTMLElement;
const successOpenApp = document.getElementById("success-open-app") as HTMLAnchorElement;
const successRemove = document.getElementById("success-remove") as HTMLButtonElement;
const errorElement = document.getElementById("error") as HTMLElement;

type ExtractedMetadata = {
  title?: string;
  image_url?: string;
  site_name?: string;
};

type PopupState = {
  saved: boolean;
  checking: boolean;
  url: string;
  title: string;
  tabId: number | null;
  metadata: ExtractedMetadata;
};

type RuntimeSettings = {
  apiOrigin: string;
  appOrigin: string;
};

let currentToken: string | null = null;
let popupState: PopupState | null = null;
let quickSaveEnabled = false;
let autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
let currentSettings: RuntimeSettings = {
  apiOrigin: DEFAULT_API_ORIGIN,
  appOrigin: DEFAULT_APP_ORIGIN,
};
let client = makePopupClient(currentSettings.apiOrigin);

function makePopupClient(baseUrl: string) {
  return createClient(baseUrl, () => currentToken);
}

function triggerCapture(tabId: number | null, bookmarkId: string | null, url: string | null) {
  if (tabId && bookmarkId && url) {
    chrome.runtime.sendMessage({
      action: "capture",
      tabId,
      bookmarkId,
      url,
    }).catch(() => {});
  }
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
  client = makePopupClient(settings.apiOrigin);
  openAppLink.href = settings.appOrigin;
  successOpenApp.href = settings.appOrigin;
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

function setCheckingState() {
  stateNoteElement.textContent = "checking...";
  deleteLink.classList.add("hidden");
}

function clearInlineState() {
  stateNoteElement.textContent = "";
  deleteLink.classList.add("hidden");
}

function setDeleteState() {
  stateNoteElement.textContent = "";
  deleteLink.classList.remove("hidden");
}

function setUnsupportedState() {
  actionButton.disabled = true;
  stateNoteElement.textContent = "unsupported page";
  deleteLink.classList.add("hidden");
}

function showLogin() {
  settingsForm.classList.add("hidden");
  loginForm.classList.remove("hidden");
  bookmarkView.classList.add("hidden");
  successView.classList.add("hidden");
  settingsToggleButton.textContent = "settings";
}

function showBookmarkView() {
  settingsForm.classList.add("hidden");
  loginForm.classList.add("hidden");
  successView.classList.add("hidden");
  bookmarkView.classList.remove("hidden");
  settingsToggleButton.textContent = "settings";
}

function showSuccessView(domain: string) {
  loginForm.classList.add("hidden");
  bookmarkView.classList.add("hidden");
  settingsForm.classList.add("hidden");
  successView.classList.remove("hidden");
  successDomain.textContent = domain;
  settingsToggleButton.textContent = "settings";
}

function showSettings() {
  showError(null);
  loginForm.classList.add("hidden");
  bookmarkView.classList.add("hidden");
  successView.classList.add("hidden");
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

function resetButtonStyle() {
  actionButton.classList.remove("button--dimmed", "button--success");
}

function renderState(state: PopupState) {
  popupState = state;
  showBookmarkView();
  showError(null);
  domainElement.textContent = new URL(state.url).hostname;
  actionButton.disabled = false;
  resetButtonStyle();

  if (state.checking) {
    actionButton.textContent = "save";
    setCheckingState();
    return;
  }

  if (state.saved) {
    actionButton.textContent = "saved";
    actionButton.classList.add("button--dimmed");
    setDeleteState();
    return;
  }

  actionButton.textContent = "save";
  clearInlineState();
}

async function loadQuickSave(): Promise<boolean> {
  const result = await chrome.storage.local.get(QUICK_SAVE_KEY);
  return result[QUICK_SAVE_KEY] === true;
}

async function quickSave() {
  const tab = await getCurrentTab();
  if (!tab?.id || !tab.url || !isSupportedUrl(tab.url)) {
    showBookmarkView();
    domainElement.textContent = "";
    setUnsupportedState();
    return;
  }

  showBookmarkView();
  domainElement.textContent = new URL(tab.url).hostname;
  actionButton.disabled = true;
  actionButton.textContent = "saving...";
  resetButtonStyle();
  clearInlineState();
  showError(null);

  const title = tab.title ?? tab.url;
  let metadata: ExtractedMetadata = {};
  try {
    metadata = await extractMetadata(tab.id);
  } catch {
    // best-effort
  }

  popupState = {
    saved: false,
    checking: false,
    url: tab.url,
    title: metadata.title ?? title,
    tabId: tab.id ?? null,
    metadata,
  };

  try {
    const response = await client.saveBookmark({
      url: tab.url,
      title: metadata.title ?? title,
      image_url: metadata.image_url,
      site_name: metadata.site_name,
      saved_via: "extension",
    });

    triggerCapture(tab.id ?? null, response.item?.id ?? null, tab.url ?? null);

    popupState = { ...popupState, saved: true };
    showSuccessView(new URL(tab.url).hostname);
    showError(null);
    autoCloseTimer = setTimeout(() => window.close(), 1800);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 401) {
      await setToken(null);
      showLogin();
      return;
    }
    actionButton.disabled = false;
    actionButton.textContent = "save";
    showError(getRequestErrorMessage(caught, "save failed"));
  }
}

async function loadBookmarkState() {
  const tab = await getCurrentTab();
  if (!tab?.id || !tab.url || !isSupportedUrl(tab.url)) {
    popupState = null;
    showBookmarkView();
    showError(null);
    domainElement.textContent = "";
    setUnsupportedState();
    return;
  }

  const baseTitle = tab.title ?? tab.url;
  popupState = {
    saved: false,
    checking: true,
    url: tab.url,
    title: baseTitle,
    tabId: tab.id ?? null,
    metadata: {},
  };
  showBookmarkView();
  showError(null);
  domainElement.textContent = new URL(tab.url).hostname;
  renderState(popupState);
  void extractMetadata(tab.id)
    .then((metadata) => {
      if (!popupState || popupState.url !== tab.url) {
        return;
      }

      popupState = {
        ...popupState,
        metadata,
        title: popupState.title === tab.url && metadata.title ? metadata.title : popupState.title,
      };
    })
    .catch(() => undefined);

  try {
    await client.getBookmarkByUrl(tab.url);
    renderState({ ...popupState, saved: true, checking: false });
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) {
      renderState({ ...popupState, saved: false, checking: false });
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
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  }

  if (!settingsForm.classList.contains("hidden")) {
    restoreMainView();
    return;
  }

  showSettings();
});

successRemove.addEventListener("click", async () => {
  if (!popupState) return;

  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  }

  showBookmarkView();
  domainElement.textContent = new URL(popupState.url).hostname;
  actionButton.disabled = true;
  actionButton.textContent = "save";
  resetButtonStyle();
  stateNoteElement.textContent = "removing...";
  deleteLink.classList.add("hidden");
  showError(null);

  try {
    await client.deleteBookmarkByUrl(popupState.url);
    renderState({ ...popupState, saved: false, checking: false });
  } catch (caught) {
    renderState({ ...popupState, saved: true, checking: false });
    showError(getRequestErrorMessage(caught, "delete failed"));
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(null);

  try {
    const nextSettings = {
      apiOrigin: normalizeOrigin(settingsApiOriginInput.value),
      appOrigin: normalizeOrigin(settingsAppOriginInput.value),
    };

    const originsChanged =
      nextSettings.apiOrigin !== currentSettings.apiOrigin ||
      nextSettings.appOrigin !== currentSettings.appOrigin;

    await chrome.storage.local.set({
      [API_ORIGIN_KEY]: nextSettings.apiOrigin,
      [APP_ORIGIN_KEY]: nextSettings.appOrigin,
      [QUICK_SAVE_KEY]: quickSaveCheckbox.checked,
    });

    quickSaveEnabled = quickSaveCheckbox.checked;
    setSettings(nextSettings);

    if (originsChanged) {
      popupState = null;
      await setToken(null);
      showLogin();
    } else {
      restoreMainView();
    }
  } catch (caught) {
    showError(caught instanceof Error ? caught.message : "invalid settings");
  }
});

resetSettingsButton.addEventListener("click", async () => {
  await chrome.storage.local.remove([API_ORIGIN_KEY, APP_ORIGIN_KEY, QUICK_SAVE_KEY]);
  setSettings({
    apiOrigin: DEFAULT_API_ORIGIN,
    appOrigin: DEFAULT_APP_ORIGIN,
  });
  quickSaveEnabled = false;
  quickSaveCheckbox.checked = false;
  popupState = null;
  await setToken(null);
  showLogin();
  showError(null);
});

actionButton.addEventListener("click", async () => {
  if (!popupState || actionButton.disabled) {
    return;
  }

  actionButton.disabled = true;
  actionButton.textContent = "saving...";
  resetButtonStyle();
  showError(null);

  try {
    const response = await client.saveBookmark({
      url: popupState.url,
      title: popupState.title,
      image_url: popupState.metadata.image_url,
      site_name: popupState.metadata.site_name,
      saved_via: "extension",
    });

    triggerCapture(popupState.tabId, response.item?.id ?? null, popupState.url);

    actionButton.textContent = "\u2713 saved";
    actionButton.classList.add("button--success");
    setTimeout(() => window.close(), 700);
  } catch (caught) {
    actionButton.disabled = false;
    actionButton.textContent = popupState.saved ? "saved" : "save";
    if (popupState.saved) {
      actionButton.classList.add("button--dimmed");
    }
    showError(getRequestErrorMessage(caught, "request failed"));
  }
});

deleteLink.addEventListener("click", async () => {
  if (!popupState || deleteLink.classList.contains("hidden")) {
    return;
  }

  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  }

  deleteLink.disabled = true;
  stateNoteElement.textContent = "removing...";
  showError(null);

  try {
    await client.deleteBookmarkByUrl(popupState.url);
    renderState({
      ...popupState,
      saved: false,
      checking: false,
    });
  } catch (caught) {
    if (popupState.saved) {
      setDeleteState();
    } else {
      clearInlineState();
    }
    showError(getRequestErrorMessage(caught, "delete failed"));
  } finally {
    deleteLink.disabled = false;
  }
});

async function init() {
  await loadSettings();
  quickSaveEnabled = await loadQuickSave();
  quickSaveCheckbox.checked = quickSaveEnabled;
  currentToken = await getStoredToken();
  if (!currentToken) {
    showLogin();
    return;
  }

  if (quickSaveEnabled) {
    await quickSave();
  } else {
    showBookmarkView();
    await loadBookmarkState();
  }
}

void init();
