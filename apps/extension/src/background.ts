import { classifyBookmarkUrl } from "@url-keep/shared";
import { createStoredClient } from "./settings";
import type { CaptureResult } from "./capture";
import { runCaptureWorkflow } from "./capture-workflow";

async function handleCapture(tabId: number, bookmarkId: string, url: string): Promise<void> {
  if (!classifyBookmarkUrl(url).autoExtract) return;

  const client = await createStoredClient();
  await runCaptureWorkflow(bookmarkId, {
    client,
    injectCapture: async () => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        files: ["capture.js"],
      });
      return (result?.result as CaptureResult | null) ?? null;
    },
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action !== "capture") return undefined;

  handleCapture(
    message.tabId as number,
    message.bookmarkId as string,
    message.url as string,
  )
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});
