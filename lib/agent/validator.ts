/**
 * Validator (格式审校) — the pipeline's deterministic gate. No LLM, no semantic
 * judgement.
 *
 * The Scene Converter already guarantees each *individual* scene is schema-valid
 * and referentially clean (it self-heals + reports issues). So the Validator's
 * real value is at the *whole-Screenplay* seam (decision D3):
 *   - structural validation of the assembled Screenplay (zod),
 *   - referential integrity across the final character/location tables,
 *   - cross-chapter scene-id uniqueness (I10 — the orchestrator's responsibility,
 *     asserted here; by construction `scene_<chapter>_<index+1>` is already
 *     unique, so a hit means an upstream bug),
 *   - a `needs_review` census for the UI / demo narration.
 * It also offers a defensive per-scene check used inside the retry loop.
 *
 * Design rationale & review deltas: docs/superpowers/specs/
 *   2026-06-06-pr6-validator-critic-orchestrator-design.md (§3.2, §11 E11/E12).
 */

import {
  ScreenplaySchema,
  SceneSchema,
  checkReferentialIntegrity,
  type Scene,
  type Screenplay,
  type ReferenceIssue,
} from "../schema/screenplay";
import type { StoryBible } from "./storyBible";
import type { ZodError } from "zod";

export interface ValidationReport {
  /** True iff no structural / reference / duplicate-id problems. */
  ok: boolean;
  /** Flattened structural (zod) errors; empty = structurally valid. */
  structural: string[];
  /** Dangling character_id / location_id references; empty = clean. */
  references: ReferenceIssue[];
  /** Scene ids appearing more than once (I10); empty by construction. */
  duplicateSceneIds: string[];
  /** Scene ids carrying `needs_review` — a signal, not a failure. */
  needsReview: string[];
}

/** `path.to.field: message` lines from a ZodError, for human-readable reports. */
function flattenZod(err: ZodError): string[] {
  return err.issues.map((i) => {
    const path = i.path.join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
}

/** Scene ids that occur more than once, each reported once, in first-seen order. */
function findDuplicateIds(scenes: Scene[]): string[] {
  const counts = new Map<string, number>();
  for (const s of scenes) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
  const dups: string[] = [];
  const emitted = new Set<string>();
  for (const s of scenes) {
    if ((counts.get(s.id) ?? 0) > 1 && !emitted.has(s.id)) {
      dups.push(s.id);
      emitted.add(s.id);
    }
  }
  return dups;
}

/**
 * Whole-Screenplay gate (D3). `references` is computed only when the input is
 * structurally valid (a broken shape makes referential checks moot). `ok` folds
 * structural + reference + duplicate-id failures; `needsReview` is a census, not
 * a failure (a flagged-but-clean screenplay still passes).
 */
export function validateScreenplay(screenplay: Screenplay): ValidationReport {
  const parsed = ScreenplaySchema.safeParse(screenplay);
  const structural = parsed.success ? [] : flattenZod(parsed.error);

  const references = structural.length === 0 ? checkReferentialIntegrity(screenplay) : [];
  const duplicateSceneIds = findDuplicateIds(screenplay.scenes ?? []);
  const needsReview = (screenplay.scenes ?? [])
    .filter((s) => s.needs_review === true)
    .map((s) => s.id);

  const ok =
    structural.length === 0 &&
    references.length === 0 &&
    duplicateSceneIds.length === 0;

  return { ok, structural, references, duplicateSceneIds, needsReview };
}

/**
 * Defensive per-scene check (E12) used inside the orchestrator loop: asserts the
 * Converter's "schema-valid + referentially clean" contract. Returns a rich
 * report (both empty = pass) rather than throwing, so the orchestrator can decide
 * how to react. References are wrapped against the bible's tables (mirrors
 * `sceneConverter.sceneReferentialCheck`), skipped when the shape is broken.
 */
export function validateScene(
  scene: Scene,
  bible: StoryBible,
): { structural: string[]; references: ReferenceIssue[] } {
  const parsed = SceneSchema.safeParse(scene);
  const structural = parsed.success ? [] : flattenZod(parsed.error);
  if (structural.length > 0) return { structural, references: [] };

  const wrapped: Screenplay = {
    title: "·",
    logline: "·",
    characters: bible.characters,
    locations: bible.locations,
    scenes: [scene],
  };
  return { structural, references: checkReferentialIntegrity(wrapped) };
}
