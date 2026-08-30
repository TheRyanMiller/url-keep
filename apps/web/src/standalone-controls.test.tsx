// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("renders no redundant browser controls in a regular tab", async () => {
    setDisplayMode(false);
    render(<StandaloneControls />);
    await waitFor(() => expect(window.matchMedia).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "refresh" })).not.toBeInTheDocument();
  });

  it("renders one quiet refresh action in installed mode", async () => {
    setDisplayMode(true);
    const reload = vi.fn();
    render(<StandaloneControls reload={reload} />);
    const refresh = await screen.findByRole("button", { name: "refresh" });
    expect(screen.queryByRole("button", { name: "share" })).not.toBeInTheDocument();
    fireEvent.click(refresh);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("adds Share only when a reader supplies an explicit safe URL", async () => {
    setDisplayMode(true);
    render(
      <StandaloneControls
        share={{ title: "Article", url: "https://publisher.example/article" }}
      />,
    );
    expect(await screen.findByRole("button", { name: "share" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "refresh" })).toBeInTheDocument();
  });
});
