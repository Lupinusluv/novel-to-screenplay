/**
 * Multi-file upload helper (PR10). When an author selects several `.txt` files
 * at once, we concatenate them into one novel — but the OS hands us files in
 * arbitrary order, and chapter files are usually named like `第2章.txt`,
 * `第10章.txt`. A plain lexicographic sort puts `第10章` before `第2章`; readers
 * expect `2` before `10`. So we sort with a numeric-aware collator before
 * joining.
 *
 * Pure + node-testable (no DOM): the component reads File objects to text and
 * hands us `{name, text}` pairs (E10 keeps client logic out of components).
 */

export interface NamedText {
  name: string;
  text: string;
}

// Numeric-aware, locale-stable comparison so embedded numbers sort by value:
// 第2章 < 第10章, part1 < part2 < part10. `Intl.Collator` is the tried-and-true
// primitive for this — no hand-rolled number parsing.
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Compare two filenames in natural (numeric-aware) order. */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Return the files sorted by filename in natural order (does not mutate input). */
export function orderFilesNaturally(files: NamedText[]): NamedText[] {
  return [...files].sort((a, b) => naturalCompare(a.name, b.name));
}

/**
 * Concatenate uploaded files into one novel: natural-sorted by filename, joined
 * by a blank line so chapter boundaries stay visible to the chunker and to a
 * human reading the textarea. Trailing/leading whitespace on each file is
 * trimmed so the joiner is exactly one blank line, not a ragged gap.
 */
export function concatNovelFiles(files: NamedText[]): string {
  return orderFilesNaturally(files)
    .map((f) => f.text.trim())
    .filter((t) => t.length > 0)
    .join("\n\n");
}
