import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { parseHTML } from "linkedom";

export const NARRATION_TEXT_MAX_CHARS = 100_000;

const BLOCK_SELECTOR = "h1, h2, h3, h4, h5, h6, p, blockquote, li";
const TERMINAL_PUNCTUATION = /[.!?:;](?:["'\u2019\u201d)\]}]+)?$/u;
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;

export class NarrationTextError extends Error {
  constructor(readonly code: "empty_text" | "text_too_large") {
    super(code === "empty_text" ? "Article has no narratable text" : "Article is too long to narrate");
    this.name = "NarrationTextError";
  }
}

function normalizeText(value: string): string {
  let normalized = "";
  const wellFormed = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!;
    return character.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff
      ? "\ufffd"
      : character;
  }).join("");
  for (const character of wellFormed.normalize("NFC")) {
    normalized += CONTROL_CHARACTER.test(character) ? " " : character;
  }
  return normalized.replace(/\s+/gu, " ").trim();
}

function sentence(value: string): string {
  return TERMINAL_PUNCTUATION.test(value) ? value : `${value}.`;
}

export function deriveNarrationText(input: {
  title: string;
  contentHtml: string;
}): { text: string; sha256: string } {
  const title = normalizeText(input.title);
  const { document } = parseHTML("<html><body></body></html>");
  const container = document.createElement("article");
  container.innerHTML = input.contentHtml;

  const blocks: string[] = [];
  const seen = new Set<string>();
  if (title) {
    blocks.push(sentence(title));
    seen.add(title);
  }

  for (const element of container.querySelectorAll(BLOCK_SELECTOR)) {
    if (element.closest("code, pre, table")) continue;
    if (element.querySelector(BLOCK_SELECTOR)) continue;
    const text = normalizeText(element.textContent ?? "");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    blocks.push(sentence(text));
  }

  const text = blocks.join("\n");
  if (!text) {
    throw new NarrationTextError("empty_text");
  }
  if ([...text].length > NARRATION_TEXT_MAX_CHARS) {
    throw new NarrationTextError("text_too_large");
  }

  return {
    text,
    sha256: bytesToHex(sha256(new TextEncoder().encode(text))),
  };
}
