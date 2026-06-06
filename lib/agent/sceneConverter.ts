/**
 * Scene Converter (场景编剧) — the pipeline's second LLM agent.
 *
 * Turns ONE scene candidate (Chunker's `SceneCandidate` text + 1-based chapter)
 * into a structured `Scene` (PR2 schema), forced to reference the StoryBible's
 * existing stable ids (`heading.location_id` / `dialogue.character_id`).
 *
 * Division of labour (decision D1/D2): the LLM only ever speaks in NAMES; code
 * is the sole authority for id resolution, source provenance, and scene id. The
 * two failure classes are kept apart (D6): structural garbage (bad enum, missing
 * required field, illegal JSON) THROWS for PR6 to retry; a reference that does
 * not resolve to the bible is handled best-effort (demote / placeholder) and
 * reported as a located `ConversionIssue`, so the scene is always schema-valid
 * and referentially clean.
 *
 * Design rationale & authoritative review deltas:
 *   docs/superpowers/specs/2026-06-06-pr5-scene-converter-design.md
 *   (§11 is the authoritative increment: E1–E6 + I1–I11 + T1–T7).
 */

import { z } from "zod";
import {
  IntExt,
  TimeOfDay,
  checkReferentialIntegrity,
  type Character,
  type Location,
  type Element,
  type Scene,
  type SceneHeading,
  type Screenplay,
  type ReferenceIssue,
} from "../schema/screenplay";
import type { StoryBible } from "./storyBible";
import type { SceneCandidate } from "./chunker";
import type { ChatMessage, LLMClient } from "../llm/client";

// ---------------------------------------------------------------------------
// Conversion issues (I1). A located report of a reference that did not resolve
// cleanly to the bible. `kind` covers unresolved character/location, an
// ambiguous match (E2), and a body truncation (E6). The ids in `candidates`
// are machine-facing (fed to PR6 / audit) — this does not contradict "the
// prompt never shows the LLM an id" (#6).
// ---------------------------------------------------------------------------

export type ConversionIssueKind =
  | "unresolved_character"
  | "unresolved_location"
  | "ambiguous_reference"
  | "truncated_scene";

export interface ConversionIssue {
  kind: ConversionIssueKind;
  /** The LLM-supplied surface form that failed / was ambiguous. */
  surface: string;
  /** Where it occurred, e.g. `elements[2].speaker` / `heading.location`. */
  where: string;
  /** The actual fallback taken, e.g. `demoted to action` / `placeholder fallback`. */
  resolution: string;
  /** For an ambiguous match: the candidate ids it could have resolved to. */
  candidates?: string[];
}

// ---------------------------------------------------------------------------
// Middle-layer zod (RawSceneSchema, I1 style). Validates the SHAPE of the LLM
// output, reusing the schema's IntExt / TimeOfDay enums. Refs are NAMES, not
// ids: `heading.location` and `dialogue.speaker` are surface strings the code
// resolves later. Bad enum / missing field / unknown key → throw (D6 garbage).
// `elements` has no `.min(1)` (I11): an empty list is a business signal handled
// downstream (needs_review), not structural garbage.
// ---------------------------------------------------------------------------

const RawHeadingSchema = z.strictObject({
  int_ext: IntExt,
  /** A location NAME (resolved to a location_id by code). */
  location: z.string().min(1),
  time_of_day: TimeOfDay,
});

const RawActionElement = z.strictObject({
  type: z.literal("action"),
  text: z.string().min(1),
});

const RawDialogueElement = z.strictObject({
  type: z.literal("dialogue"),
  /** A character NAME (resolved to a character_id by code). */
  speaker: z.string().min(1),
  parenthetical: z.string().optional(),
  line: z.string().min(1),
});

const RawTransitionElement = z.strictObject({
  type: z.literal("transition"),
  text: z.string().min(1),
});

const RawElementSchema = z.discriminatedUnion("type", [
  RawActionElement,
  RawDialogueElement,
  RawTransitionElement,
]);

export const RawSceneSchema = z.strictObject({
  heading: RawHeadingSchema,
  synopsis: z.string().min(1),
  elements: z.array(RawElementSchema),
});

export type RawScene = z.infer<typeof RawSceneSchema>;
export type RawElement = z.infer<typeof RawElementSchema>;

// ---------------------------------------------------------------------------
// Coerce (E3, in the spirit of PR4 `coerceMapEntities`). Real models add
// trivially-fixable shape noise — a dialogue carrying a stray `text`, an action
// carrying a stray `speaker`. Dropping the surplus is cheaper than burning a
// PR6 retry, so we strip keys not belonging to each element's declared `type`
// (and unknown top-level keys), counting drops so a noisy model stays visible.
// Anything strict validation still rejects (bad enum, missing required field)
// THROWS — that is true garbage, not droppable noise.
// ---------------------------------------------------------------------------

const TOP_KEYS = ["heading", "synopsis", "elements"];
const HEADING_KEYS = ["int_ext", "location", "time_of_day"];
const ELEMENT_KEYS: Record<string, string[]> = {
  action: ["type", "text"],
  dialogue: ["type", "speaker", "parenthetical", "line"],
  transition: ["type", "text"],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function coerceRawScene(raw: unknown): {
  scene: RawScene;
  dropped: number;
} {
  const obj = isPlainObject(raw) ? raw : {};
  let dropped = 0;

  /** Keep only whitelisted keys; count the rest as dropped noise. */
  const pick = (o: Record<string, unknown>, keys: string[]) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) {
      if (keys.includes(k)) out[k] = o[k];
      else dropped++;
    }
    return out;
  };

  // Unknown top-level keys are droppable noise (count, don't throw).
  for (const k of Object.keys(obj)) if (!TOP_KEYS.includes(k)) dropped++;

  const heading = isPlainObject(obj.heading)
    ? pick(obj.heading, HEADING_KEYS)
    : obj.heading;

  const elements = Array.isArray(obj.elements)
    ? obj.elements.map((el) => {
        if (isPlainObject(el) && typeof el.type === "string" && ELEMENT_KEYS[el.type]) {
          return pick(el, ELEMENT_KEYS[el.type]);
        }
        return el; // unknown/garbled type → let the strict schema reject it
      })
    : obj.elements;

  // Only forward known top-level keys; a missing required one still throws.
  const candidate: Record<string, unknown> = {};
  if (heading !== undefined) candidate.heading = heading;
  if (obj.synopsis !== undefined) candidate.synopsis = obj.synopsis;
  if (elements !== undefined) candidate.elements = elements;

  const scene = RawSceneSchema.parse(candidate);
  return { scene, dropped };
}

// ---------------------------------------------------------------------------
// Surface normalization (I3). Deterministic, conservative: trim + lowercase +
// full-width→half-width + drop Chinese quotes + collapse whitespace + strip a
// trailing speech verb (道/说/問/笑道…) and trailing punctuation. We do NOT do
// aggressive semantic merging (凤姐儿↔凤姐) — that is carried by PR4 aliases. A
// surface that still does not hit after normalization counts as unresolved
// (the safety net), never a silent guess.
// ---------------------------------------------------------------------------

/** Full-width ASCII (FF01–FF5E) → ASCII; ideographic space → normal space. */
function toHalfWidth(s: string): string {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

const QUOTES = /[「」『』“”‘’"']/g;
const TRAIL_PUNCT = /[：:，,。.！!？?…、；;]+$/;
// Multi-char verbs first so e.g. 笑道 strips whole, not just 道.
const SPEECH_VERB_SUFFIX =
  /(?:笑道|笑說|笑说|答道|回道|问道|問道|说道|說道|道|曰|说|說|问|問)$/;

export function normalizeSurface(raw: string): string {
  let s = toHalfWidth(String(raw)).toLowerCase();
  s = s.replace(QUOTES, "").replace(/\s+/g, "");
  s = s.replace(TRAIL_PUNCT, "");
  s = s.replace(SPEECH_VERB_SUFFIX, "");
  s = s.replace(TRAIL_PUNCT, "");
  return s;
}

// ---------------------------------------------------------------------------
// Resolver (I2). Maps a normalized surface to every entity it could denote,
// each match carrying the metadata E2's ladder needs: which id, whether it was
// matched by canonical name or an alias, and whether that id is scoped to the
// chapter being converted. Built over the FULL bible (D4) so cross-chapter
// aliases still resolve; scoping is a *focus* signal, not a hard constraint.
// ---------------------------------------------------------------------------

export interface ResolverMatch {
  id: string;
  matchedBy: "name" | "alias";
  /** True when this id is in the chapter's scoped cast (E2 tier 2). */
  scoped: boolean;
}

export type Resolver = Map<string, ResolverMatch[]>;

export interface ResolvableEntity {
  id: string;
  name: string;
  aliases?: string[];
}

export function buildResolver(
  entities: ResolvableEntity[],
  scopedIds: Set<string> = new Set(),
): Resolver {
  const map: Resolver = new Map();
  const add = (surface: string, id: string, matchedBy: "name" | "alias") => {
    const key = normalizeSurface(surface);
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.some((m) => m.id === id && m.matchedBy === matchedBy)) {
      list.push({ id, matchedBy, scoped: scopedIds.has(id) });
      map.set(key, list);
    }
  };
  for (const e of entities) {
    add(e.name, e.id, "name");
    for (const a of e.aliases ?? []) add(a, e.id, "alias");
  }
  return map;
}

export interface ResolveResult {
  /** Resolved entity id, or null when the surface hits nothing in the bible. */
  id: string | null;
  matchedBy?: "name" | "alias";
  /** True when 2+ distinct entities matched; a tier winner was still chosen. */
  ambiguous?: boolean;
  /** When ambiguous: every candidate id considered (sorted), for the issue. */
  candidates?: string[];
}

/** Locale-independent code-point order — reproducible across runs. */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Resolve a surface name to an entity id via the E2 three-tier ladder:
 *   1. a canonical-name match beats an alias-only match,
 *   2. a scoped candidate beats a cross-chapter one,
 *   3. a remaining tie falls to the smallest code-point id.
 * When 2+ distinct entities matched, the winner is still returned but the
 * result is flagged `ambiguous` with the full candidate list (E2 + I1).
 */
export function resolveSurface(resolver: Resolver, surface: string): ResolveResult {
  const matches = resolver.get(normalizeSurface(surface));
  if (!matches || matches.length === 0) return { id: null };

  // Collapse to one record per entity id, keeping the strongest matchedBy.
  const byEntity = new Map<string, ResolverMatch>();
  for (const m of matches) {
    const prev = byEntity.get(m.id);
    if (!prev || (prev.matchedBy === "alias" && m.matchedBy === "name")) {
      byEntity.set(m.id, m);
    }
  }
  const cands = [...byEntity.values()];
  if (cands.length === 1) {
    return { id: cands[0].id, matchedBy: cands[0].matchedBy };
  }

  // Ladder: each tier narrows the pool only when it actually discriminates.
  let pool = cands;
  if (pool.some((m) => m.matchedBy === "name")) {
    pool = pool.filter((m) => m.matchedBy === "name");
  }
  if (pool.some((m) => m.scoped)) {
    pool = pool.filter((m) => m.scoped);
  }
  pool = [...pool].sort((a, b) => byId(a.id, b.id));
  const winner = pool[0];

  return {
    id: winner.id,
    matchedBy: winner.matchedBy,
    ambiguous: true,
    candidates: cands.map((c) => c.id).sort(byId),
  };
}

// ---------------------------------------------------------------------------
// Scope cast (D4) + dominant location (E1). Scoping is deterministic and uses
// the provenance side-table to focus the prompt on this chapter's entities
// (token economy); the resolver still spans the full bible so cross-chapter
// aliases resolve. Per-table fallback to the full bible keeps a chapter the
// Curator under-tagged from going blind.
// ---------------------------------------------------------------------------

export interface ScopedCast {
  characters: Character[];
  locations: Location[];
}

function scopedByProvenance<T extends { id: string }>(
  entities: T[],
  provenance: Record<string, number[]>,
  chapter: number,
): T[] {
  return entities.filter((e) => (provenance[e.id] ?? []).includes(chapter));
}

export function scopeCast(bible: StoryBible, chapter: number): ScopedCast {
  const chars = scopedByProvenance(bible.characters, bible.provenance, chapter);
  const locs = scopedByProvenance(bible.locations, bible.provenance, chapter);
  return {
    characters: chars.length ? chars : bible.characters,
    locations: locs.length ? locs : bible.locations,
  };
}

/**
 * The fallback location id for an unresolved heading (E1). Deliberately NOT the
 * "most frequent" place — that systematically favours the umbrella location
 * (荣国府) and, once a real id is filled in, slips past
 * `checkReferentialIntegrity` as a *structurally valid semantic lie*. We pick
 * the smallest-code-point scoped id: neutral, deterministic, umbrella-free.
 * Falls back to the full bible by the same rule; throws only if the whole bible
 * has no location (that is the upstream Curator's failure, not ours to fake).
 */
export function dominantLocation(bible: StoryBible, chapter: number): string {
  const scoped = scopedByProvenance(bible.locations, bible.provenance, chapter);
  const pool = scoped.length ? scoped : bible.locations;
  if (pool.length === 0) {
    throw new Error(
      `Scene Converter: chapter ${chapter} has no location in the StoryBible; ` +
        `cannot satisfy the required heading.location_id (upstream Curator's responsibility).`,
    );
  }
  return pool.map((l) => l.id).sort(byId)[0];
}

// ---------------------------------------------------------------------------
// Body cap (E6) + assembly (D2/I10). Code is the sole authority for the scene
// id and source provenance — the LLM never touches them (anti-hallucination).
// ---------------------------------------------------------------------------

/** Cap on the scene body sent to the LLM (E6; per-scene, smaller than PR4's
 *  MAP_BODY_CAP). Truncation breaks the "one candidate = one scene" fidelity,
 *  so the caller flags needs_review + a `truncated_scene` issue — never silent. */
export const SCENE_BODY_CAP = 4000;
const BODY_TRUNCATION_MARK = "……（后文已截断）";

/** Cap on the stored `source.excerpt` — a short traceability pointer, not the
 *  whole candidate (which `source.chapter` + the original novel already index). */
export const SCENE_EXCERPT_CAP = 120;

export function capSceneBody(text: string): { body: string; truncated: boolean } {
  if (text.length <= SCENE_BODY_CAP) return { body: text, truncated: false };
  return { body: text.slice(0, SCENE_BODY_CAP) + BODY_TRUNCATION_MARK, truncated: true };
}

/** Head of the candidate text, capped; candidate is non-empty (Chunker trims). */
function excerptOf(text: string): string {
  return text.length > SCENE_EXCERPT_CAP
    ? text.slice(0, SCENE_EXCERPT_CAP) + "…"
    : text;
}

export interface AssembleInput {
  chapter: number;
  candidate: SceneCandidate;
  /** Already resolved to a location_id. */
  heading: SceneHeading;
  /** Already resolved (character_id assigned / unresolved speakers demoted). */
  elements: Element[];
  synopsis: string;
  issues: ConversionIssue[];
}

/**
 * Assemble the final `Scene`, with code owning the non-negotiables:
 *   - `id = scene_<chapter>_<candidate.index + 1>` (I10 — unique *within one
 *     conversion run*; cross-chapter/global dedup is the orchestrator's job),
 *   - `source = { chapter, excerpt }` from known original text (never the LLM),
 *   - `needs_review` set when any issue exists OR elements is empty (I11).
 */
export function assembleScene(input: AssembleInput): Scene {
  const { chapter, candidate, heading, elements, synopsis, issues } = input;
  const needsReview = issues.length > 0 || elements.length === 0;
  const scene: Scene = {
    id: `scene_${chapter}_${candidate.index + 1}`,
    heading,
    synopsis,
    source: { chapter, excerpt: excerptOf(candidate.text) },
    elements,
    ...(needsReview ? { needs_review: true } : {}),
  };
  return scene;
}

/**
 * Defensive scene-level referential self-check (I4). `checkReferentialIntegrity`
 * only consumes a `Screenplay`, so we wrap the single scene with the bible's
 * tables under placeholder title/logline. By construction the result is empty;
 * a non-empty return means an assembly bug, which the caller treats as fatal.
 */
export function sceneReferentialCheck(
  scene: Scene,
  bible: StoryBible,
): ReferenceIssue[] {
  const screenplay: Screenplay = {
    title: "·",
    logline: "·",
    characters: bible.characters,
    locations: bible.locations,
    scenes: [scene],
  };
  return checkReferentialIntegrity(screenplay);
}

// ---------------------------------------------------------------------------
// Prompt. The system prompt carries no character/location examples so a test
// stub can key purely on the *user* message (the scene body + cast) — PR4's I7
// lesson. The prompt shows only the chapter-scoped cast (focus / token economy);
// the resolver still spans the full bible (I6), so a cross-chapter alias the
// model happens to use still resolves cleanly rather than becoming an issue.
// ---------------------------------------------------------------------------

const SCENE_SYSTEM = `【场景转换】你是影视剧本场景编剧。把给定的【单个场景】小说原文忠实转换为结构化剧本。
要求：
- 只使用所给【人物表】【地点表】里出现的称呼来指代人物与地点，不得新增或杜撰任何人物/地点。
- 忠实原文，把叙述拆解为有序元素：action（动作/旁白）、dialogue（对白，须用 speaker 注明说话人的名字）、transition（转场）。
- heading 给出 int_ext（INT 内景/EXT 外景）、location（地点名字）、time_of_day（DAY/NIGHT/DAWN/DUSK/CONTINUOUS/LATER 之一）。
- synopsis 用一句话概括本场景。
- 严格输出 JSON：{"heading":{"int_ext","location","time_of_day"},"synopsis","elements":[{"type":"action","text"}|{"type":"dialogue","speaker","parenthetical","line"}|{"type":"transition","text"}]}，不要多余字段或解释文字。`;

/** Render a cast entity as `规范名（亦称：别名…）` for the prompt. */
function castLine(e: { name: string; aliases?: string[] }): string {
  const aliases = e.aliases ?? [];
  return aliases.length ? `${e.name}（亦称：${aliases.join("、")}）` : e.name;
}

/**
 * Feedback for a retry (D1). When the Validator (deterministic) or Critic
 * (semantic) finds a problem, the orchestrator passes the prior attempt's
 * critique (and optionally the prior scene) back so a temperature:0 retry
 * actually changes its output — otherwise an identical input reruns identically.
 */
export interface SceneRevision {
  /** Problems with the prior attempt (deterministic feedback or Critic advice). */
  critique: string[];
  /** The prior scene, so the model revises rather than restarts. Optional. */
  prior?: Scene;
}

/** The revision feedback as a trailing user message (append-only, E13). */
function revisionMessage(revision: SceneRevision): ChatMessage {
  const bullets = revision.critique.map((c) => `- ${c}`).join("\n");
  const priorLine = revision.prior
    ? `\n上一版结果（供修订参考）：\n${JSON.stringify(revision.prior)}`
    : "";
  return {
    role: "user",
    content:
      `上一版转换存在以下问题，请据此修订（仍只用所给人物/地点称呼、忠实原文、严格 JSON）：\n` +
      `${bullets}${priorLine}`,
  };
}

function buildScenePrompt(
  body: string,
  cast: ScopedCast,
  revision?: SceneRevision,
): ChatMessage[] {
  const chars = cast.characters.map(castLine).join("；") || "（无）";
  const locs = cast.locations.map(castLine).join("；") || "（无）";
  const messages: ChatMessage[] = [
    { role: "system", content: SCENE_SYSTEM },
    {
      role: "user",
      content: `人物表：${chars}\n地点表：${locs}\n\n场景原文：\n${body}`,
    },
  ];
  // Append-only: a first pass (no revision) is byte-for-byte the PR5 shape.
  if (revision) messages.push(revisionMessage(revision));
  return messages;
}

// ---------------------------------------------------------------------------
// Public API. One candidate → one Scene (D5). The result is ALWAYS schema-valid
// and referentially clean; every reference that did not resolve cleanly is
// reported as a located ConversionIssue and reflected in `needs_review`, leaving
// the retry decision to PR6 (D3/§4 boundary).
// ---------------------------------------------------------------------------

export interface SceneConversionResult {
  /** Always schema-valid + referentially clean against `bible`. */
  scene: Scene;
  /** Empty = every reference resolved cleanly. */
  issues: ConversionIssue[];
}

export async function convertScene(
  candidate: SceneCandidate,
  chapter: number, // 1-based, aligns with SceneSourceSchema.chapter
  bible: StoryBible,
  llm: LLMClient,
  revision?: SceneRevision, // D1: optional retry feedback, append-only (E13)
): Promise<SceneConversionResult> {
  const sceneId = `scene_${chapter}_${candidate.index + 1}`;

  // 1) Scope the cast for this chapter (focus) and build full-bible resolvers
  //    (resolution authority spans the whole bible; scoping marks tier-2 prefs).
  const cast = scopeCast(bible, chapter);
  const charResolver = buildResolver(
    bible.characters,
    new Set(cast.characters.map((c) => c.id)),
  );
  const locResolver = buildResolver(
    bible.locations,
    new Set(cast.locations.map((l) => l.id)),
  );

  // 2) Cap the body before the LLM (E6); truncation is surfaced, never silent.
  const { body, truncated } = capSceneBody(candidate.text);
  const issues: ConversionIssue[] = [];
  if (truncated) {
    issues.push({
      kind: "truncated_scene",
      surface: "",
      where: "source.body",
      resolution: `body truncated to ${SCENE_BODY_CAP} chars before conversion; scene may be incomplete (heading/elements unverified)`,
    });
  }

  // 3) LLM call. Distinguish JSON-parse failure (I8) from shape failure below.
  let raw: unknown;
  try {
    raw = await llm.chatJSON(buildScenePrompt(body, cast, revision), { temperature: 0 });
  } catch (err) {
    throw new Error(
      `Scene Converter ${sceneId}: LLM response was not parseable JSON: ${
        (err as Error).message
      }`,
    );
  }

  // 4) Coerce trivial noise (E3), then strict-validate the shape (D6). Real
  //    garbage (bad enum, missing required field) throws with scene context.
  let rawScene: RawScene;
  try {
    ({ scene: rawScene } = coerceRawScene(raw));
  } catch (err) {
    throw new Error(
      `Scene Converter ${sceneId}: malformed scene shape: ${(err as Error).message}`,
    );
  }

  // 5) Resolve heading.location name → id (E1/E2 fallbacks + flags).
  const locRes = resolveSurface(locResolver, rawScene.heading.location);
  let locationId: string;
  if (locRes.id === null) {
    locationId = dominantLocation(bible, chapter);
    issues.push({
      kind: "unresolved_location",
      surface: rawScene.heading.location,
      where: "heading.location",
      resolution: `placeholder fallback (${locationId}), heading unverified`,
    });
  } else {
    locationId = locRes.id;
    if (locRes.ambiguous) {
      issues.push({
        kind: "ambiguous_reference",
        surface: rawScene.heading.location,
        where: "heading.location",
        resolution: `guessed ${locationId} via tier ladder`,
        candidates: locRes.candidates,
      });
    }
  }
  const heading: SceneHeading = {
    int_ext: rawScene.heading.int_ext,
    location_id: locationId,
    time_of_day: rawScene.heading.time_of_day,
  };

  // 6) Resolve each element. Dialogue speaker name → character_id; an unresolved
  //    speaker is demoted to action with the line in 「」 (E5), never injecting
  //    the unverified speaker name into the narration.
  const elements: Element[] = rawScene.elements.map((el, i) => {
    if (el.type !== "dialogue") return el;
    const res = resolveSurface(charResolver, el.speaker);
    if (res.id === null) {
      issues.push({
        kind: "unresolved_character",
        surface: el.speaker,
        where: `elements[${i}].speaker`,
        resolution: "demoted to action",
      });
      return { type: "action", text: `「${el.line}」` };
    }
    if (res.ambiguous) {
      issues.push({
        kind: "ambiguous_reference",
        surface: el.speaker,
        where: `elements[${i}].speaker`,
        resolution: `guessed ${res.id} via tier ladder`,
        candidates: res.candidates,
      });
    }
    return {
      type: "dialogue",
      character_id: res.id,
      ...(el.parenthetical ? { parenthetical: el.parenthetical } : {}),
      line: el.line,
    };
  });

  // 7) Assemble (code owns id + source), then a defensive referential self-check
  //    (I4): by construction it is empty, so any issue is an assembly bug.
  const scene = assembleScene({
    chapter,
    candidate,
    heading,
    elements,
    synopsis: rawScene.synopsis,
    issues,
  });
  const refIssues = sceneReferentialCheck(scene, bible);
  if (refIssues.length) {
    throw new Error(
      `Scene Converter ${sceneId}: assembled scene has dangling references ` +
        `(bug): ${JSON.stringify(refIssues)}`,
    );
  }

  return { scene, issues };
}
