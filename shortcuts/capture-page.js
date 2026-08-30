// Paste this into Shortcuts' “Run JavaScript on Web Page” action.
// The action must receive a Safari web page and return this object to the next action.
const MAX_CAPTURE_REQUEST_BYTES = 4.5 * 1024 * 1024;

const absoluteImage = (() => {
  const value = document.querySelector('meta[property="og:image"]')?.content?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value, document.baseURI);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
})();

const payload = {
  url: location.href,
  title: document.title.trim().slice(0, 300) || undefined,
  image_url: absoluteImage,
  site_name:
    document.querySelector('meta[property="og:site_name"]')?.content?.trim().slice(0, 120)
    || undefined,
  saved_via: "ios_shortcut",
  captured_page: {
    html: document.documentElement.outerHTML,
    base_url: document.baseURI,
  },
};

if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_CAPTURE_REQUEST_BYTES) {
  delete payload.captured_page;
}

completion(payload);
