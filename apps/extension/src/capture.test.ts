// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { CAPTURE_PREFLIGHT_MAX_BYTES } from "@url-keep/shared";
import { capture } from "./capture";

beforeEach(() => {
  document.documentElement.innerHTML = `
    <head><title>Live article</title></head>
    <body><article><h1>Live article</h1><p>Readable text.</p></article></body>
  `;
});

describe("extension page capture", () => {
  it("returns the live DOM without performing article extraction", () => {
    const html = capture();
    expect(html).toContain("<title>Live article</title>");
    expect(html).toContain("<article>");
  });

  it("leaves oversized pages for bounded server URL extraction", () => {
    document.body.textContent = "x".repeat(CAPTURE_PREFLIGHT_MAX_BYTES);
    expect(capture()).toBeNull();
  });
});
