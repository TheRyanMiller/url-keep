import { UrlKeepClient, ApiError } from "@url-keep/api-client";

declare const __API_ORIGIN__: string;
declare const __APP_ORIGIN__: string;

const TOKEN_KEY = "url_keep_token";
const API_ORIGIN = __API_ORIGIN__;
const APP_ORIGIN = __APP_ORIGIN__;

const loginForm = document.getElementById("login-form") as HTMLFormElement;
const bookmarkView = document.getElementById("bookmark-view") as HTMLElement;
const emailInput = document.getElementById("email") as HTMLInputElement;
const passwordInput = document.getElementById("password") as HTMLInputElement;
const domainElement = document.getElementById("domain") as HTMLElement;
const stateLabel = document.getElementById("state-label") as HTMLElement;
const actionButton = document.getElementById("action-button") as HTMLButtonElement;
const openAppLink = document.getElementById("open-app-link") as HTMLAnchorElement;
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

const client = new UrlKeepClient({
  baseUrl: API_ORIGIN,
  getToken: () => currentToken,
});

let currentToken: string | null = null;
let popupState: PopupState | null = null;

openAppLink.href = APP_ORIGIN;

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

function showLogin() {
  loginForm.classList.remove("hidden");
  bookmarkView.classList.add("hidden");
}

function showBookmarkView() {
  loginForm.classList.add("hidden");
  bookmarkView.classList.remove("hidden");
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

    showError(caught instanceof Error ? caught.message : "load failed");
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
    showError(caught instanceof ApiError ? caught.message : "login failed");
  }
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
    showError(caught instanceof ApiError ? caught.message : "request failed");
  }
});

async function init() {
  currentToken = await getToken();
  if (!currentToken) {
    showLogin();
    return;
  }

  showBookmarkView();
  await loadBookmarkState();
}

void init();
