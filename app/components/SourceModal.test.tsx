// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SourceModal } from "./SourceModal";
import type { Scene } from "../../lib/schema/screenplay";

function makeScene(over: Partial<Scene> = {}): Scene {
  return {
    id: "scene_1_1",
    heading: { int_ext: "INT", location_id: "loc_x", time_of_day: "DAY" },
    synopsis: "概要",
    source: { chapter: 3, excerpt: "甲乙丙" },
    elements: [{ type: "action", text: "x" }],
    ...over,
  };
}

describe("SourceModal", () => {
  it("always shows the chapter and the excerpt verbatim (trust fallback)", () => {
    render(
      <SourceModal scene={makeScene()} novel="完全不同的文本" onClose={() => {}} />,
    );
    expect(screen.getByText(/第\s*3\s*章/)).toBeInTheDocument();
    expect(screen.getByText("甲乙丙")).toBeInTheDocument();
  });

  it("highlights the located passage with a <mark> element", () => {
    const { container } = render(
      <SourceModal scene={makeScene()} novel="前文甲乙丙后文" onClose={() => {}} />,
    );
    const mark = container.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("甲乙丙");
  });

  it("shows a fallback note and no highlight when not located", () => {
    const { container } = render(
      <SourceModal scene={makeScene()} novel="完全不同的文本" onClose={() => {}} />,
    );
    expect(container.querySelector("mark")).toBeNull();
    expect(screen.getByText(/未能.*定位/)).toBeInTheDocument();
  });

  it("renders novel as text, never as HTML (no XSS via injected tags)", () => {
    const { container } = render(
      <SourceModal
        scene={makeScene()}
        novel="安全<script>alert(1)</script>甲乙丙"
        onClose={() => {}}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<SourceModal scene={makeScene()} novel="x" onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop mousedown but not on panel mousedown", () => {
    const onClose = vi.fn();
    render(<SourceModal scene={makeScene()} novel="x" onClose={onClose} />);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId("source-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is an accessible modal dialog labelled by its title", () => {
    render(<SourceModal scene={makeScene()} novel="x" onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)).toBeInTheDocument();
  });
});
