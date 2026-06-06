/**
 * Exports the screenplay YAML (the backend's authoritative `final_result.yaml`,
 * D2 — no client-side re-serialisation) as a downloadable `.yaml` file. The
 * filename is sanitised for Windows-illegal characters (E13).
 */

"use client";

import { screenplayFileName } from "../../lib/client/filename";

export function ExportButton({
  yaml,
  title,
}: {
  yaml: string;
  title?: string;
}) {
  function handleExport() {
    const blob = new Blob([yaml], { type: "text/yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = screenplayFileName(title);
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={handleExport}
      className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
    >
      导出 .yaml
    </button>
  );
}
