/**
 * Client orchestrator: the single place that owns the streaming run. Holds the
 * novel text + the folded `PipelineState` (via `useReducer(pipelineReducer)`),
 * kicks off `runConversion`, and renders the input / timeline / screenplay
 * layout.
 *
 * E4 concurrency isolation: every run gets a monotonically increasing `runId`
 * and a fresh `AbortController`. Starting (or cancelling) a run aborts the prior
 * controller and bumps the id; the `onEvent` callback drops any event whose
 * captured id is no longer current, so a late frame from an aborted stream can
 * never pollute the new run's state.
 *
 * PR8 adds an `edited` overlay (YAML round-trip editing) and a `sourceNovel`
 * snapshot (traceability). The overlay lives OUTSIDE the reducer so the SSE
 * stream stays a pure, replayable projection; the App merges the two into
 * `display*` values that drive every view + export. The snapshot freezes the
 * novel as it was at conversion time, so 溯源 keeps locating even after the user
 * edits the input box for a fresh run. Both reset on start / cancel / retry.
 */

"use client";

import { useReducer, useRef, useState } from "react";
import {
  initialPipelineState,
  pipelineReducer,
  type PipelineState,
} from "../../lib/client/pipelineState";
import { runConversion } from "../../lib/client/sseClient";
import type { PipelineEvent } from "../../lib/agent/events";
import type { Screenplay } from "../../lib/schema/screenplay";
import { toYAML } from "../../lib/schema/yaml";
import { InputPanel } from "./InputPanel";
import { AgentTimeline } from "./AgentTimeline";
import { ScreenplayView } from "./ScreenplayView";

type Action = { kind: "reset" } | { kind: "event"; event: PipelineEvent };

function appReducer(state: PipelineState, action: Action): PipelineState {
  if (action.kind === "reset") return initialPipelineState();
  return pipelineReducer(state, action.event);
}

function isTerminal(event: PipelineEvent): boolean {
  if (event.type === "final_result") return true;
  // A fatal error (no sceneId / non-scenes stage) ends the run; a scene-level
  // warning does not (E1).
  return (
    event.type === "error" &&
    !(event.stage === "scenes" && event.sceneId != null)
  );
}

export function ConverterApp({
  runConversionImpl = runConversion,
}: {
  runConversionImpl?: typeof runConversion;
}) {
  const [novel, setNovel] = useState("");
  const [state, dispatch] = useReducer(appReducer, undefined, initialPipelineState);
  const [inFlight, setInFlight] = useState(false);
  // PR8: user edit overlay + conversion-time novel snapshot.
  const [edited, setEdited] = useState<Screenplay | undefined>(undefined);
  const [sourceNovel, setSourceNovel] = useState("");

  const runIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  function startConversion() {
    if (novel.trim().length === 0) return;

    // Invalidate + abort any in-flight run (E4).
    controllerRef.current?.abort();
    const myRunId = ++runIdRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;

    setEdited(undefined); // a new run invalidates any prior edit (E16)
    setSourceNovel(novel); // freeze the source for traceability (E2)
    dispatch({ kind: "reset" });
    setInFlight(true);

    void runConversionImpl(novel, undefined, {
      signal: controller.signal,
      onEvent: (event) => {
        if (runIdRef.current !== myRunId) return; // late event from an old run
        dispatch({ kind: "event", event });
        if (isTerminal(event)) setInFlight(false);
      },
    });
  }

  function cancelConversion() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    runIdRef.current += 1; // invalidate the current run's callbacks
    setEdited(undefined);
    dispatch({ kind: "reset" });
    setInFlight(false);
  }

  const showResults = inFlight || state.status !== "idle";

  // Edit overlay merged with the streamed state — drives every view + export.
  const displayScreenplay = edited ?? state.screenplay;
  const displayScenes = edited ? edited.scenes : state.scenes;
  const displayYaml = edited ? toYAML(edited) : state.yaml;
  const canEdit = state.status === "done";
  const sceneStage = state.stages.scenes;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
      <header className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          AI 小说转剧本
        </h1>
        <p className="mt-2 text-zinc-500 dark:text-zinc-400">
          粘贴小说 → agent 流水线实时拆解 → 结构化可导出剧本
        </p>
      </header>

      <InputPanel
        value={novel}
        onChange={setNovel}
        onConvert={startConversion}
        busy={inFlight}
      />

      {state.error && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <span>
            转换失败（{state.error.stage}）：{state.error.message}
          </span>
          <button
            type="button"
            onClick={startConversion}
            className="rounded-md border border-red-400 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/40"
          >
            重试
          </button>
        </div>
      )}

      {showResults ? (
        <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
          <div className="lg:sticky lg:top-6 lg:self-start">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
                Agent 流水线
              </h2>
              {inFlight && state.status !== "done" && (
                <button
                  type="button"
                  onClick={cancelConversion}
                  className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  取消
                </button>
              )}
            </div>
            <AgentTimeline state={state} />
          </div>

          <ScreenplayView
            scenes={displayScenes}
            screenplay={displayScreenplay}
            yaml={displayYaml}
            novel={sourceNovel}
            warnings={state.warnings}
            warningsStale={!!edited}
            canEdit={canEdit}
            onApply={setEdited}
            streaming={inFlight}
            sceneProgress={{ done: sceneStage.done, total: sceneStage.total }}
          />
        </div>
      ) : (
        <EmptyGuidance />
      )}
    </div>
  );
}

function EmptyGuidance() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-700">
      <span className="text-3xl" aria-hidden>
        📝
      </span>
      <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
        粘贴小说正文、上传 .txt，或载入内置示例
      </p>
      <p className="text-xs text-zinc-400">
        点上方「转换」即可看到 agent 流水线实时拆解为可编辑、可溯源的剧本。
      </p>
    </div>
  );
}
