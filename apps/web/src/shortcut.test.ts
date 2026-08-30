// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TextEncoder } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";

const script = readFileSync(
  resolve(import.meta.dirname, "../../../shortcuts/capture-page.js"),
  "utf8",
);

function runShortcutScript() {
  let result: Record<string, unknown> | null = null;
  const execute = new Function(
    "document",
    "location",
    "TextEncoder",
    "completion",
    script,
  );
  execute(document, window.location, TextEncoder, (value: Record<string, unknown>) => {
    result = value;
  });
  return result!;
}

beforeEach(() => {
  document.documentElement.innerHTML = `
    <head><title>Subscriber article</title><meta property="og:site_name" content="Example"></head>
    <body><article>Readable page</article></body>
  `;
  window.history.replaceState({}, "", "/article");
});

describe("Safari Shortcut capture source", () => {
  it("includes the live DOM under the preflight budget", () => {
    const result = runShortcutScript();
    expect(result.bookmark).toMatchObject({
      url: "http://localhost:3000/article",
      saved_via: "ios_shortcut",
    });
    expect(result.capture_html).toContain("<article>Readable page</article>");
    expect(result).not.toHaveProperty("captured_page");
  });

  it("downgrades an oversized page to URL and title metadata", () => {
    document.body.textContent = "x".repeat(Math.ceil(4.5 * 1024 * 1024));
    const result = runShortcutScript();
    expect(result.capture_html).toBeUndefined();
    expect(result.bookmark).toMatchObject({
      url: "http://localhost:3000/article",
      title: "Subscriber article",
    });
  });
});
