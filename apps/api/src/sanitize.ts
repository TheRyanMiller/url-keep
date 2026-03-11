import sanitizeHtml from "sanitize-html";

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "a", "img",
    "blockquote", "pre", "code",
    "em", "strong", "b", "i", "br", "hr",
    "figure", "figcaption",
    "table", "thead", "tbody", "tr", "th", "td",
    "sup", "sub", "del",
    "div", "span",
  ],
  allowedAttributes: {
    "a": ["href", "title"],
    "img": ["src", "alt", "title"],
  },
  allowedSchemes: ["http", "https"],
  disallowedTagsMode: "discard",
};

export function sanitizeClientHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}
