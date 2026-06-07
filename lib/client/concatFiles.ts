/**
 * Multi-file upload helper (PR10). When an author selects several `.txt` files
 * at once, we concatenate them into one novel — but the OS hands us files in
 * arbitrary order, and chapter files are named like `第2章.txt`, `第10章.txt`,
 * or, for classical works, `《红楼梦》第三十六回 …`, `…第三十八回 …`.
 *
 * A plain lexicographic sort puts `第10章` before `第2章`; a numeric-aware
 * collator fixes Arabic digits but still mis-orders Chinese numerals (三十六 /
 * 三十七 / 三十八 sort by raw codepoint, which is not their numeric order). So we
 * extract the chapter ordinal — Arabic OR Chinese — and sort by it first,
 * falling back to a numeric collator for ties or non-chaptered names.
 *
 * Pure + node-testable (no DOM): the component reads File objects to text and
 * hands us `{name, text}` pairs (E10 keeps client logic out of components).
 */

export interface NamedText {
  name: string;
  text: string;
}

// Numeric-aware, locale-stable comparison so Arabic numbers sort by value and
// non-chaptered names stay stable. `Intl.Collator` is the tried-and-true
// primitive for the Arabic-digit / general case.
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

const CN_DIGIT: Record<string, number> = {
  "〇": 0, "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
};
const CN_UNIT: Record<string, number> = { "十": 10, "百": 100, "千": 1000 };

/**
 * Parse a small ordinal written in Arabic ("36") or Chinese ("三十六", "十",
 * "一百二十") digits. Returns null if the string contains any character that is
 * neither. Covers the chapter-number range of real novels (1–9999); 万/亿 are
 * intentionally out of scope.
 */
export function parseOrdinal(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let total = 0;
  let num = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      num = CN_DIGIT[ch];
      seen = true;
    } else if (ch in CN_UNIT) {
      // A bare leading unit ("十" = 10) means an implicit 1.
      total += (num === 0 ? 1 : num) * CN_UNIT[ch];
      num = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? total + num : null;
}

// `第<ordinal><卷|章|回|节|部|篇>` — the chapter marker shared by modern and
// classical Chinese novels. Whitespace-tolerant.
const CHAPTER_RE = /第\s*([0-9〇零两一二三四五六七八九十百千]+)\s*[卷章回节部篇]/;

/** The chapter ordinal embedded in a filename, or null if none. */
export function chapterOrdinal(name: string): number | null {
  const m = name.match(CHAPTER_RE);
  return m ? parseOrdinal(m[1]) : null;
}

/**
 * Compare two filenames in natural order: by chapter ordinal first (Arabic or
 * Chinese), then by a numeric-aware collator. Chaptered names sort before
 * non-chaptered ones.
 */
export function naturalCompare(a: string, b: string): number {
  const ca = chapterOrdinal(a);
  const cb = chapterOrdinal(b);
  if (ca != null && cb != null) {
    if (ca !== cb) return ca - cb;
  } else if (ca != null) {
    return -1;
  } else if (cb != null) {
    return 1;
  }
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
