import {
  classifyBookmarkUrl,
  toReadableBookmarkUrl,
  type Bookmark,
} from "@url-keep/shared";

export type BookmarkDestination =
  | { kind: "reader"; href: string }
  | { kind: "source"; href: string }
  | { kind: "unavailable"; href: null };

export function resolveBookmarkDestination(
  bookmark: Bookmark,
  online: boolean,
  availableOffline: boolean,
): BookmarkDestination {
  const classification = classifyBookmarkUrl(bookmark.normalized_url);
  if (
    classification.autoExtract
    && bookmark.extraction_status === "complete"
    && (online || availableOffline)
  ) {
    return { kind: "reader", href: `/read/${bookmark.id}` };
  }
  if (online) {
    return { kind: "source", href: toReadableBookmarkUrl(bookmark.url) };
  }
  return { kind: "unavailable", href: null };
}
