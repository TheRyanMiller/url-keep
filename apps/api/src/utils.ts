import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";
import { canonicalizeBookmarkUrl, classifyBookmarkUrl } from "@url-keep/shared";
import type { BookmarkRecord } from "./types";

const textEncoder = new TextEncoder();

const PASSWORD_HASH_ALGO = "pbkdf2_sha256";
const PBKDF2_ITERATIONS = 25_000;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_DKLEN = 32;

type VerifiedPassword = {
  valid: boolean;
};

async function derivePbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  dkLen: number,
): Promise<Uint8Array> {
  const passwordBytes = Uint8Array.from(textEncoder.encode(password));
  const normalizedSalt = Uint8Array.from(salt);
  const key = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: normalizedSalt,
      iterations,
      hash: "SHA-256",
    },
    key,
    dkLen * 8,
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }

  return mismatch === 0;
}

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

export function makeShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToHex(bytes);
}

export function hashToken(token: string, pepper: string): string {
  const tokenBytes = textEncoder.encode(`${token}${pepper}`);
  return bytesToHex(sha256(tokenBytes));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const derived = await derivePbkdf2(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PASSWORD_DKLEN,
  );

  return [
    PASSWORD_HASH_ALGO,
    String(PBKDF2_ITERATIONS),
    bytesToHex(salt),
    bytesToHex(derived),
  ].join("$");
}

async function verifyPbkdf2Password(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_ALGO) {
    return false;
  }

  const [, iterationsString, saltHex, hashHex] = parts;
  const iterations = Number(iterationsString);
  if (!Number.isInteger(iterations) || iterations < 1) {
    return false;
  }

  const expected = hexToBytes(hashHex);
  const derived = await derivePbkdf2(
    password,
    hexToBytes(saltHex),
    iterations,
    expected.length,
  );
  return timingSafeEqual(derived, expected);
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<VerifiedPassword> {
  return {
    valid: storedHash.startsWith(`${PASSWORD_HASH_ALGO}$`)
      && await verifyPbkdf2Password(password, storedHash),
  };
}

export function normalizeUrl(input: string): string {
  const trimmed = canonicalizeBookmarkUrl(input);
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
  const classification = classifyBookmarkUrl(bookmark.normalizedUrl);
  return {
    id: bookmark.id,
    url: bookmark.url,
    normalized_url: bookmark.normalizedUrl,
    bucket: bookmark.bucket ?? classification.bucket,
    title: bookmark.title,
    image_url: bookmark.imageUrl,
    site_name: bookmark.siteName,
    saved_via: bookmark.savedVia,
    created_at: bookmark.createdAt,
    updated_at: bookmark.updatedAt,
    extraction_status: classification.autoExtract ? bookmark.extractionStatus ?? null : null,
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
