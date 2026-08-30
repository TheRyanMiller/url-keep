import type { UrlKeepClient } from "@url-keep/api-client";
import {
  classifyBookmarkUrl,
  type BookmarkMutationResponse,
  type CreateBookmarkRequest,
} from "@url-keep/shared";

export async function saveBookmarkWithReader(
  client: Pick<UrlKeepClient, "saveBookmark" | "extractBookmark">,
  input: CreateBookmarkRequest,
): Promise<BookmarkMutationResponse> {
  const saved = await client.saveBookmark(input);
  const { article, bookmark } = saved.item;

  if (
    !classifyBookmarkUrl(bookmark.normalized_url).autoExtract
    || article?.status === "complete"
  ) {
    return saved;
  }

  return client.extractBookmark(bookmark.id);
}
