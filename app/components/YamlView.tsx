/**
 * YAML source view with round-trip editing (PR8). While the pipeline is still
 * streaming (`canEdit=false`) it stays a read-only `<pre>`. Once the run is done
 * it becomes an editor: edit the YAML, 「应用」 routes it through {@link applyEdit}
 * (yaml.parse + zod + id/scene invariants), and on success lifts the parsed
 * screenplay via `onApply` — which drives the card view, YAML and export alike.
 *
 * Editor discipline:
 *  - the textarea is a local draft (seeded from `yaml`); prop changes do NOT
 *    silently overwrite in-progress edits — 「重置」 re-syncs explicitly.
 *  - a bad edit shows an inline error and never calls `onApply` (the previous
 *    good state is preserved by the parent).
 *  - on success the draft is re-normalized to `toYAML(applied)` (E10) so the
 *    editor, cards and export all show one canonical text.
 *  - applying normalizes YAML — comments/anchors are not preserved (E15); the UI
 *    says so.
 */

"use client";

import { useState } from "react";
import type { Screenplay } from "../../lib/schema/screenplay";
import { toYAML } from "../../lib/schema/yaml";
import { applyEdit } from "../../lib/client/applyEdit";

export function YamlView({
  yaml,
  canEdit = false,
  onApply,
}: {
  yaml: string;
  canEdit?: boolean;
  onApply?: (screenplay: Screenplay) => void;
}) {
  const [draft, setDraft] = useState(yaml);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  if (!canEdit) {
    return (
      <pre className="overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-4 font-mono text-xs leading-6 text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
        {yaml}
      </pre>
    );
  }

  const handleApply = () => {
    const result = applyEdit(draft);
    if (!result.ok) {
      setError(result.error);
      setWarnings([]);
      return;
    }
    setError(null);
    setWarnings(
      result.refWarnings.map(
        (w) => `场景 ${w.scene_id} 的 ${w.where} 引用了未定义的 ${w.ref}`,
      ),
    );
    // E10: re-normalize the editor to the canonical serialization of what we
    // just applied, so editor / cards / export stay consistent.
    setDraft(toYAML(result.screenplay));
    onApply?.(result.screenplay);
  };

  const handleReset = () => {
    setDraft(yaml);
    setError(null);
    setWarnings([]);
  };

  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="h-96 w-full resize-y overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-4 font-mono text-xs leading-6 text-zinc-800 outline-none focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
      />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleApply}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          应用
        </button>
        <button
          type="button"
          onClick={handleReset}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          重置
        </button>
        <span className="text-xs text-zinc-400">
          应用会规范化 YAML（注释/锚点不保留）
        </span>
      </div>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          校验错误：{error}
        </p>
      )}

      {warnings.length > 0 && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <p className="font-medium">引用警告（已应用，建议核对）：</p>
          <ul className="ml-4 list-disc">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
