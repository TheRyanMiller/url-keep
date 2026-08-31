// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReaderDocument } from "./App";

afterEach(cleanup);

function renderReader(contentHtml: string, imageUrl: string) {
  return render(
    <ReaderDocument
      contentHtml={contentHtml}
      extractionStatus="complete"
      header={<span>Reader</span>}
      imageUrl={imageUrl}
      sourceUrl="https://publisher.example/story"
      title="Article title"
    />,
  );
}

describe("reader lead image", () => {
  it("renders standard lead metadata instead of promoting a body avatar", () => {
    const reader = renderReader(
      '<p><img src="https://publisher.example/author.jpg" alt="Author"></p><p>Story.</p>',
      "https://publisher.example/video-poster.jpg",
    );

    expect(reader.container.querySelector(".reader-lead-image img"))
      .toHaveAttribute("src", "https://publisher.example/video-poster.jpg");
    expect(reader.container.querySelector('.reader-content img[alt="Author"]'))
      .toBeInTheDocument();
  });

  it("does not duplicate a lead image already retained in article content", () => {
    const imageUrl = "https://publisher.example/lead.jpg";
    const reader = renderReader(`<figure><img src="${imageUrl}" alt="Lead"></figure>`, imageUrl);

    expect(reader.container.querySelector(".reader-lead-image")).not.toBeInTheDocument();
    expect(reader.container.querySelectorAll(`img[src="${imageUrl}"]`)).toHaveLength(1);
  });
});
