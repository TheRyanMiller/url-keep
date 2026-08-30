import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/narration-text.json";
import { deriveNarrationText, NarrationTextError } from "./narration-text";

describe("deriveNarrationText", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      expect(deriveNarrationText({
        title: fixture.title,
        contentHtml: fixture.html,
      })).toEqual({
        text: fixture.expected,
        sha256: fixture.sha256,
      });
    });
  }

  it("rejects empty and oversized results", () => {
    expect(() => deriveNarrationText({ title: "", contentHtml: "<pre>ignored</pre>" }))
      .toThrowError(new NarrationTextError("empty_text"));
    expect(() => deriveNarrationText({ title: "x".repeat(100_001), contentHtml: "" }))
      .toThrowError(new NarrationTextError("text_too_large"));
  });
});
