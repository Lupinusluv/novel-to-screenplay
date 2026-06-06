/**
 * Build a safe download filename for the exported screenplay (E13). CJK titles
 * are preserved, but Windows-illegal characters (`/ \ : * ? " < > |`) are
 * replaced and surrounding whitespace trimmed, else the download name misbehaves
 * on some browsers/OSes. Falls back to `screenplay.yaml` when nothing usable
 * remains.
 */

const ILLEGAL = /[/\\:*?"<>|]/g;

export function screenplayFileName(title: string | undefined): string {
  const base = (title ?? "").replace(ILLEGAL, "_").trim();
  // If sanitising left only underscores/whitespace, treat as empty.
  const usable = base.replace(/[_\s]/g, "") === "" ? "" : base;
  return `${usable || "screenplay"}.yaml`;
}
