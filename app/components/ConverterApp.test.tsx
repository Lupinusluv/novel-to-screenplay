// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ConverterApp } from "./ConverterApp";
import type { PipelineEvent } from "../../lib/agent/events";
import type { Screenplay } from "../../lib/schema/screenplay";

type RunArgs = {
  onEvent: (e: PipelineEvent) => void;
  signal?: AbortSignal;
};

function lateScreenplay(title: string): Screenplay {
  return { title, logline: "l", characters: [], locations: [], scenes: [] };
}

function startConversion(novel = "一些小说正文") {
  const calls: RunArgs[] = [];
  const runImpl = vi.fn(
    (_novel: string, _options: unknown, args: RunArgs) => {
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

describe("ConverterApp", () => {
  it("isolates runs by runId: an old run's late event cannot pollute the new run (E4)", () => {
    const calls = startConversion();
    const convert = screen.getByRole("button", { name: "转换" });

    fireEvent.click(convert); // run A
    fireEvent.click(convert); // run B — must abort A

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
});
