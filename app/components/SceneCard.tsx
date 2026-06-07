/**
 * A single screenplay scene. Renders the slug-line heading, an ordered flow of
 * action/dialogue/transition elements, the synopsis, the source chapter
 * (provenance, the anti-hallucination anchor), and a `needs_review` badge when
 * the pipeline flagged the scene.
 *
 * PR8 adds traceability: a 「溯源」 button opens {@link SourceModal}, pinning the
 * scene back to the source novel; and the needs-review badge expands to show the
 * Critic/Orchestrator's reason (`reviewMessage`). It is now a client component
 * (local open/expand state). When the scene identity changes underneath an open
 * modal (e.g. a YAML edit replaced/removed it), the modal is closed (E19).
 */

"use client";

import { useState } from "react";
import type {
  Scene,
  Element,
  IntExt,
  TimeOfDay,
} from "../../lib/schema/screenplay";
import { SourceModal } from "./SourceModal";

/** A read-only id→name lookup; missing ids fall back to the raw id. */
type NameMap = Map<string, string>;

const INT_EXT_LABEL: Record<IntExt, string> = { INT: "内景", EXT: "外景" };
const TIME_LABEL: Record<TimeOfDay, string> = {
  DAY: "日",
  NIGHT: "夜",
  DAWN: "拂晓",
  DUSK: "黄昏",
  CONTINUOUS: "连续",
  LATER: "稍后",
};

const nameOf = (map: NameMap | undefined, id: string) => map?.get(id) ?? id;

function SlugLine({
  scene,
  locations,
}: {
  scene: Scene;
  locations?: NameMap;
}) {
  const { int_ext, location_id, time_of_day } = scene.heading;
  return (
    <p className="text-xs font-semibold tracking-wide text-zinc-500 dark:text-zinc-400">
      {INT_EXT_LABEL[int_ext]} · {nameOf(locations, location_id)} ·{" "}
      {TIME_LABEL[time_of_day]}
    </p>
  );
}

function ElementRow({
  element,
  characters,
}: {
  element: Element;
  characters?: NameMap;
}) {
  if (element.type === "action") {
    return (
      <p className="text-sm leading-6 text-zinc-700 dark:text-zinc-300">
        {element.text}
      </p>
    );
  }
  if (element.type === "dialogue") {
    return (
      <div className="pl-4">
        <p className="text-xs font-semibold tracking-wide text-zinc-600 dark:text-zinc-300">
          {nameOf(characters, element.character_id)}
        </p>
        {element.parenthetical && (
          <p className="text-xs italic text-zinc-400">
            ({element.parenthetical})
          </p>
        )}
        <p className="text-sm leading-6 text-zinc-800 dark:text-zinc-200">
          {element.line}
        </p>
      </div>
    );
  }
  return (
    <p className="text-right font-mono text-xs uppercase tracking-wide text-zinc-400">
      {element.text}
    </p>
  );
}

export function SceneCard({
  scene,
  novel = "",
  reviewMessage,
  characters,
  locations,
}: {
  scene: Scene;
  novel?: string;
  /** The needs-review reason (a per-scene warning message), shown on expand. */
  reviewMessage?: string;
  /** id→name lookups so the card shows 荣国府/林黛玉, not the raw loc_/char_ ids. */
  characters?: NameMap;
  locations?: NameMap;
}) {
  const [showReason, setShowReason] = useState(false);

  // E19: key the modal's open-state to the scene identity instead of a boolean +
  // effect. When a YAML edit replaces/removes this scene the key changes, so the
  // popover auto-closes during render — no stale popover, no setState-in-effect.
  const sceneKey = `${scene.id}::${scene.source.excerpt}`;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const showSource = openKey === sceneKey;

  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div>
          <SlugLine scene={scene} locations={locations} />
          <p className="mt-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {scene.synopsis}
          </p>
        </div>
        {scene.needs_review && (
          <button
            type="button"
            onClick={() => setShowReason((v) => !v)}
            aria-expanded={showReason}
            className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60"
          >
            需复核
          </button>
        )}
      </header>

      {scene.needs_review && showReason && (
        <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          {reviewMessage ?? "该场景被标记为需要人工复核（生成时引用或内容不完整）。"}
        </p>
      )}

      <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        {scene.elements.map((element, i) => (
          <ElementRow key={i} element={element} characters={characters} />
        ))}
      </div>

      <footer className="mt-3 flex items-center justify-between text-xs text-zinc-400">
        <span>第 {scene.source.chapter} 章</span>
        <button
          type="button"
          onClick={() => setOpenKey(sceneKey)}
          className="rounded-md px-2 py-0.5 font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          溯源
        </button>
      </footer>

      {showSource && (
        <SourceModal
          scene={scene}
          novel={novel}
          onClose={() => setOpenKey(null)}
        />
      )}
    </article>
  );
}
