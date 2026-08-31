import type { UrlKeepClient } from "@url-keep/api-client";
import type { ArticleMetadata } from "@url-keep/shared";

export type CaptureWorkflowDependencies = {
  client: UrlKeepClient;
  injectCapture: () => Promise<string | null>;
};

export async function runCaptureWorkflow(
  bookmarkId: string,
  existingArticle: ArticleMetadata | null,
  dependencies: CaptureWorkflowDependencies,
): Promise<"captured" | "preserved" | "fallback"> {
  const captured = await dependencies.injectCapture().catch(() => null);
  if (captured) {
    try {
      await dependencies.client.captureBookmark(bookmarkId, captured);
      return "captured";
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
