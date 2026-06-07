// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { YamlView } from "./YamlView";
import { toYAML } from "../../lib/schema/yaml";
import { validScreenplay } from "../../lib/schema/fixtures";

const baseYaml = toYAML(validScreenplay());

describe("YamlView — read-only (streaming / canEdit=false)", () => {
  it("renders a <pre> and no editor when not editable", () => {
    const { container } = render(<YamlView yaml={baseYaml} canEdit={false} />);
    expect(container.querySelector("pre")).not.toBeNull();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("YamlView — editable (canEdit=true)", () => {
  it("seeds an editable textarea with the yaml", () => {
    render(<YamlView yaml={baseYaml} canEdit onApply={() => {}} />);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.value).toBe(baseYaml);
  });

  it("calls onApply with the parsed screenplay on a valid edit", () => {
    const onApply = vi.fn();
    render(<YamlView yaml={baseYaml} canEdit onApply={onApply} />);
    const edited = baseYaml.replace("title: 深夜咖啡馆", "title: 新标题");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: edited } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].title).toBe("新标题");
  });

  it("shows an inline error and does NOT call onApply on invalid YAML", () => {
    const onApply = vi.fn();
    render(<YamlView yaml={baseYaml} canEdit onApply={onApply} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "title: [unterminated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText(/语法|错误/)).toBeInTheDocument();
  });

  it("applies but warns when the edit introduces a broken reference", () => {
    const onApply = vi.fn();
    render(<YamlView yaml={baseYaml} canEdit onApply={onApply} />);
    const broken = toYAML(
      validScreenplay({
        scenes: [
          {
            id: "scene_1",
            heading: { int_ext: "INT", location_id: "loc_cafe", time_of_day: "DAY" },
            synopsis: "x",
            source: { chapter: 1, excerpt: "第1段" },
            elements: [
              { type: "dialogue", character_id: "char_missing", line: "谁?" },
            ],
          },
        ],
      }),
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: broken } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(/引用|警告/).length).toBeGreaterThan(0);
  });

  it("re-seeds the editor when the yaml prop changes out of band (new canonical version)", () => {
    const { rerender } = render(
      <YamlView yaml={baseYaml} canEdit onApply={() => {}} />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "乱改的草稿" } });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "乱改的草稿",
    );
    // parent pushes a different canonical yaml (e.g. a new run finished) while
    // this instance stays mounted — the editor must re-seed, not keep the draft.
    const other = toYAML(validScreenplay({ logline: "另一条故事线" }));
    rerender(<YamlView yaml={other} canEdit onApply={() => {}} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(other);
  });

  it("restores the draft to the current yaml on 重置", () => {
    render(<YamlView yaml={baseYaml} canEdit onApply={() => {}} />);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "乱改的内容" } });
    expect(ta.value).toBe("乱改的内容");
    fireEvent.click(screen.getByRole("button", { name: "重置" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      baseYaml,
    );
  });
});
