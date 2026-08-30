import sanitizeHtml from "sanitize-html";
import { ARTICLE_SANITIZER_POLICY } from "@url-keep/shared";

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ARTICLE_SANITIZER_POLICY.allowedTags],
  allowedAttributes: Object.fromEntries(
    Object.entries(ARTICLE_SANITIZER_POLICY.allowedAttributes).map(([tag, attributes]) => [
      tag,
      [...attributes],
    ]),
  ),
  allowedSchemes: [...ARTICLE_SANITIZER_POLICY.allowedSchemes],
  disallowedTagsMode: "discard",
  transformTags: {
    a: (_tagName, attributes) => ({
      tagName: "a",
      attribs: {
        ...attributes,
        target: "_blank",
        rel: "noopener noreferrer",
      },
    }),
  },
};

export function sanitizeClientHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}
