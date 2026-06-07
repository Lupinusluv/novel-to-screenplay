/**
 * Locate a scene's `source.excerpt` back inside the original novel text and
 * return its UTF-16 offset range, so the traceability popover can `<mark>` the
 * passage. Pure + DOM-free: lives in `lib/client` and unit-tests under node.
 *
 * The excerpt is a *real* head-slice of the source (see `sceneConverter.ts`),
 * never an LLM paraphrase — so it IS locatable. But the chunker drops single
 * blank lines when assembling chunks, so a whole-excerpt `indexOf` can miss
 * across a dropped line. Hence the three-level fallback:
 *   1. exact (sans trailing ellipsis),
 *   2. first-paragraph anchor (always a contiguous substring of the source),
 *   3. whitespace-normalized search with an offset map back to the original.
 *
 * Scope (known limitation E1/E6): we search the WHOLE novel and take the first
 * hit (deterministic). We do not scope by chapter — the frontend has no chapter
 * offsets and replicating the chunker would violate the lib/client boundary and
 * drift. A ≤120-char narrative head is distinctive enough that collisions are
 * rare; the popover always shows the excerpt verbatim regardless, so a mislocated
 * highlight degrades position only, never the data shown.
 *
 * Offsets are UTF-16 code-unit indices (what String.slice / React text nodes
 * use), not code points — so a surrogate pair (emoji) counts as 2.
 *
 * E10 discipline: no imports from lib/agent. This module has no imports at all.
 */

/** A located passage: half-open UTF-16 offset range `[start, end)` in the novel. */
export interface ExcerptMatch {
  start: number;
  end: number;
}

const ELLIPSIS = "…";

/** Whitespace collapsed by {@link normalizeWithMap}: ASCII ws + tab + CR/LF +
 *  full-width space (U+3000). Runs of these fold to a single ASCII space. */
function isCollapsibleWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" ||
    ch === "\f" || ch === "\v" || ch === "　";
}

/**
 * Collapse every run of whitespace to a single ASCII space and return the
 * normalized string together with an offset map: `map[i]` is the UTF-16 index
 * in the original `s` of the source for normalized char `i`. For a collapsed
 * whitespace run, that source index is the run's first whitespace char.
 */
export function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (isCollapsibleWhitespace(ch)) {
      const runStart = i;
      while (i < s.length && isCollapsibleWhitespace(s[i])) i++;
      norm += " ";
      map.push(runStart);
    } else {
      norm += ch;
      map.push(i);
      i++;
    }
  }
  return { norm, map };
}

/** Drop a single trailing ellipsis (the excerpt's truncation marker). */
function stripEllipsis(excerpt: string): string {
  return excerpt.endsWith(ELLIPSIS) ? excerpt.slice(0, -ELLIPSIS.length) : excerpt;
}

export function locateExcerpt(novel: string, excerpt: string): ExcerptMatch | null {
  if (!novel || !excerpt) return null;

  const trimmed = stripEllipsis(excerpt);
  if (!trimmed) return null;

  // Step 1 — exact.
  const exact = novel.indexOf(trimmed);
  if (exact !== -1) return { start: exact, end: exact + trimmed.length };

  // Step 2 — first-paragraph anchor (contiguous in source even across a dropped
  // blank line). Highlight only the anchor; do NOT extend to the full excerpt
  // length (that would bleed into unrelated following text).
  const nl = trimmed.indexOf("\n");
  if (nl !== -1) {
    const anchor = trimmed.slice(0, nl).trim();
    if (anchor) {
      const at = novel.indexOf(anchor);
      if (at !== -1) return { start: at, end: at + anchor.length };
    }
  }

  // Step 3 — whitespace-normalized search, mapped back to original offsets.
  const needle = normalizeWithMap(trimmed).norm.trim();
  if (needle) {
    const { norm, map } = normalizeWithMap(novel);
    const ns = norm.indexOf(needle);
    if (ns !== -1) {
      const ne = ns + needle.length;
      const start = map[ns];
      const end = ne < map.length ? map[ne] : novel.length;
      return { start, end };
    }
  }

  return null;
}
