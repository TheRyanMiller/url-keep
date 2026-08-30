import { describe, expect, it } from "vitest";
import { ARTICLE_SANITIZER_HOSTILE_FIXTURES } from "@url-keep/shared";
import { sanitizeClientHtml } from "./sanitize";

describe("API sanitizer", () => {
  for (const fixture of ARTICLE_SANITIZER_HOSTILE_FIXTURES) {
    it(`enforces the shared policy for ${fixture.name}`, () => {
      const result = sanitizeClientHtml(fixture.html);
      for (const value of fixture.retained) expect(result).toContain(value);
      for (const value of fixture.removed) expect(result).not.toContain(value);
    });
  }
});
