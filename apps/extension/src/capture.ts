import { Readability } from "@mozilla/readability";

export type CaptureResult = {
  content_html: string;
  title: string | null;
  author: string | null;
  published_date: string | null;
  site_name: string | null;
};

function resolveUrls(html: string, baseUrl: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const img of doc.querySelectorAll("img[src]")) {
    try {
      img.setAttribute("src", new URL(img.getAttribute("src")!, baseUrl).href);
    } catch {
      img.removeAttribute("src");
    }
  }
  for (const link of doc.querySelectorAll("a[href]")) {
    try {
      link.setAttribute("href", new URL(link.getAttribute("href")!, baseUrl).href);
    } catch {
      link.removeAttribute("href");
    }
  }
  return doc.body.innerHTML;
}

export function capture(): CaptureResult | null {
  const clone = document.cloneNode(true) as Document;
  const readable = new Readability(clone).parse();

  if (!readable?.content) return null;

  return {
    content_html: resolveUrls(readable.content, document.baseURI),
    title: readable.title?.trim().slice(0, 300) || null,
    author: readable.byline?.trim().slice(0, 300) || null,
    published_date: readable.publishedTime?.trim().slice(0, 100) || null,
    site_name: readable.siteName?.trim().slice(0, 120) || null,
  };
}
