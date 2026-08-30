import DOMPurify from "dompurify";
import {
  ARTICLE_ALLOWED_ATTRIBUTES,
  ARTICLE_SANITIZER_POLICY,
} from "@url-keep/shared";

export function sanitizeArticleHtml(contentHtml: string, apiOrigin: string) {
  const withResolvedImages = contentHtml.replaceAll(
    'src="/images/',
    `src="${apiOrigin}/images/`,
  );
  const sanitized = DOMPurify.sanitize(withResolvedImages, {
    ALLOWED_TAGS: [...ARTICLE_SANITIZER_POLICY.allowedTags],
    ALLOWED_ATTR: ARTICLE_ALLOWED_ATTRIBUTES,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
  });
  const template = document.createElement("template");
  template.innerHTML = sanitized;

  for (const element of template.content.querySelectorAll("*")) {
    const tag = element.tagName.toLowerCase();
    const allowed = ARTICLE_SANITIZER_POLICY.allowedAttributes[
      tag as keyof typeof ARTICLE_SANITIZER_POLICY.allowedAttributes
    ] ?? [];
    for (const attribute of [...element.attributes]) {
      if (!(allowed as readonly string[]).includes(attribute.name)) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  for (const link of template.content.querySelectorAll("a")) {
    const href = link.getAttribute("href");
    if (href && !hasAllowedScheme(href, apiOrigin)) {
      link.removeAttribute("href");
    }
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  for (const image of template.content.querySelectorAll("img[src]")) {
    if (!hasAllowedScheme(image.getAttribute("src") ?? "", apiOrigin)) {
      image.removeAttribute("src");
    }
  }
  return template.innerHTML;
}

function hasAllowedScheme(value: string, baseUrl: string) {
  try {
    const protocol = new URL(value, baseUrl).protocol.replace(/:$/, "");
    return ARTICLE_SANITIZER_POLICY.allowedSchemes.some(
      (allowed) => allowed === protocol,
    );
  } catch {
    return false;
  }
}
