// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SceneCard } from "./SceneCard";
import type { Scene } from "../../lib/schema/screenplay";

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: "scene_1_1",
    heading: { int_ext: "INT", location_id: "loc_rongguo", time_of_day: "DAY" },
    synopsis: "黛玉初进荣国府",
    source: { chapter: 1, excerpt: "原文片段" },
    elements: [
      { type: "action", text: "众人迎黛玉入府" },
      { type: "dialogue", character_id: "char_daiyu", line: "这是外祖母家" },
    ],
    ...overrides,
  };
}

describe("SceneCard", () => {
  it("renders action text, dialogue speaker + line, synopsis and chapter", () => {
    render(<SceneCard scene={makeScene()} />);
    expect(screen.getByText("众人迎黛玉入府")).toBeInTheDocument();
    expect(screen.getByText("char_daiyu")).toBeInTheDocument();
    expect(screen.getByText("这是外祖母家")).toBeInTheDocument();
    expect(screen.getByText("黛玉初进荣国府")).toBeInTheDocument();
    // chapter provenance is shown somewhere on the card
    expect(screen.getByText(/第\s*1\s*章|chapter 1/i)).toBeInTheDocument();
  });

  it("shows a needs-review badge only when needs_review is set", () => {
    const { rerender } = render(
      <SceneCard scene={makeScene({ needs_review: true })} />,
    );
    expect(screen.getByText("需复核")).toBeInTheDocument();

    rerender(<SceneCard scene={makeScene({ needs_review: false })} />);
    expect(screen.queryByText("需复核")).not.toBeInTheDocument();
  });

  it("opens the source modal when the 溯源 button is clicked", () => {
    render(<SceneCard scene={makeScene()} novel="前面原文片段后面" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /溯源/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // excerpt is shown verbatim inside the modal
    expect(screen.getAllByText("原文片段").length).toBeGreaterThan(0);
  });

  it("expands the needs-review badge to reveal its reason message", () => {
    render(
      <SceneCard
        scene={makeScene({ needs_review: true })}
        reviewMessage="引用未解析：char_unknown"
      />,
    );
    expect(screen.queryByText("引用未解析：char_unknown")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("需复核"));
    expect(screen.getByText("引用未解析：char_unknown")).toBeInTheDocument();
  });
});
