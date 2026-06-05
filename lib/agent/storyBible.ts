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
import type { Character, Location } from "../schema/screenplay";

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
