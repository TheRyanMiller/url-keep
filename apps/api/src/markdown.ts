import { marked } from "marked";

marked.setOptions({
  breaks: true,
  gfm: true,
});

export function hasHtmlMarkup(value: string): boolean {
  return /<([a-z][^\s/>]*)(?:\s[^>]*)?>/i.test(value);
}

export function renderMarkdownToHtml(markdown: string): string {
  return marked.parse(markdown) as string;
}

export function extractMarkdownTitle(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.trim().match(/^#\s+(.+)$/);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}
