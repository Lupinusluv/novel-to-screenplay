/**
 * The screenplay result panel: a tabbed container over the card view and the
 * read-only YAML source, plus the export button. Scenes stream in (the `scenes`
 * prop accumulates from `partial_result`); once `final_result` lands, the
 * authoritative `screenplay`/`yaml` drive the header, YAML tab, and export.
 */

"use client";

import { useState } from "react";
import type { Scene, Screenplay } from "../../lib/schema/screenplay";
import { SceneCard } from "./SceneCard";
import { YamlView } from "./YamlView";
import { ExportButton } from "./ExportButton";

type Tab = "cards" | "yaml";

export function ScreenplayView({
  scenes,
  screenplay,
  yaml,
}: {
  scenes: Scene[];
  screenplay?: Screenplay;
  yaml?: string;
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

      {active === "yaml" && hasYaml ? (
        <YamlView yaml={yaml} />
      ) : (
        <div className="flex flex-col gap-3">
          {scenes.length === 0 ? (
            <p className="text-sm text-zinc-400">尚无场景……</p>
          ) : (
            scenes.map((scene) => <SceneCard key={scene.id} scene={scene} />)
          )}
        </div>
      )}
    </section>
  );
}
