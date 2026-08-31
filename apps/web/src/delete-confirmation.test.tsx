// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { Bookmark } from "@url-keep/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteConfirmation } from "./App";

const bookmark = {
  id: "00000000-0000-4000-8000-000000000001",
  url: "https://example.com/article",
  normalized_url: "https://example.com/article",
  bucket: "reading",
  title: "An article worth reading",
  title_source: "client",
  image_url: null,
  site_name: "Example",
  saved_via: "web",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  extraction_status: "complete",
} satisfies Bookmark;

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(function close(this: HTMLDialogElement) {
      this.removeAttribute("open");
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DeleteConfirmation", () => {
  it("opens a clear modal and exposes explicit cancel and delete actions", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <DeleteConfirmation
        bookmark={bookmark}
        busy={false}
        error={null}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("dialog", { name: "delete bookmark?" })).toHaveAttribute("open");
    expect(screen.getByText(/An article worth reading/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
