import { classifyBookmarkUrl } from "@url-keep/shared";
import { createStoredClient } from "./settings";

type CapturedContent = {
  content_html: string;
  title: string | null;
  author: string | null;
  published_date: string | null;
  site_name: string | null;
};

async function handleCapture(tabId: number, bookmarkId: string, url: string): Promise<void> {
  if (!classifyBookmarkUrl(url).autoExtract) {
    console.log("[url-keep] skipping capture for non-reader url:", url);
    return;
  }

  const client = await createStoredClient();
  let captured: CapturedContent | null = null;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      files: ["capture.js"],
    });
    captured = (result?.result as CapturedContent | null) ?? null;
    console.log("[url-keep] capture result:", captured ? `${captured.content_html.length} chars` : "null");
  } catch (error) {
    console.warn("[url-keep] capture injection failed:", error);
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
      console.log("[url-keep] upload success for", bookmarkId);
      return;
    } catch (error) {
      console.warn("[url-keep] upload failed:", error);
    }
  }

  // Capture or upload failed — trigger server extraction as explicit fallback
  try {
    console.log("[url-keep] falling back to server extraction for", bookmarkId);
    await client.extractBookmark(bookmarkId);
  } catch (error) {
    console.warn("[url-keep] server extraction fallback failed:", error);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "capture") {
    handleCapture(
      message.tabId as number,
      message.bookmarkId as string,
      message.url as string,
    )
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true; // Keep the message channel open for async response
  }
});
