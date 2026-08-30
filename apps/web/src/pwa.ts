export function detectStandaloneMode(
  iosStandalone: boolean | undefined,
  displayModeStandalone: boolean,
) {
  return iosStandalone === true || displayModeStandalone;
}

export async function shareLink(
  data: ShareData,
  nativeShare: ((data: ShareData) => Promise<void>) | undefined,
  copy: (url: string) => Promise<void>,
): Promise<"shared" | "copied" | "aborted"> {
  if (nativeShare) {
    try {
      await nativeShare(data);
      return "shared";
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        return "aborted";
      }
    }
  }

  await copy(data.url ?? "");
  return "copied";
}
