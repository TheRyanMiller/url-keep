import { Readability } from "@mozilla/readability";

type CaptureResult = {
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
    } catch { /* leave malformed src alone */ }
  }
  for (const a of doc.querySelectorAll("a[href]")) {
    try {
      a.setAttribute("href", new URL(a.getAttribute("href")!, baseUrl).href);
    } catch { /* leave malformed hrefs alone */ }
  }
  return doc.body.innerHTML;
}

export function capture(): CaptureResult | null {
  const clone = document.cloneNode(true) as Document;
  const readable = new Readability(clone).parse();

  if (!readable?.content) {
    return null;
  }

  const contentHtml = resolveUrls(readable.content, document.baseURI);

  return {
    content_html: contentHtml,
    title: readable.title || null,
    author: readable.byline || null,
    published_date: readable.publishedTime || null,
    site_name: readable.siteName || null,
  };
}

// IIFE — executeScript({ files }) uses the last evaluated expression as return value
capture();
