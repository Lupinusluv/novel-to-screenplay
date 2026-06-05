/**
 * StoryBible Curator (设定集) — the pipeline's first LLM agent.
 *
 * Scans the whole novel (Chunker's `Chapter[]`) and produces a unified
 * character + location table, each entity carrying a stable `id`, to serve as
 * the cross-chapter shared memory that the Scene Converter (PR5) references.
 *
 * Shape: map-reduce + deterministic id post-processing
 *   1. map    (per chapter, LLM) — local entity table for that chapter
 *   2. reduce (single LLM call)  — merge cross-chapter duplicates / aliases
 *   3. assignIds (deterministic) — stable id + sanitize + dedup fallback
 *   4. validate (zod + structural) — bind output to PR2 schema
 *
 * Design rationale & review deltas: docs/superpowers/specs/
 *   2026-06-06-pr4-storybible-curator-design.md (§10 is authoritative).
 */

import { z } from "zod";
import {
  CharacterSchema,
  LocationSchema,
  type Character,
  type Location,
} from "../schema/screenplay";
import type { Chapter } from "./chunker";
import type { ChatMessage, LLMClient } from "../llm/client";

// ---------------------------------------------------------------------------
// Intermediate zod schemas (I1): the LLM output at each stage is validated by
// its own schema before entering business logic — `chatJSON` only parses, it
// does not validate. `strictObject` rejects hallucinated fields loudly.
// ---------------------------------------------------------------------------

/** A character as extracted from a *single* chapter (map stage). */
const MapCharacterSchema = z.strictObject({
  name: z.string().min(1),
  /** Different in-text names for this character within the chapter. */
  aliases: z.array(z.string()).default([]),
  /** LLM's romanization *hint* — code remains the id authority (decision 三). */
  romanization: z.string().optional(),
  description: z.string().optional(),
});

/** A location as extracted from a single chapter (map stage, no aliases yet). */
const MapLocationSchema = z.strictObject({
  name: z.string().min(1),
  romanization: z.string().optional(),
  description: z.string().optional(),
});

/** One chapter's local entity table — the map-stage LLM output contract. */
export const MapEntitiesSchema = z.strictObject({
  characters: z.array(MapCharacterSchema).default([]),
  locations: z.array(MapLocationSchema).default([]),
});

/** A merged, canonical character after reduce — still WITHOUT an id. */
const ReduceCharacterSchema = z.strictObject({
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  romanization: z.string().optional(),
  description: z.string().optional(),
  /** Best-effort arc; 3 chapters is thin, may be absent. */
  arc: z.string().optional(),
});

/** A merged, canonical location after reduce — aliases now carry variants. */
const ReduceLocationSchema = z.strictObject({
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  romanization: z.string().optional(),
  description: z.string().optional(),
});

/** The reduce-stage LLM output contract: merged entities, no ids assigned. */
export const ReduceEntitiesSchema = z.strictObject({
  characters: z.array(ReduceCharacterSchema).default([]),
  locations: z.array(ReduceLocationSchema).default([]),
});

export type MapEntities = z.infer<typeof MapEntitiesSchema>;
export type ReduceEntities = z.infer<typeof ReduceEntitiesSchema>;

// ---------------------------------------------------------------------------
// Public output type. The character/location tables are PR2 schema types; the
// `provenance` side-table (R6) maps each entity id to the 1-based chapter
// numbers it appears in — computed during map, kept out of the strictObject
// schemas, and consumed by PR5 to scope candidate entities per chapter.
// ---------------------------------------------------------------------------

export interface StoryBible {
  characters: Character[];
  locations: Location[];
  /** entity id → sorted 1-based chapter numbers it appears in. */
  provenance: Record<string, number[]>;
}

// ---------------------------------------------------------------------------
// Deterministic id post-processing (decision 二/三 + R1). The LLM only hands
// us a `romanization` hint; code is the sole id authority: sanitize → slug,
// dedup collisions, and fall back to a positional id. Entities are sorted by
// canonical name *before* the positional/`_2` numbering so those paths are
// reproducible across runs (R1).
// ---------------------------------------------------------------------------

/** Lowercase, non-`[a-z0-9]` → `_`, collapse/trim underscores. */
export function sanitizeSlug(romanization: string | undefined): string {
  return (romanization ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Stable code-unit name order — locale-independent, hence reproducible. */
function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function assignIds<T extends { name: string; romanization?: string }>(
  entities: T[],
  prefix: "char" | "loc",
): (T & { id: string })[] {
  const sorted = [...entities].sort(byName);
  const used = new Set<string>();
  return sorted.map((e, i) => {
    const base = sanitizeSlug(e.romanization) || String(i + 1);
    let id = `${prefix}_${base}`;
    let n = 2;
    while (used.has(id)) id = `${prefix}_${base}_${n++}`;
    used.add(id);
    return { ...e, id };
  });
}

// ---------------------------------------------------------------------------
// Map-output coercion (I5): drop entities with no usable name BEFORE strict
// schema validation, counting drops so a noisy LLM is visible rather than
// silently swallowed. Anything the strict schema still rejects (unknown keys,
// wrong types) throws — that is dirty data, not a missing name.
// ---------------------------------------------------------------------------

export function coerceMapEntities(raw: unknown): {
  entities: MapEntities;
  dropped: number;
} {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  let dropped = 0;
  const keepNamed = (arr: unknown): unknown[] => {
    if (!Array.isArray(arr)) return [];
    return arr.filter((e) => {
      const named =
        !!e &&
        typeof e === "object" &&
        typeof (e as { name?: unknown }).name === "string" &&
        (e as { name: string }).name.trim() !== "";
      if (!named) dropped++;
      return named;
    });
  };
  const entities = MapEntitiesSchema.parse({
    characters: keepNamed(obj.characters),
    locations: keepNamed(obj.locations),
  });
  return { entities, dropped };
}

// ---------------------------------------------------------------------------
// Provenance (R6): map each final entity id to the 1-based chapters whose map
// output mentioned any of its surface forms (canonical name or an alias). The
// per-chapter forms are computed during map; merging across chapters is what
// links 荣国府(ch1)/荣府(ch2) to one id spanning [1,2].
// ---------------------------------------------------------------------------

export function computeProvenance(
  finals: { id: string; name: string; aliases: string[] }[],
  perChapter: { chapter: number; forms: string[] }[],
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const e of finals) {
    const surface = new Set([e.name, ...e.aliases]);
    const chapters = perChapter
      .filter((c) => c.forms.some((f) => surface.has(f)))
      .map((c) => c.chapter);
    out[e.id] = [...new Set(chapters)].sort((a, b) => a - b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Strong structural validation (I2) — beyond zod shape, in the spirit of
// `checkReferentialIntegrity`: id uniqueness, id format, alias hygiene, and
// cross-table id collisions. Returns located issues (empty = pass) rather
// than throwing, so the orchestrator can act on them.
// ---------------------------------------------------------------------------

export type BibleIssueKind =
  | "duplicate_id"
  | "bad_id_format"
  | "duplicate_alias"
  | "name_in_aliases"
  | "cross_table_id";

export interface BibleIssue {
  kind: BibleIssueKind;
  /** The offending entity id. */
  id: string;
  detail: string;
}

const CHAR_ID = /^char_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const LOC_ID = /^loc_[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * Validate a curated StoryBible's structural invariants. Operates on entities
 * already shaped by `CharacterSchema` / `LocationSchema`.
 */
export function validateStoryBible(bible: StoryBible): BibleIssue[] {
  const issues: BibleIssue[] = [];

  const charIds = new Set<string>();
  const locIds = new Set<string>();

  const checkEntity = (
    e: Character | Location,
    pattern: RegExp,
    seen: Set<string>,
  ) => {
    if (!pattern.test(e.id)) {
      issues.push({
        kind: "bad_id_format",
        id: e.id,
        detail: `id "${e.id}" does not match the expected slug pattern`,
      });
    }
    if (seen.has(e.id)) {
      issues.push({
        kind: "duplicate_id",
        id: e.id,
        detail: `id "${e.id}" appears more than once in its table`,
      });
    }
    seen.add(e.id);

    const aliases = e.aliases ?? [];
    if (new Set(aliases).size !== aliases.length) {
      issues.push({
        kind: "duplicate_alias",
        id: e.id,
        detail: `entity "${e.id}" has duplicate aliases`,
      });
    }
    if (aliases.includes(e.name)) {
      issues.push({
        kind: "name_in_aliases",
        id: e.id,
        detail: `canonical name "${e.name}" leaks into the aliases of "${e.id}"`,
      });
    }
  };

  for (const c of bible.characters) checkEntity(c, CHAR_ID, charIds);
  for (const l of bible.locations) checkEntity(l, LOC_ID, locIds);

  for (const id of charIds) {
    if (locIds.has(id)) {
      issues.push({
        kind: "cross_table_id",
        id,
        detail: `id "${id}" is used by both a character and a location`,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Prompts. Bracketed tags 【分章抽取】/【合并去重】 are stable routing anchors
// (also let tests key a stub by content, not call order — I7).
// ---------------------------------------------------------------------------

/** Cap on how much chapter text we send per map call (I4). */
export const MAP_BODY_CAP = 6000;
const TRUNCATION_MARK = "……（后文已截断）";

const MAP_SYSTEM = `【分章抽取】你是影视剧本设定集助理。从给定的【单章】小说原文中，抽取本章出现的人物与地点。
要求：
- 只抽取原文确有出现的实体，不得编造。
- 人物 aliases 是同一人在本章原文中的不同称呼（如「宝玉/宝二爷」），且均须在原文出现。
- romanization 给出该名字的拼音提示（小写英文，仅用于生成 id）。
- 严格输出 JSON：{"characters":[{"name","aliases":[],"romanization","description"}],"locations":[{"name","romanization","description"}]}，不要多余字段或解释文字。`;

const REDUCE_SYSTEM = `【合并去重】你是影视剧本设定集主编。下面是逐章抽取的实体表，请跨章合并同一实体。
要求：
- 同一人物的不同称呼并入一条，aliases 并齐，并选定一个规范 name。
- 同一地点的不同称呼（如「荣国府/荣府」）并入一条，aliases 保留变体。
- 别名必须是原文出现过的称呼；亲属/泛称（老爷/太太/姑娘）须有明确消歧上下文才合并，不确定则保持分开，宁可多留一条。
- 人物可补 arc（信息不足可空）。不要分配 id。
- 严格输出 JSON：{"characters":[{"name","aliases":[],"romanization","description","arc"}],"locations":[{"name","aliases":[],"romanization","description"}]}。`;

/** Build the per-chapter map prompt; sends only `body`, capped (I4). */
function mapPrompt(body: string): ChatMessage[] {
  const text =
    body.length > MAP_BODY_CAP
      ? body.slice(0, MAP_BODY_CAP) + TRUNCATION_MARK
      : body;
  return [
    { role: "system", content: MAP_SYSTEM },
    { role: "user", content: `本章原文：\n${text}` },
  ];
}

/** Build the single reduce prompt from all chapters' local tables. */
function reducePrompt(
  perChapter: { chapter: number; entities: MapEntities }[],
): ChatMessage[] {
  return [
    { role: "system", content: REDUCE_SYSTEM },
    {
      role: "user",
      content: `逐章实体表（JSON）：\n${JSON.stringify(perChapter)}`,
    },
  ];
}

/** Dedup aliases and strip the canonical name from them (alias hygiene). */
function hygieneAliases(name: string, aliases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of aliases) {
    if (a === name || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestrator. map (per chapter, Promise.all — R3) → reduce (single call —
// R2) → deterministic ids (R1) → schema-clean entities + provenance (R6) →
// strong validation. All LLM calls pin temperature:0 for reproducibility (R1).
// ---------------------------------------------------------------------------

export async function curateStoryBible(
  chapters: Chapter[],
  llm: LLMClient,
): Promise<StoryBible> {
  // Map — parallel across chapters; failures carry the 1-based chapter (I3).
  const perChapter = await Promise.all(
    chapters.map(async (ch) => {
      const chapter = ch.index + 1; // 1-based, aligns with SceneSourceSchema
      let raw: unknown;
      try {
        raw = await llm.chatJSON(mapPrompt(ch.body), { temperature: 0 });
      } catch (err) {
        throw new Error(
          `StoryBible map failed for chapter ${chapter}: ${
            (err as Error).message
          }`,
        );
      }
      const { entities, dropped } = coerceMapEntities(raw);
      if (dropped > 0) {
        console.warn(
          `[storyBible] chapter ${chapter}: dropped ${dropped} nameless entit${
            dropped === 1 ? "y" : "ies"
          }`,
        );
      }
      return { chapter, entities };
    }),
  );

  // Reduce — one merge call; strict schema rejects dirty output (I1).
  const reduceRaw = await llm.chatJSON(reducePrompt(perChapter), {
    temperature: 0,
  });
  const reduced = ReduceEntitiesSchema.parse(reduceRaw);

  // Deterministic ids, then build PR2-schema-clean entities (romanization is a
  // hint, never an output field) and validate each against the contract.
  const characters: Character[] = assignIds(reduced.characters, "char").map(
    (c) =>
      CharacterSchema.parse({
        id: c.id,
        name: c.name,
        aliases: hygieneAliases(c.name, c.aliases),
        ...(c.description ? { description: c.description } : {}),
        ...(c.arc ? { arc: c.arc } : {}),
      }),
  );
  const locations: Location[] = assignIds(reduced.locations, "loc").map((l) =>
    LocationSchema.parse({
      id: l.id,
      name: l.name,
      aliases: hygieneAliases(l.name, l.aliases),
      ...(l.description ? { description: l.description } : {}),
    }),
  );

  // Provenance (R6) — per table, from the map-stage surface forms.
  const charForms = perChapter.map((p) => ({
    chapter: p.chapter,
    forms: p.entities.characters.flatMap((e) => [e.name, ...e.aliases]),
  }));
  const locForms = perChapter.map((p) => ({
    chapter: p.chapter,
    forms: p.entities.locations.map((e) => e.name),
  }));
  const provenance = {
    ...computeProvenance(characters, charForms),
    ...computeProvenance(locations, locForms),
  };

  const bible: StoryBible = { characters, locations, provenance };

  // Defensive: assignIds guarantees the invariants, so any issue is a bug.
  const issues = validateStoryBible(bible);
  if (issues.length) {
    throw new Error(
      `StoryBible failed structural validation: ${JSON.stringify(issues)}`,
    );
  }
  return bible;
}
