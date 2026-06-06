// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScreenplayView } from "./ScreenplayView";
import type { Screenplay, Scene } from "../../lib/schema/screenplay";
import { toYAML } from "../../lib/schema/yaml";
import { validScreenplay } from "../../lib/schema/fixtures";

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

  it("threads novel down so a card's 溯源 opens the source modal", () => {
    render(
      <ScreenplayView
        scenes={scenes}
        screenplay={screenplay}
        yaml={YAML}
        novel="前面x后面"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /溯源/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("threads a per-scene warning message to the needs-review badge", () => {
    render(
      <ScreenplayView
        scenes={[{ ...makeScene("scene_1_1"), needs_review: true }]}
        screenplay={screenplay}
        yaml={YAML}
        warnings={[{ sceneId: "scene_1_1", message: "断引用：char_x" }]}
      />,
    );
    fireEvent.click(screen.getByText("需复核"));
    expect(screen.getByText("断引用：char_x")).toBeInTheDocument();
  });

  it("makes the YAML tab editable and lifts a valid edit via onApply", () => {
    const realYaml = toYAML(validScreenplay());
    const onApply = vi.fn();
    render(
      <ScreenplayView
        scenes={scenes}
        screenplay={screenplay}
        yaml={realYaml}
        canEdit
        onApply={onApply}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "YAML" }));
    const edited = realYaml.replace("title: 深夜咖啡馆", "title: 改了");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: edited } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].title).toBe("改了");
  });

  it("shows a streaming skeleton with progress when no scenes have arrived", () => {
    render(
      <ScreenplayView
        scenes={[]}
        streaming
        sceneProgress={{ done: 1, total: 3 }}
      />,
    );
    expect(screen.getByText(/场景编剧工作中/)).toBeInTheDocument();
    expect(screen.getByText(/1\s*\/\s*3/)).toBeInTheDocument();
  });
});
