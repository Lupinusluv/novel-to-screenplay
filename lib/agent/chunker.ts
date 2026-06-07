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

/**
 * A chapter heading, line-anchored. Robust to the dirty real-world inputs that
 * dogfooding surfaced (PR9). Built from parts so each rule is reviewable:
 *
 *   ^ [ws] PREFIX? [ws] (MARKER) [sep] (TITLE) [ws] $
 *
 * - PREFIX  — optional 《书名》/【栏目】 wrapper (`《红楼梦》第三回…` was the bug
 *             that collapsed the whole novel to 1 chapter). Length-bounded,
 *             no nesting, no newline.
 * - MARKER  — Chinese `第N卷/章/回/节/部/篇`, the combo `第N卷·第N章`
 *             (both levels kept), or English `Chapter N` / `Ch. N`. N is a
 *             Chinese or Arabic numeral. Bare numbers and roman numerals are
 *             intentionally NOT accepted (collide with years/phones/lists).
 * - TITLE   — optional, restricted to characters that don't carry sentence
 *             punctuation (。！？，、；：… and ASCII equivalents). This is the
 *             PR4 guardrail: a prose continuation like
 *             `第四回中既将…，此回暂不写。` always carries punctuation, a real
 *             title never does, so the in-text reference is rejected. (We do
 *             NOT add a chapter-number monotonicity check — it would reject
 *             legitimate anthologies starting mid-sequence, per-volume resets
 *             `第二卷 第1章`, side stories, and out-of-order pastes.)
 */
const HEADING_NUM = "[0-9〇零一二三四五六七八九十百千两]+";
const HEADING_VOL = `第\\s*${HEADING_NUM}\\s*卷`;
const HEADING_LEVEL = `第\\s*${HEADING_NUM}\\s*[章回节部篇]`;
// Chinese: 卷 alone, 卷·章 combo, or a bare level marker.
const HEADING_CN = `(?:${HEADING_VOL}(?:[ \\t　·．.]*${HEADING_LEVEL})?|${HEADING_LEVEL})`;
// English translations: `Chapter 12`, `Ch. 3`, `CHAPTER 1` (case-insensitive).
const HEADING_EN = `(?:chapter|ch\\.?)\\s*[0-9]+`;
const HEADING_PREFIX = `(?:《[^》\\n]{1,30}》|【[^】\\n]{1,30}】)?`;
const HEADING_TITLE = `([^。！？，、；：…．,.!?;:]*?)`;
const CHAPTER_HEADING = new RegExp(
  `^[ \\t　]*${HEADING_PREFIX}[ \\t　]*(${HEADING_CN}|${HEADING_EN})[ \\t　：:.]*${HEADING_TITLE}[ \\t　]*$`,
  "i",
);

export interface SceneCandidate {
  /** 0-based index within the chapter (post-merge, post-reindex). */
  index: number;
  text: string;
  /**
   * Set when this candidate is a near-duplicate (>= `NEAR_DUP_SIM` trigram
   * Jaccard, both >= `NEAR_DUP_MIN_LEN`) of an EARLIER, *non-adjacent* candidate
   * — value is that earlier candidate's final `index` (same chapter-local,
   * 0-based coordinate as `index`). Adjacent near-dups are merged away instead
   * of flagged. Surfaced downstream as a `needs_review` + `near_duplicate` note;
   * never auto-deleted (a recurring passage may be legitimate). PR9 symptom ②.
   */
  nearDuplicateOf?: number;
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

/** Normalize the `marker` capture: drop inner whitespace and combo separators
 *  (`第 1 章` → `第1章`, `第一卷·第一章` → `第一卷第一章`, `Ch. 2` → `Ch2`). */
function normalizeMarker(raw: string): string {
  return raw.replace(/[\s·．.]+/g, "");
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

/**
 * Soft target length (in UTF-16 code units, matching sceneConverter's cap; CJK
 * is overwhelmingly BMP so code units ≈ characters). Any candidate longer than
 * this is split down by `splitToTarget` so the downstream per-scene cap
 * (`SCENE_BODY_CAP=4000`) degrades to a never-triggered backstop — no more
 * honest-truncation + needs_review on signal-less modern prose (PR9 symptom ③).
 */
export const SCENE_SOFT_TARGET = 1500;

/** Keep-the-delimiter splitters (lossless: the pieces concatenate back to the
 *  input). Newline first (paragraph-ish, since pass 1 already dropped blank
 *  lines), then after sentence-ending punctuation. */
const SPLIT_AT_NEWLINE = /(?<=\n)/;
const SPLIT_AFTER_SENTENCE = /(?<=[。！？…；!?;])/;

/** Slice a punctuation-free blob into <=target chunks (backstop of last resort). */
function hardSlice(text: string, target: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += target) out.push(text.slice(i, i + target));
  return out;
}

/**
 * Length fallback (PR9 §2). Returns pieces that each satisfy
 * `length <= SCENE_SOFT_TARGET` and concatenate back to the input (lossless).
 * Refines only over-target pieces, finest granularity last: paragraph → sentence
 * → hard slice. Then greedily packs adjacent pieces back up toward the target so
 * we don't over-fragment ("emit before overflow").
 */
function splitToTarget(text: string): string[] {
  if (text.length <= SCENE_SOFT_TARGET) return [text];
  let pieces = [text];
  const refine = (splitter: RegExp | ((s: string) => string[])) =>
    pieces.flatMap((p) =>
      p.length <= SCENE_SOFT_TARGET
        ? [p]
        : typeof splitter === "function"
          ? splitter(p)
          : p.split(splitter),
    );
  pieces = refine(SPLIT_AT_NEWLINE);
  pieces = refine(SPLIT_AFTER_SENTENCE);
  pieces = refine((p) => hardSlice(p, SCENE_SOFT_TARGET));

  // Greedy repack: concatenate adjacent atoms until the next would overflow.
  const boxes: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur !== "" && cur.length + p.length > SCENE_SOFT_TARGET) {
      boxes.push(cur);
      cur = p;
    } else {
      cur += p;
    }
  }
  if (cur !== "") boxes.push(cur);
  return boxes;
}

// ---------------------------------------------------------------------------
// Near-duplicate detection (PR9 §3). Catches multi-version pastes that repeat a
// passage. Metric: character 3-gram Jaccard over a punctuation/whitespace-
// stripped form. A length gate keeps short formulaic repeats (dialogue refrains,
// 对仗, choruses) from being mistaken for duplicate scenes.
// ---------------------------------------------------------------------------

/** Trigram Jaccard threshold for "near-duplicate". */
export const NEAR_DUP_SIM = 0.9;
/** Min normalized length to even be considered (protects short repeats). */
const NEAR_DUP_MIN_LEN = 100;
/**
 * Min distinct-trigram count to be dup-eligible. Guards against low-entropy
 * text (a repeated char/phrase) whose tiny trigram set makes Jaccard read ~1.0
 * — e.g. the periodic pieces a length-fallback hard-slice produces must NOT be
 * merged back together. Real prose passages have hundreds of distinct trigrams.
 */
const NEAR_DUP_MIN_TRIGRAMS = 40;

function normalizeForDup(text: string): string {
  return text.replace(
    /[\s。！？，、；：…．,.!?;:""''“”‘’「」『』（）()【】《》—–\-]/g,
    "",
  );
}

function trigrams(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3));
  return set;
}

/** Trigram Jaccard, gated on both texts clearing `NEAR_DUP_MIN_LEN`. */
function similarity(a: string, b: string): number {
  const na = normalizeForDup(a);
  const nb = normalizeForDup(b);
  if (na.length < NEAR_DUP_MIN_LEN || nb.length < NEAR_DUP_MIN_LEN) return 0;
  const ta = trigrams(na);
  const tb = trigrams(nb);
  if (ta.size < NEAR_DUP_MIN_TRIGRAMS || tb.size < NEAR_DUP_MIN_TRIGRAMS) return 0;
  let inter = 0;
  for (const x of ta) if (tb.has(x)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Merge adjacent near-duplicates (keep the longer/more-complete one) and flag
 * non-adjacent ones with `nearDuplicateOf` (the earliest matching index).
 * Order-faithful: never reorders, only drops adjacent repeats.
 */
function detectNearDuplicates(
  texts: string[],
): { text: string; nearDuplicateOf?: number }[] {
  const merged: string[] = [];
  for (const t of texts) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && similarity(prev, t) >= NEAR_DUP_SIM) {
      merged[merged.length - 1] = t.length > prev.length ? t : prev; // keep longer
    } else {
      merged.push(t);
    }
  }
  return merged.map((text, i) => {
    for (let j = 0; j < i - 1; j++) {
      // j < i-1 → strictly non-adjacent (adjacent dups were merged above).
      if (similarity(merged[j], text) >= NEAR_DUP_SIM) {
        return { text, nearDuplicateOf: j };
      }
    }
    return { text };
  });
}

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
  // Pass 3 (length fallback): break any still-over-target candidate down so the
  // downstream per-scene cap never has to truncate.
  const texts = segments
    .flatMap(splitOnCues)
    .flatMap(splitToTarget)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  // Pass 4 (near-dup): merge adjacent repeats, flag non-adjacent ones.
  return detectNearDuplicates(texts).map((c, index) => ({ index, ...c }));
}
