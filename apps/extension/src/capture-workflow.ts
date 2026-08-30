import type { UrlKeepClient } from "@url-keep/api-client";
import type { ArticleMetadata } from "@url-keep/shared";
import type { CaptureResult } from "./capture";

export type CaptureWorkflowDependencies = {
  client: UrlKeepClient;
  injectCapture: () => Promise<CaptureResult | null>;
};

export async function runCaptureWorkflow(
  bookmarkId: string,
  existingArticle: ArticleMetadata | null,
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

  if (
    existingArticle?.status === "complete"
    && existingArticle.content_source === "client"
  ) {
    return "preserved";
  }

  await dependencies.client.extractBookmark(bookmarkId);
  return "fallback";
}
