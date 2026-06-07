/**
 * The agent pipeline timeline — the demo's main axis (D1). Renders the four
 * observable SSE stages as a crew (§2.5 role mapping) and lights each one as the
 * stream advances. The `scenes` stage shows a done/total progress bar because
 * that is where the Converter/Validator/Critic self-correction loop runs and the
 * only place per-scene progress is observable.
 */

import type { Stage } from "../../lib/agent/events";
import type { PipelineState, StageStatus } from "../../lib/client/pipelineState";

/** §2.5: each SSE stage → the crew role the timeline shows. */
const STAGE_META: { stage: Stage; role: string; agent: string }[] = [
  { stage: "chunk", role: "场记", agent: "Chunker · 分章切场" },
  { stage: "storybible", role: "设定集", agent: "StoryBible · 抽人物地点" },
  { stage: "scenes", role: "场景编剧", agent: "Converter / Validator / Critic" },
  { stage: "assemble", role: "导演", agent: "Orchestrator · 汇编" },
];

const STATUS_LABEL: Record<StageStatus, string> = {
  pending: "等待",
  active: "进行中",
  done: "完成",
  error: "出错",
};

const DOT_CLASS: Record<StageStatus, string> = {
  pending: "bg-zinc-300 dark:bg-zinc-700",
  active: "animate-pulse bg-blue-500",
  done: "bg-emerald-500",
  error: "bg-red-500",
};

const STATUS_TEXT_CLASS: Record<StageStatus, string> = {
  pending: "text-zinc-400",
  active: "text-blue-600 dark:text-blue-400",
  done: "text-emerald-600 dark:text-emerald-400",
  error: "text-red-600 dark:text-red-400",
};

export function AgentTimeline({ state }: { state: PipelineState }) {
  return (
    <ol className="space-y-3">
      {STAGE_META.map(({ stage, role, agent }) => {
        const view = state.stages[stage];
        // Only show the running progress bar while the scenes stage is actually
        // working; once it is done (or errored) the bar collapses so a completed
        // run never looks stuck on a lingering "N / N".
        const showProgress =
          stage === "scenes" &&
          view.status === "active" &&
          view.total != null &&
          view.total > 0;
        return (
          <li
            key={stage}
            className="flex gap-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <span
              aria-hidden
              className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT_CLASS[view.status]}`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {role}
                </span>
                <span className={`text-xs font-medium ${STATUS_TEXT_CLASS[view.status]}`}>
                  {STATUS_LABEL[view.status]}
                </span>
              </div>
              <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                {agent}
              </p>
              {showProgress && (
                <div className="mt-2">
                  <div className="flex justify-between text-xs text-zinc-500">
                    <span>逐场景转换</span>
                    <span className="tabular-nums">
                      {view.done ?? 0} / {view.total}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-all"
                      style={{
                        width: `${Math.round(
                          ((view.done ?? 0) / (view.total || 1)) * 100,
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
