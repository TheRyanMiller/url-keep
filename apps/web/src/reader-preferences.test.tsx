// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReaderDocument } from "./App";

function renderReader() {
  return render(
    <ReaderDocument
      contentHtml="<p>Readable article text.</p>"
      extractionStatus="complete"
      header={<span>Reader</span>}
      sourceUrl="https://publisher.example/article"
      title="Article"
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.readerTheme;
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.readerTheme;
});

describe("reader preferences", () => {
  it("keeps text size and theme in one menu and persists both choices", () => {
    renderReader();

    fireEvent.click(screen.getByRole("button", { name: "Reading preferences" }));
    expect(screen.getByRole("group", { name: "Reading preferences" })).toBeVisible();
    expect(screen.getByRole("button", { name: "M text size" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Switch to dark reader theme" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Switch to light reader theme" }))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark reader theme" }));
    expect(document.documentElement.dataset.readerTheme).toBe("dark");
    expect(localStorage.getItem("url_keep_reader_theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light reader theme" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "L text size" }));
    expect(localStorage.getItem("url_keep_reader_text_size")).toBe("l");
    expect(document.querySelector(".reader-content")).toHaveClass("reader-content-size-l");
    expect(screen.getByRole("group", { name: "Reading preferences" })).toBeVisible();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("group", { name: "Reading preferences" })).not.toBeInTheDocument();
  });

  it("restores the application theme when the reader closes", () => {
    const reader = renderReader();
    fireEvent.click(screen.getByRole("button", { name: "Reading preferences" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to dark reader theme" }));

    reader.unmount();

    expect(document.documentElement).not.toHaveAttribute("data-reader-theme");
  });
});
