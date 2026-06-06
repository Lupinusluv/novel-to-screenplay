/**
 * Read-only YAML source view (D2). Renders the backend's authoritative YAML in a
 * monospaced `<pre>` — no editing/round-trip in PR7.
 */

export function YamlView({ yaml }: { yaml: string }) {
  return (
    <pre className="overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-4 font-mono text-xs leading-6 text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
      {yaml}
    </pre>
  );
}
