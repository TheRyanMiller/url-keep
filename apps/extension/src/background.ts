import { classifyBookmarkUrl, type ArticleMetadata } from "@url-keep/shared";
import { createStoredClient } from "./settings";
import { runCaptureWorkflow } from "./capture-workflow";

async function handleCapture(
  tabId: number,
  bookmarkId: string,
  url: string,
  article: ArticleMetadata | null,
): Promise<void> {
  if (!classifyBookmarkUrl(url).autoExtract) return;

  const client = await createStoredClient();
  await runCaptureWorkflow(bookmarkId, article, {
    client,
    injectCapture: async () => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        files: ["capture.js"],
      });
      return (result?.result as string | null) ?? null;
    },
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action !== "capture") return undefined;

  handleCapture(
    message.tabId as number,
    message.bookmarkId as string,
    message.url as string,
    (message.article as ArticleMetadata | null | undefined) ?? null,
  )
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});
