import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { scrypt } from "@noble/hashes/scrypt";
import { sha256 } from "@noble/hashes/sha2";
import type { BookmarkRecord } from "./types";

const textEncoder = new TextEncoder();

const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(): string {
  return crypto.randomUUID();
}

export function makeOpaqueToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `uk_${bytesToHex(bytes)}`;
}

export function hashToken(token: string, pepper: string): string {
  const tokenBytes = textEncoder.encode(`${token}${pepper}`);
  return bytesToHex(sha256(tokenBytes));
}

export function hashPassword(password: string): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = scrypt(textEncoder.encode(password), salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: SCRYPT_DKLEN,
  });

  return [
    "scrypt",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    bytesToHex(salt),
    bytesToHex(derived),
  ].join("$");
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }

  const [, nString, rString, pString, saltHex, hashHex] = parts;
  const expected = hexToBytes(hashHex);
  const derived = scrypt(textEncoder.encode(password), hexToBytes(saltHex), {
    N: Number(nString),
    r: Number(rString),
    p: Number(pString),
    dkLen: expected.length,
  });

  if (derived.length !== expected.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < derived.length; index += 1) {
    mismatch |= derived[index] ^ expected[index];
  }

  return mismatch === 0;
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  const url = new URL(trimmed);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http or https");
  }

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  if (!url.pathname) {
    url.pathname = "/";
  }

  return url.toString();
}

export function deriveFallbackTitle(normalizedUrl: string): string {
  try {
    const url = new URL(normalizedUrl);
    return url.hostname || normalizedUrl;
  } catch {
    return normalizedUrl;
  }
}

export function validateHttpsImageUrl(input: string | undefined): string | null {
  if (!input) {
    return null;
  }

  const url = new URL(input);
  if (url.protocol !== "https:") {
    throw new Error("image_url must be an absolute https URL");
  }

  return url.toString();
}

export function bookmarkToApi(bookmark: BookmarkRecord) {
  return {
    id: bookmark.id,
    url: bookmark.url,
    normalized_url: bookmark.normalizedUrl,
    title: bookmark.title,
    image_url: bookmark.imageUrl,
    site_name: bookmark.siteName,
    saved_via: bookmark.savedVia,
    created_at: bookmark.createdAt,
    updated_at: bookmark.updatedAt,
  };
}

export function encodeCursor(bookmark: Pick<BookmarkRecord, "createdAt" | "id">) {
  const value = `${bookmark.createdAt}|${bookmark.id}`;
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeCursor(
  cursor: string | undefined,
): { createdAt: string; id: string } | null {
  if (!cursor) {
    return null;
  }

  try {
    const padded = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(
      `${padded}${"=".repeat((4 - (padded.length % 4)) % 4)}`,
    );
    const [createdAt, id] = decoded.split("|");
    if (!createdAt || !id) {
      return null;
    }

    return { createdAt, id };
  } catch {
    return null;
  }
}

export function shouldRefreshLastUsed(lastUsedAt: string | null, now: string): boolean {
  if (!lastUsedAt) {
    return true;
  }

  const thenMs = Date.parse(lastUsedAt);
  const nowMs = Date.parse(now);
  return Number.isFinite(thenMs) && Number.isFinite(nowMs)
    ? nowMs - thenMs >= 60 * 60 * 1000
    : true;
}
