import type { UrlKeepClient } from "@url-keep/api-client";
import type { CaptureResult } from "./capture";

export type CaptureWorkflowDependencies = {
  client: UrlKeepClient;
  injectCapture: () => Promise<CaptureResult | null>;
};

export async function runCaptureWorkflow(
  bookmarkId: string,
  dependencies: CaptureWorkflowDependencies,
): Promise<"uploaded" | "preserved" | "fallback"> {
  const captured = await dependencies.injectCapture().catch(() => null);
  if (captured?.content_html) {
    try {
      await dependencies.client.uploadBookmarkContent(bookmarkId, captured);
      return "uploaded";
    } catch {
      // Check whether an earlier complete client capture is still canonical.
    }
  }

  try {
    const existing = await dependencies.client.getBookmarkContent(bookmarkId);
    if (
      existing.item.extraction_status === "complete"
      && existing.item.content_source === "client"
      && existing.item.content_html
    ) {
      return "preserved";
    }
  } catch {
    // Extraction remains the best fallback when status lookup fails.
  }

  await dependencies.client.extractBookmark(bookmarkId);
  return "fallback";
}
