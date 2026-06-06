// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScreenplayView } from "./ScreenplayView";
import type { Screenplay, Scene } from "../../lib/schema/screenplay";

function makeScene(id: string): Scene {
  return {
    id,
    heading: { int_ext: "INT", location_id: "loc_1", time_of_day: "DAY" },
    synopsis: "黛玉初进荣国府",
    source: { chapter: 1, excerpt: "x" },
    elements: [{ type: "action", text: "众人相迎" }],
  };
}

const scenes = [makeScene("scene_1_1")];
const screenplay: Screenplay = {
  title: "红楼梦剧本",
  logline: "一见钟情",
  characters: [],
  locations: [],
  scenes,
};
const YAML = "yaml_marker_42: true";

describe("ScreenplayView", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
  });

  it("shows title + scene cards by default, hiding the YAML source", () => {
    render(<ScreenplayView scenes={scenes} screenplay={screenplay} yaml={YAML} />);
    expect(screen.getByText("红楼梦剧本")).toBeInTheDocument();
    expect(screen.getByText("黛玉初进荣国府")).toBeInTheDocument();
    expect(screen.queryByText(YAML)).not.toBeInTheDocument();
  });

  it("switches to the YAML source view when the YAML tab is clicked", () => {
    render(<ScreenplayView scenes={scenes} screenplay={screenplay} yaml={YAML} />);
    fireEvent.click(screen.getByRole("button", { name: "YAML" }));
    expect(screen.getByText(YAML)).toBeInTheDocument();
    expect(screen.queryByText("黛玉初进荣国府")).not.toBeInTheDocument();
  });

  it("offers the export button when yaml is present", () => {
    render(<ScreenplayView scenes={scenes} screenplay={screenplay} yaml={YAML} />);
    expect(screen.getByRole("button", { name: /导出/ })).toBeInTheDocument();
  });
});
