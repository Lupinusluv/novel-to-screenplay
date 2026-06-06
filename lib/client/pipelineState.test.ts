import { describe, it, expect } from "vitest";
import {
  initialPipelineState,
  pipelineReducer,
  type PipelineState,
} from "./pipelineState";
import type { PipelineEvent } from "../agent/events";
import type { Scene, Screenplay } from "../schema/screenplay";

function scene(id: string): Scene {
  return {
    id,
    heading: { int_ext: "INT", location_id: "loc_1", time_of_day: "DAY" },
    synopsis: `synopsis ${id}`,
    source: { chapter: 1, excerpt: "excerpt" },
    elements: [],
  };
}

function reduce(events: PipelineEvent[]): PipelineState {
  return events.reduce(pipelineReducer, initialPipelineState());
}

describe("initialPipelineState", () => {
  it("starts idle with all four stages pending and no scenes", () => {
    const s = initialPipelineState();
    expect(s.status).toBe("idle");
    expect(s.scenes).toEqual([]);
    expect(s.stages.chunk.status).toBe("pending");
    expect(s.stages.storybible.status).toBe("pending");
    expect(s.stages.scenes.status).toBe("pending");
    expect(s.stages.assemble.status).toBe("pending");
  });
});

describe("pipelineReducer", () => {
  it("marks a stage active and records total on stage_start, going running", () => {
    const s = reduce([{ type: "stage_start", stage: "scenes", total: 3 }]);
    expect(s.status).toBe("running");
    expect(s.stages.scenes.status).toBe("active");
    expect(s.stages.scenes.total).toBe(3);
  });

  it("updates done/total on stage_progress", () => {
    const s = reduce([
      { type: "stage_start", stage: "scenes", total: 9 },
      { type: "stage_progress", stage: "scenes", done: 3, total: 9 },
    ]);
    expect(s.stages.scenes.done).toBe(3);
    expect(s.stages.scenes.total).toBe(9);
  });

  it("marks a stage done on stage_done", () => {
    const s = reduce([
      { type: "stage_start", stage: "chunk" },
      { type: "stage_done", stage: "chunk" },
    ]);
    expect(s.stages.chunk.status).toBe("done");
  });

  it("upserts partial_result scenes by id in natural-number order (E2)", () => {
    const s = reduce([
      { type: "partial_result", scene: scene("scene_1_10") },
      { type: "partial_result", scene: scene("scene_1_2") },
      // duplicate id arrives again -> replace, not append
      { type: "partial_result", scene: scene("scene_1_2") },
    ]);
    expect(s.scenes.map((sc) => sc.id)).toEqual(["scene_1_2", "scene_1_10"]);
  });

  it("treats final_result as authoritative: done + screenplay/yaml + scenes", () => {
    const screenplay: Screenplay = {
      title: "红楼梦",
      logline: "logline",
      characters: [],
      locations: [],
      scenes: [scene("scene_1_1"), scene("scene_1_2")],
    };
    const s = reduce([
      { type: "stage_start", stage: "scenes", total: 2 },
      { type: "partial_result", scene: scene("scene_1_2") },
      { type: "final_result", screenplay, yaml: "yaml-text" },
    ]);
    expect(s.status).toBe("done");
    expect(s.screenplay).toEqual(screenplay);
    expect(s.yaml).toBe("yaml-text");
    expect(s.scenes).toEqual(screenplay.scenes);
  });

  it("scene-level error (scenes + sceneId) does not kill the run (E1)", () => {
    const s = reduce([
      { type: "stage_start", stage: "scenes", total: 3 },
      {
        type: "error",
        stage: "scenes",
        sceneId: "scene_1_2",
        message: "retries exhausted",
      },
    ]);
    expect(s.status).toBe("running");
    expect(s.stages.scenes.status).toBe("active");
    expect(s.warnings).toEqual([
      { sceneId: "scene_1_2", message: "retries exhausted" },
    ]);
  });

  it("final_result wins even after a scene-level error (E1)", () => {
    const screenplay: Screenplay = {
      title: "t",
      logline: "l",
      characters: [],
      locations: [],
      scenes: [scene("scene_1_1")],
    };
    const s = reduce([
      { type: "stage_start", stage: "scenes", total: 1 },
      { type: "error", stage: "scenes", sceneId: "scene_1_1", message: "warn" },
      { type: "final_result", screenplay, yaml: "y" },
    ]);
    expect(s.status).toBe("done");
  });

  it("fatal error (no sceneId) sets status error and marks the stage error (E1)", () => {
    const s = reduce([
      { type: "stage_start", stage: "storybible" },
      { type: "error", stage: "storybible", message: "LLM exploded" },
    ]);
    expect(s.status).toBe("error");
    expect(s.stages.storybible.status).toBe("error");
    expect(s.error).toEqual({ stage: "storybible", message: "LLM exploded" });
  });

  it("error in scenes stage without a sceneId is fatal, not a warning (E1)", () => {
    const s = reduce([
      { type: "stage_start", stage: "scenes", total: 3 },
      { type: "error", stage: "scenes", message: "stream broke" },
    ]);
    expect(s.status).toBe("error");
    expect(s.stages.scenes.status).toBe("error");
  });
});
