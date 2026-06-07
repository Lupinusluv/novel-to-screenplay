/**
 * Pipeline UI state reducer. Pure: folds the SSE `PipelineEvent` stream into the
 * shape the timeline + screenplay views render from. Kept transport-free and in
 * `lib/` so it unit-tests in the node environment with zero DOM.
 *
 * Two subtle backend behaviours drive the design:
 *   - **E1 — `error` frames are two-natured.** The orchestrator emits a
 *     *scene-level* error (`stage === "scenes"` with a `sceneId`) and then keeps
 *     going (placeholder scene + further `partial_result`/`final_result`). That
 *     must NOT kill the run — it is a per-scene warning. Any other error (no
 *     `sceneId`, or a non-scenes stage, or the stream dying before
 *     `final_result`) is fatal. `final_result` is always authoritative → `done`.
 *   - **E2 — scene ids sort by natural number, not lexicographically.** Ids look
 *     like `scene_${chapter}_${index}`, so `scene_1_10` must sort after
 *     `scene_1_2`. `final_result.screenplay.scenes` is the final authority.
 *
 * E10 discipline: `import type` only from schema/events — no agent runtime/fs/env.
 */

import type { PipelineEvent, Stage } from "../agent/events";
import type { Scene, Screenplay } from "../schema/screenplay";

export type StageStatus = "pending" | "active" | "done" | "error";

export interface StageView {
  status: StageStatus;
  done?: number;
  total?: number;
}

export interface SceneWarning {
  sceneId?: string;
  message: string;
}

export interface PipelineState {
  status: "idle" | "running" | "done" | "error";
  stages: Record<Stage, StageView>;
  /** Accumulated from `partial_result`, upserted by id in natural order. */
  scenes: Scene[];
  /** Per-scene warnings (E1 scene-level errors); never fatal. */
  warnings: SceneWarning[];
  screenplay?: Screenplay;
  yaml?: string;
  /** The fatal error, if any. `code` mirrors the event's structured failure
   *  class (e.g. "insufficient_balance") when present. */
  error?: { stage: Stage; sceneId?: string; message: string; code?: string };
}

export function initialPipelineState(): PipelineState {
  return {
    status: "idle",
    stages: {
      chunk: { status: "pending" },
      storybible: { status: "pending" },
      scenes: { status: "pending" },
      assemble: { status: "pending" },
    },
    scenes: [],
    warnings: [],
  };
}

/** Compare scene ids by their numeric components (E2: natural, not lexical). */
function naturalCompareId(a: string, b: string): number {
  const na = a.match(/\d+/g)?.map(Number) ?? [];
  const nb = b.match(/\d+/g)?.map(Number) ?? [];
  const len = Math.max(na.length, nb.length);
  for (let i = 0; i < len; i++) {
    const da = na[i] ?? 0;
    const db = nb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return a.localeCompare(b);
}

function setStage(
  state: PipelineState,
  stage: Stage,
  patch: Partial<StageView>,
): Record<Stage, StageView> {
  return {
    ...state.stages,
    [stage]: { ...state.stages[stage], ...patch },
  };
}

export function pipelineReducer(
  state: PipelineState,
  event: PipelineEvent,
): PipelineState {
  switch (event.type) {
    case "stage_start":
      return {
        ...state,
        status: state.status === "idle" ? "running" : state.status,
        stages: setStage(state, event.stage, {
          status: "active",
          ...(event.total !== undefined ? { total: event.total } : {}),
        }),
      };

    case "stage_progress":
      return {
        ...state,
        status: state.status === "idle" ? "running" : state.status,
        stages: setStage(state, event.stage, {
          status: "active",
          done: event.done,
          total: event.total,
        }),
      };

    case "stage_done":
      return {
        ...state,
        stages: setStage(state, event.stage, { status: "done" }),
      };

    case "partial_result": {
      const next = state.scenes.filter((s) => s.id !== event.scene.id);
      next.push(event.scene);
      next.sort((a, b) => naturalCompareId(a.id, b.id));
      return { ...state, scenes: next };
    }

    case "final_result":
      return {
        ...state,
        status: "done",
        screenplay: event.screenplay,
        yaml: event.yaml,
        scenes: event.screenplay.scenes,
      };

    case "error": {
      const isSceneLevel = event.stage === "scenes" && event.sceneId != null;
      if (isSceneLevel) {
        // E1: per-scene warning — the pipeline keeps going, do not go fatal.
        return {
          ...state,
          warnings: [
            ...state.warnings,
            { sceneId: event.sceneId, message: event.message },
          ],
        };
      }
      return {
        ...state,
        status: "error",
        stages: setStage(state, event.stage, { status: "error" }),
        error: {
          stage: event.stage,
          ...(event.sceneId != null ? { sceneId: event.sceneId } : {}),
          message: event.message,
          ...(event.code != null ? { code: event.code } : {}),
        },
      };
    }

    default:
      return state;
  }
}
