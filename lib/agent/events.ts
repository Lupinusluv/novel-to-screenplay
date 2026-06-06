/**
 * Pipeline event contract (shared by the orchestrator that emits events and the
 * SSE encoder that serialises them). Homed here rather than in orchestrator.ts
 * so the pure `eventToSSE` encoder does not import the orchestrator (which pulls
 * in every agent) — keeps the encoder cheap to unit-test and avoids a cycle.
 */

import type { Scene, Screenplay } from "../schema/screenplay";

export type Stage = "chunk" | "storybible" | "scenes" | "assemble";

export type PipelineEvent =
  | { type: "stage_start"; stage: Stage; total?: number }
  | {
      type: "stage_progress";
      stage: Stage;
      done: number;
      total: number;
      sceneId?: string;
    }
  | { type: "partial_result"; scene: Scene } // per-scene, completion order (E5b)
  | { type: "stage_done"; stage: Stage }
  | { type: "final_result"; screenplay: Screenplay; yaml: string } // last frame (E10)
  | { type: "error"; stage: Stage; sceneId?: string; message: string };
