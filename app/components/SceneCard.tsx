/**
 * A single screenplay scene, read-only (D2). Renders the slug-line heading, an
 * ordered flow of action/dialogue/transition elements, the synopsis, the source
 * chapter (provenance, the anti-hallucination anchor), and a `needs_review`
 * badge when the pipeline flagged the scene. Deep-link back to source text is
 * deferred to PR8.
 *
 * No hooks/interactivity → renders fine as a server component, but it is only
 * ever mounted inside the client `ScreenplayView`, so it joins the client bundle.
 */

import type { Scene, Element } from "../../lib/schema/screenplay";

function SlugLine({ scene }: { scene: Scene }) {
  const { int_ext, location_id, time_of_day } = scene.heading;
  return (
    <p className="font-mono text-xs font-semibold tracking-wide text-zinc-500 dark:text-zinc-400">
      {int_ext} · {location_id} · {time_of_day}
    </p>
  );
}

function ElementRow({ element }: { element: Element }) {
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
        <p className="font-mono text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {element.character_id}
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

export function SceneCard({ scene }: { scene: Scene }) {
  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div>
          <SlugLine scene={scene} />
          <p className="mt-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {scene.synopsis}
          </p>
        </div>
        {scene.needs_review && (
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
            需复核
          </span>
        )}
      </header>

      <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        {scene.elements.map((element, i) => (
          <ElementRow key={i} element={element} />
        ))}
      </div>

      <footer className="mt-3 text-xs text-zinc-400">第 {scene.source.chapter} 章</footer>
    </article>
  );
}
