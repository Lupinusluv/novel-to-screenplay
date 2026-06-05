/**
 * Chunker (场记) — deterministic, no LLM.
 *
 * Splits a raw novel into chapters and, within each chapter, into *scene
 * candidates* using cheap structural heuristics. It does NOT understand
 * meaning; it only exploits the typographic structure of 章回体 / modern
 * Chinese fiction:
 *   - chapters by `第N章` / `第N回` headings,
 *   - scenes by explicit separators, large blank gaps, or paragraph-leading
 *     transition cue words (话说 / 却说 / 次日 …).
 *
 * Output is intentionally a *candidate* segmentation: the Story Bible curator
 * and Scene Converter (LLM stages) refine it later.
 */

/** A chapter heading like `第一回` / `第1章`, line-anchored. */
const CHAPTER_HEADING =
  /^[ \t　]*(第\s*[0-9〇零一二三四五六七八九十百千两]+\s*[章回])(?:[ \t　]+(.*?))?[ \t　]*$/;

export interface SceneCandidate {
  /** 0-based index within the chapter. */
  index: number;
  text: string;
}

export interface Chapter {
  /** 0-based index within the novel. */
  index: number;
  /** The heading without its title, e.g. `第一回`; empty if untitled. */
  marker: string;
  /** The heading's trailing title, e.g. `风雪夜`; empty if none. */
  title: string;
  /** Chapter text excluding the heading line. */
  body: string;
  sceneCandidates: SceneCandidate[];
}

export interface ChunkResult {
  chapters: Chapter[];
}

/** Normalize the `marker` capture: collapse inner spaces (`第 1 章` → `第1章`). */
function normalizeMarker(raw: string): string {
  return raw.replace(/\s+/g, "");
}

/** Split a raw novel into chapters (+ scene candidates per chapter). */
export function chunkNovel(raw: string): ChunkResult {
  const lines = raw.split(/\r?\n/);

  // Locate every chapter heading line.
  const headings: { line: number; marker: string; title: string }[] = [];
  lines.forEach((line, i) => {
    const m = line.match(CHAPTER_HEADING);
    if (m) {
      headings.push({
        line: i,
        marker: normalizeMarker(m[1]),
        title: (m[2] ?? "").trim(),
      });
    }
  });

  // No headings → the whole text is one untitled chapter.
  if (headings.length === 0) {
    const body = raw.trim();
    return {
      chapters: [
        { index: 0, marker: "", title: "", body, sceneCandidates: splitScenes(body) },
      ],
    };
  }

  // Slice bodies between headings; front-matter before the first heading is
  // discarded (it is typically a book title / publisher note).
  const chapters: Chapter[] = headings.map((h, idx) => {
    const start = h.line + 1;
    const end = idx + 1 < headings.length ? headings[idx + 1].line : lines.length;
    const body = lines.slice(start, end).join("\n").trim();
    return {
      index: idx,
      marker: h.marker,
      title: h.title,
      body,
      sceneCandidates: splitScenes(body),
    };
  });

  return { chapters };
}

/** A line that is only separator glyphs (`***`, `※※`, `───`) = a scene break. */
const SEPARATOR_LINE = /^[*※◇＊\-—─═＝·•]{2,}$/;

/**
 * Paragraph-leading transition cues. Curated to strong time/scene shifts so
 * that frequent mid-sentence words (此时/忽然…) do not over-split. A cue only
 * triggers a break at the start of the body or right after sentence-ending
 * punctuation / a newline — never mid-word.
 */
const CUES = [
  // shared across simplified/traditional
  "次日", "翌日", "隔日", "那日", "是夜",
  // simplified
  "数日后", "几日之后", "这一日", "这日", "当晚", "当夜",
  "话说", "却说", "且说", "再说", "单说", "另一边", "另一头",
  // traditional — real public-domain corpora (《红楼梦》…) are 繁體
  "數日後", "幾日之後", "這一日", "這日", "當晚", "當夜",
  "話說", "卻說", "且說", "再說", "單說", "另一邊", "另一頭",
];
// boundary (start | sentence-end | newline) + optional indentation + cue.
// Indentation matters: 章回体 corpora indent paragraphs with full-width spaces
// (`　　卻說…`), so the cue is rarely flush against the boundary.
const CUE_BREAK = new RegExp(
  `(^|[。！？!?…\\n])([ \\t　]*)(${CUES.join("|")})`,
  "g",
);

/** Split a single segment before each transition cue (keeping the cue). */
function splitOnCues(segment: string): string[] {
  const breaks: number[] = [];
  let m: RegExpExecArray | null;
  CUE_BREAK.lastIndex = 0;
  while ((m = CUE_BREAK.exec(segment)) !== null) {
    const cueStart = m.index + m[1].length + m[2].length;
    if (cueStart > 0) breaks.push(cueStart); // a cue at index 0 is not a break
    if (CUE_BREAK.lastIndex <= m.index) CUE_BREAK.lastIndex = m.index + 1;
  }
  if (breaks.length === 0) return [segment];
  const parts: string[] = [];
  let prev = 0;
  for (const i of breaks) {
    parts.push(segment.slice(prev, i));
    prev = i;
  }
  parts.push(segment.slice(prev));
  return parts;
}

/**
 * Split a chapter body into scene candidates using three deterministic
 * heuristics: explicit separator lines, large blank gaps (>=2 blank lines),
 * and paragraph-leading transition cues. No signal → the whole body is one
 * candidate. Candidates are trimmed and re-indexed from 0.
 *
 * Exported for direct unit testing; also used per-chapter by `chunkNovel`.
 */
export function splitScenes(body: string): SceneCandidate[] {
  if (!body.trim()) return [];

  // Pass 1 (line level): hard boundaries = separator lines or >=2 blank lines.
  const segments: string[] = [];
  let current: string[] = [];
  let blankRun = 0;
  const flush = () => {
    if (current.length) {
      segments.push(current.join("\n"));
      current = [];
    }
  };
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "") {
      blankRun++;
      continue;
    }
    if (blankRun >= 2) flush();
    blankRun = 0;
    if (SEPARATOR_LINE.test(t)) {
      flush(); // separator is a boundary and is itself discarded
      continue;
    }
    current.push(line);
  }
  flush();

  // Pass 2 (intra-segment): split dense prose on transition cues.
  return segments
    .flatMap(splitOnCues)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((text, index) => ({ index, text }));
}
