import { UrlKeepClient } from "@url-keep/api-client";

declare const __API_ORIGIN__: string;

export const TOKEN_KEY = "url_keep_token";
export const API_ORIGIN_KEY = "url_keep_api_origin";
export const APP_ORIGIN_KEY = "url_keep_app_origin";
export const QUICK_SAVE_KEY = "url_keep_quick_save";
export const DEFAULT_API_ORIGIN = __API_ORIGIN__;

export function createClient(baseUrl: string, getToken: () => string | null): UrlKeepClient {
  return new UrlKeepClient({ baseUrl, getToken });
}

export async function getStoredToken(): Promise<string | null> {
  const result = await chrome.storage.local.get(TOKEN_KEY);
  return (result[TOKEN_KEY] as string | undefined) ?? null;
}

export async function getStoredApiOrigin(): Promise<string> {
  const result = await chrome.storage.local.get(API_ORIGIN_KEY);
  const value = result[API_ORIGIN_KEY] as string | undefined;
  if (value) {
    try {
      return new URL(value.trim()).origin;
    } catch { /* fall through */ }
  }
  return DEFAULT_API_ORIGIN;
}

export async function createStoredClient(): Promise<UrlKeepClient> {
  const [token, apiOrigin] = await Promise.all([
    getStoredToken(),
    getStoredApiOrigin(),
  ]);
  return new UrlKeepClient({
    baseUrl: apiOrigin,
    getToken: () => token,
  });
}
