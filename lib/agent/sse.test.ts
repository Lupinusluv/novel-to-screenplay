import { describe, it, expect } from "vitest";
import { eventToSSE } from "./sse";
import type { PipelineEvent } from "./events";

describe("eventToSSE (E9: typed SSE event channel)", () => {
  it("encodes as `event: <type>\\ndata: <json>\\n\\n`", () => {
    const ev: PipelineEvent = { type: "stage_start", stage: "scenes", total: 9 };
    const frame = eventToSSE(ev);
    expect(frame).toBe(`event: stage_start\ndata: ${JSON.stringify(ev)}\n\n`);
  });

  it("ends every frame with a blank-line terminator", () => {
    const frame = eventToSSE({ type: "stage_done", stage: "chunk" });
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  it("JSON-escapes payloads so a multiline message stays on one data line", () => {
    const ev: PipelineEvent = {
      type: "error",
      stage: "scenes",
      sceneId: "scene_3_1",
      message: "line one\nline two",
    };
    const frame = eventToSSE(ev);
    const dataLines = frame.split("\n").filter((l) => l.startsWith("data: "));
    expect(dataLines).toHaveLength(1);
    const parsed = JSON.parse(dataLines[0].slice("data: ".length));
    expect(parsed).toEqual(ev);
  });

  it("round-trips a final_result event (E10)", () => {
    const ev: PipelineEvent = {
      type: "final_result",
      screenplay: {
        title: "未命名剧本",
        logline: "（自动生成，待人工润色）",
        characters: [],
        locations: [],
        scenes: [],
      },
      yaml: "title: 未命名剧本\n",
    };
    const frame = eventToSSE(ev);
    expect(frame.startsWith("event: final_result\n")).toBe(true);
    const data = frame.split("\n").find((l) => l.startsWith("data: "))!;
    expect(JSON.parse(data.slice(6)).screenplay.title).toBe("未命名剧本");
  });
});
