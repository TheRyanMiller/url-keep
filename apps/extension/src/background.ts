import { createStoredClient } from "./settings";

type CapturedContent = {
  content_html: string;
  title: string | null;
  author: string | null;
  published_date: string | null;
  site_name: string | null;
};

async function handleCapture(tabId: number, bookmarkId: string): Promise<void> {
  const client = await createStoredClient();
  let captured: CapturedContent | null = null;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      files: ["capture.js"],
    });
    captured = (result?.result as CapturedContent | null) ?? null;
  } catch {
    // Injection failed (CSP, chrome:// page, tab closed, etc.)
  }

  if (captured?.content_html) {
    try {
      await client.uploadBookmarkContent(bookmarkId, {
        content_html: captured.content_html,
        title: captured.title,
        author: captured.author,
        published_date: captured.published_date,
        site_name: captured.site_name,
      });
      return; // Success — content is in D1
    } catch {
      // Upload failed (network error, 413, 422, etc.)
    }
  }

  // Capture or upload failed — trigger server extraction as explicit fallback
  try {
    await client.extractBookmark(bookmarkId);
  } catch {
    // Server extraction also failed to queue. Content stays pending.
    // User can retry from the web app.
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "capture") {
    handleCapture(message.tabId as number, message.bookmarkId as string)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true; // Keep the message channel open for async response
  }
});
