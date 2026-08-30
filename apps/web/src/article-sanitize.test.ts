// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ARTICLE_SANITIZER_HOSTILE_FIXTURES } from "@url-keep/shared";
import { sanitizeArticleHtml } from "./article-sanitize";

describe("reader sanitizer", () => {
  for (const fixture of ARTICLE_SANITIZER_HOSTILE_FIXTURES) {
    it(`enforces the shared policy for ${fixture.name}`, () => {
      const result = sanitizeArticleHtml(fixture.html, "https://api.example.com");
      for (const value of fixture.retained) expect(result).toContain(value);
      for (const value of fixture.removed) expect(result).not.toContain(value);
    });
  }
});
