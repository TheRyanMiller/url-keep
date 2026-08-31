const MAX_CAPTURE_REQUEST_BYTES = 4.5 * 1024 * 1024;

export function capture(): string | null {
  const html = document.documentElement.outerHTML;
  return new TextEncoder().encode(html).byteLength <= MAX_CAPTURE_REQUEST_BYTES
    ? html
    : null;
}
