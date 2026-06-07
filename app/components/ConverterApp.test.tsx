// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ConverterApp } from "./ConverterApp";
import type { PipelineEvent } from "../../lib/agent/events";
import type { Screenplay } from "../../lib/schema/screenplay";
import { toYAML } from "../../lib/schema/yaml";

type RunArgs = {
  onEvent: (e: PipelineEvent) => void;
  signal?: AbortSignal;
  /** The novel text this run was invoked with (captured by the test mock). */
  novel?: string;
};

function lateScreenplay(title: string): Screenplay {
  return { title, logline: "l", characters: [], locations: [], scenes: [] };
}

/** A fully-valid done screenplay whose single scene's excerpt is locatable. */
function doneScreenplay(): Screenplay {
  return {
    title: "深夜咖啡馆",
    logline: "一名刑警遇见证人。",
    characters: [{ id: "char_lin", name: "林深", aliases: [] }],
    locations: [{ id: "loc_cafe", name: "咖啡馆", aliases: [] }],
    scenes: [
      {
        id: "scene_1",
        heading: { int_ext: "INT", location_id: "loc_cafe", time_of_day: "DAY" },
        synopsis: "概要",
        source: { chapter: 1, excerpt: "甲乙丙" },
        elements: [{ type: "action", text: "动作" }],
      },
    ],
  };
}

function startConversion(novel = "一些小说正文") {
  const calls: RunArgs[] = [];
  const runImpl = vi.fn(
    (novelArg: string, _options: unknown, args: RunArgs) => {
      args.novel = novelArg;
      calls.push(args);
      return Promise.resolve();
    },
  );
  render(<ConverterApp runConversionImpl={runImpl as never} />);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: novel },
  });
  return calls;
}

/** The YAML editor textarea (distinct from the novel input textarea). */
function yamlEditor(): HTMLTextAreaElement {
  const all = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
  const ta = all.find((t) => t.value.includes("title:"));
  if (!ta) throw new Error("yaml editor textarea not found");
  return ta;
}

describe("ConverterApp", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
  });

  it("isolates runs by runId: a late event from a cancelled run cannot pollute a new run (E4)", () => {
    const calls = startConversion();
    fireEvent.click(screen.getByRole("button", { name: "转换" })); // run A
    fireEvent.click(screen.getByRole("button", { name: "取消" })); // abort A + reset
    fireEvent.click(screen.getByRole("button", { name: "转换" })); // run B

    expect(calls).toHaveLength(2);
    expect(calls[0].signal?.aborted).toBe(true);

    // A late final_result from run A must be ignored entirely.
    act(() => {
      calls[0].onEvent({
        type: "final_result",
        screenplay: lateScreenplay("LATE_TITLE_A"),
        yaml: "late",
      });
    });
    expect(screen.queryByText("LATE_TITLE_A")).not.toBeInTheDocument();

    // Run B's event is applied: the storybible stage lights up.
    act(() => {
      calls[1].onEvent({ type: "stage_start", stage: "storybible" });
    });
    const row = screen.getByText(/设定集/).closest("li");
    expect(row).toHaveTextContent("进行中");
  });

  it("shows a 取消 button while running and returns to idle when clicked (E4)", () => {
    const calls = startConversion();
    fireEvent.click(screen.getByRole("button", { name: "转换" }));

    const cancel = screen.getByRole("button", { name: "取消" });
    expect(cancel).toBeInTheDocument();

    fireEvent.click(cancel);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument();
  });

  it("disables 转换 while a run is in flight (no duplicate submit)", () => {
    startConversion();
    const convert = screen.getByRole("button", { name: "转换" });
    expect(convert).not.toBeDisabled();
    fireEvent.click(convert);
    // while in flight the button relabels to 转换中… and is disabled (no dup submit)
    expect(screen.getByRole("button", { name: "转换中…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "转换" })).not.toBeInTheDocument();
  });

  it("offers 重试 after a fatal error and re-runs the CONVERTED text even if the input box was cleared", () => {
    const calls = startConversion("原始小说正文");
    fireEvent.click(screen.getByRole("button", { name: "转换" }));
    act(() => {
      calls[0].onEvent({ type: "error", stage: "storybible", message: "boom" });
    });
    expect(screen.getByText(/转换失败/)).toBeInTheDocument();
    // user clears the input box after the failure
    fireEvent.change(screen.getByPlaceholderText(/粘贴小说/), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    // retry must still fire, and re-run the text that actually failed (snapshot),
    // not the now-empty input box (which would silently no-op).
    expect(calls).toHaveLength(2);
    expect(calls[1].novel).toBe("原始小说正文");
  });

  it("shows friendly demo-out-of-credit guidance + GitHub link on an insufficient_balance error, hiding the raw provider message", () => {
    const calls = startConversion("原始小说正文");
    fireEvent.click(screen.getByRole("button", { name: "转换" }));
    act(() => {
      calls[0].onEvent({
        type: "error",
        stage: "storybible",
        message: 'LLM request failed 402: {"error":{"message":"Insufficient Balance"}}',
        code: "insufficient_balance",
      });
    });
    // Human guidance is shown, not the raw provider payload.
    expect(screen.getByText(/演示站额度已用尽/)).toBeInTheDocument();
    expect(screen.queryByText(/Insufficient Balance/)).not.toBeInTheDocument();
    // A clickable link points at the repo's local-deploy guide.
    const link = screen.getByRole("link", { name: /部署|GitHub|快速开始/ });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("github.com/Lupinusluv/novel-to-screenplay"),
    );
    // 重试 is still offered (a top-up could fix it without a reload).
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("still shows the raw message for an ordinary (non-balance) fatal error", () => {
    const calls = startConversion("原始小说正文");
    fireEvent.click(screen.getByRole("button", { name: "转换" }));
    act(() => {
      calls[0].onEvent({ type: "error", stage: "storybible", message: "boom-xyz" });
    });
    expect(screen.getByText(/boom-xyz/)).toBeInTheDocument();
    expect(screen.queryByText(/额度/)).not.toBeInTheDocument();
  });

  it("applies a YAML edit and reflects the new title in the header", () => {
    const calls = startConversion();
    fireEvent.click(screen.getByRole("button", { name: "转换" }));
    act(() => {
      calls[0].onEvent({
        type: "final_result",
        screenplay: doneScreenplay(),
        yaml: toYAML(doneScreenplay()),
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "YAML" }));
    fireEvent.change(yamlEditor(), {
      target: {
        value: toYAML(doneScreenplay()).replace(
          "title: 深夜咖啡馆",
          "title: 编辑后标题",
        ),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(screen.getByText("编辑后标题")).toBeInTheDocument();
  });

  it("drops the edit overlay when a new run starts", () => {
    const calls = startConversion();
    fireEvent.click(screen.getByRole("button", { name: "转换" }));
    act(() => {
      calls[0].onEvent({
        type: "final_result",
        screenplay: doneScreenplay(),
        yaml: toYAML(doneScreenplay()),
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "YAML" }));
    fireEvent.change(yamlEditor(), {
      target: {
        value: toYAML(doneScreenplay()).replace(
          "title: 深夜咖啡馆",
          "title: 编辑后标题",
        ),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(screen.getByText("编辑后标题")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "转换" })); // new run
    expect(screen.queryByText("编辑后标题")).not.toBeInTheDocument();
  });

  it("uses the conversion-time novel snapshot for 溯源 (survives input edits)", () => {
    const calls = startConversion("前文甲乙丙后文");
    fireEvent.click(screen.getByRole("button", { name: "转换" }));
    act(() => {
      calls[0].onEvent({
        type: "final_result",
        screenplay: doneScreenplay(),
        yaml: toYAML(doneScreenplay()),
      });
    });
    // user edits the novel input AFTER the run completed
    fireEvent.change(screen.getByPlaceholderText(/粘贴小说/), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "溯源" }));
    expect(document.querySelector("mark")?.textContent).toBe("甲乙丙");
  });
});
