// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StandaloneControls } from "./App";

function setDisplayMode(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  Object.defineProperty(navigator, "standalone", {
    configurable: true,
    value: false,
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("StandaloneControls", () => {
  it("renders no redundant browser controls in a regular tab", () => {
    setDisplayMode(false);
    render(<StandaloneControls />);
    expect(window.matchMedia).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "refresh" })).not.toBeInTheDocument();
  });

  it("renders one quiet refresh action immediately in installed mode", () => {
    setDisplayMode(true);
    const reload = vi.fn();
    render(<StandaloneControls reload={reload} />);
    const refresh = screen.getByRole("button", { name: "refresh" });
    expect(screen.queryByRole("button", { name: "share" })).not.toBeInTheDocument();
    fireEvent.click(refresh);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("adds Share only when a reader supplies an explicit safe URL", () => {
    setDisplayMode(true);
    render(
      <StandaloneControls
        share={{ title: "Article", url: "https://publisher.example/article" }}
      />,
    );
    expect(screen.getByRole("button", { name: "share" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "refresh" })).toBeInTheDocument();
  });
});
