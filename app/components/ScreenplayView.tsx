/**
 * The screenplay result panel: a tabbed container over the card view and the
 * YAML source, plus the export button. Scenes stream in (the `scenes` prop
 * accumulates from `partial_result`); once `final_result` lands, the
 * authoritative `screenplay`/`yaml` drive the header, YAML tab, and export.
 *
 * PR8 threads through: `novel` (so each card's 溯源 popover can locate the
 * passage), `warnings` (per-scene needs-review reasons, matched by scene id),
 * and `canEdit`/`onApply` (YAML round-trip editing). When no scenes have yet
 * arrived it shows either a streaming skeleton (with n/total) or an empty hint.
 */

"use client";

import { useMemo, useState } from "react";
import type { Scene, Screenplay } from "../../lib/schema/screenplay";
import type { SceneWarning } from "../../lib/client/pipelineState";
import { SceneCard } from "./SceneCard";
import { YamlView } from "./YamlView";
import { ExportButton } from "./ExportButton";

type Tab = "cards" | "yaml";

export function ScreenplayView({
  scenes,
  screenplay,
  yaml,
  novel = "",
  warnings = [],
  warningsStale = false,
  canEdit = false,
  onApply,
  streaming = false,
  sceneProgress,
}: {
  scenes: Scene[];
  screenplay?: Screenplay;
  yaml?: string;
  novel?: string;
  warnings?: SceneWarning[];
  /** True when `warnings` come from the generated version but an edit is active. */
  warningsStale?: boolean;
  canEdit?: boolean;
  onApply?: (screenplay: Screenplay) => void;
  streaming?: boolean;
  sceneProgress?: { done?: number; total?: number };
}) {
  const [tab, setTab] = useState<Tab>("cards");
  const hasYaml = typeof yaml === "string" && yaml.length > 0;
  const active = tab === "yaml" && hasYaml ? "yaml" : "cards";

  const tabClass = (t: Tab) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active === t
        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
    }`;

  // Build a sceneId → message map once per warnings change instead of a linear
  // scan per scene card (O(scenes × warnings) → O(scenes)).
  const warningById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of warnings) if (w.sceneId) m.set(w.sceneId, w.message);
    return m;
  }, [warnings]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {screenplay && (
            <>
              <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
                {screenplay.title}
              </h2>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {screenplay.logline}
              </p>
            </>
          )}
        </div>
        {hasYaml && screenplay && (
          <ExportButton yaml={yaml} title={screenplay.title} />
        )}
      </header>

      <div className="flex gap-1">
        <button type="button" className={tabClass("cards")} onClick={() => setTab("cards")}>
          卡片
        </button>
        <button
          type="button"
          className={tabClass("yaml")}
          onClick={() => setTab("yaml")}
          disabled={!hasYaml}
        >
          YAML
        </button>
      </div>

      {warningsStale && warnings.length > 0 && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
          以下复核提示来自生成版本，编辑后可能已不适用。
        </p>
      )}

      {active === "yaml" && hasYaml ? (
        <YamlView yaml={yaml} canEdit={canEdit} onApply={onApply} />
      ) : (
        <div className="flex flex-col gap-3">
          {scenes.length === 0 ? (
            streaming ? (
              <StreamingSkeleton progress={sceneProgress} />
            ) : (
              <p className="text-sm text-zinc-400">尚无场景……</p>
            )
          ) : (
            scenes.map((scene) => (
              <SceneCard
                key={scene.id}
                scene={scene}
                novel={novel}
                reviewMessage={warningById.get(scene.id)}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

function StreamingSkeleton({
  progress,
}: {
  progress?: { done?: number; total?: number };
}) {
  const label =
    progress?.total != null
      ? `场景编剧工作中 ${progress.done ?? 0} / ${progress.total}`
      : "场景编剧工作中……";
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{label}</p>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/50"
        />
      ))}
    </div>
  );
}
