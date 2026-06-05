/**
 * Screenplay schema — the single source of truth for the structured,
 * editable, traceable screenplay produced by the agent pipeline.
 *
 * Two concerns are deliberately kept separate:
 *   1. **Structural validity** — `ScreenplaySchema` (zod): field types,
 *      enums, required keys. Strict objects reject unknown keys so that a
 *      hallucinated field or a typo from an LLM is caught, not silently kept.
 *   2. **Referential integrity** — `checkReferentialIntegrity`: every
 *      `character_id` / `location_id` used by a scene must resolve to an
 *      entry in the top-level `characters` / `locations` tables.
 *
 * They are split because a scene may be structurally valid while still
 * referencing an id the Story Bible does not (yet) define; the
 * self-correction loop needs the *located* reference errors to feed back
 * into the Scene Converter, which a thrown ZodError would not give us.
 *
 * Design rationale is documented in `docs/SCHEMA.md`.
 */

import { z } from "zod";

/** Interior / exterior, per industry slug-line convention. */
export const IntExt = z.enum(["INT", "EXT"]);

/** Time of day for a scene heading. */
export const TimeOfDay = z.enum([
  "DAY",
  "NIGHT",
  "DAWN",
  "DUSK",
  "CONTINUOUS",
  "LATER",
]);

/** A character = an entry in the Story Bible, referenced by stable `id`. */
export const CharacterSchema = z.strictObject({
  /** Stable id referenced by scene elements, e.g. `char_lin`. */
  id: z.string().min(1),
  name: z.string().min(1),
  /** Alternate names/titles for the same character — cross-chapter glue. */
  aliases: z.array(z.string()).default([]),
  description: z.string().optional(),
  /** Character arc across the story. */
  arc: z.string().optional(),
});

/** A location = an entry in the Story Bible, referenced by stable `id`. */
export const LocationSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Alternate names for the same place (荣国府/荣府) — cross-chapter glue,
   *  symmetric with Character so the curator can merge location variants. */
  aliases: z.array(z.string()).default([]),
  description: z.string().optional(),
});

/**
 * Scene elements form an *ordered heterogeneous list*: a screenplay is a
 * linear time-flow of interleaved action / dialogue / transition, which a
 * fixed-field record cannot express.
 */
export const ActionElement = z.strictObject({
  type: z.literal("action"),
  text: z.string().min(1),
});

export const DialogueElement = z.strictObject({
  type: z.literal("dialogue"),
  /** Must reference a Character id. */
  character_id: z.string().min(1),
  /** Optional performance note, e.g. `(压低声音)`. */
  parenthetical: z.string().optional(),
  line: z.string().min(1),
});

export const TransitionElement = z.strictObject({
  type: z.literal("transition"),
  text: z.string().min(1),
});

export const ElementSchema = z.discriminatedUnion("type", [
  ActionElement,
  DialogueElement,
  TransitionElement,
]);

/** Scene heading (slug line), machine-checkable and renderer-friendly. */
export const SceneHeadingSchema = z.strictObject({
  int_ext: IntExt,
  /** Must reference a Location id. */
  location_id: z.string().min(1),
  time_of_day: TimeOfDay,
});

/** Provenance back to the source novel — the anti-hallucination anchor. */
export const SceneSourceSchema = z.strictObject({
  chapter: z.number().int().positive(),
  excerpt: z.string().min(1),
});

export const SceneSchema = z.strictObject({
  id: z.string().min(1),
  heading: SceneHeadingSchema,
  synopsis: z.string().min(1),
  source: SceneSourceSchema,
  elements: z.array(ElementSchema),
  /** Set by the Critic/Orchestrator when retries are exhausted. */
  needs_review: z.boolean().optional(),
});

export const ScreenplaySchema = z.strictObject({
  title: z.string().min(1),
  logline: z.string().min(1),
  characters: z.array(CharacterSchema),
  locations: z.array(LocationSchema),
  scenes: z.array(SceneSchema),
});

export type IntExt = z.infer<typeof IntExt>;
export type TimeOfDay = z.infer<typeof TimeOfDay>;
export type Character = z.infer<typeof CharacterSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type Element = z.infer<typeof ElementSchema>;
export type SceneHeading = z.infer<typeof SceneHeadingSchema>;
export type SceneSource = z.infer<typeof SceneSourceSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Screenplay = z.infer<typeof ScreenplaySchema>;

/** Parse + structurally validate; throws `ZodError` on invalid input. */
export function parseScreenplay(data: unknown): Screenplay {
  return ScreenplaySchema.parse(data);
}

/** A single broken `character_id` / `location_id` reference, with location. */
export interface ReferenceIssue {
  scene_id: string;
  kind: "character" | "location";
  /** The id that failed to resolve. */
  ref: string;
  /** Where it occurred, e.g. `heading.location_id` or `elements[2].character_id`. */
  where: string;
}

/**
 * Check that every scene's `location_id` and every dialogue's `character_id`
 * resolves to a top-level entry. Returns an empty array when all references
 * resolve (i.e. pass). Operates on already-structurally-valid input.
 */
export function checkReferentialIntegrity(
  screenplay: Screenplay,
): ReferenceIssue[] {
  const characterIds = new Set(screenplay.characters.map((c) => c.id));
  const locationIds = new Set(screenplay.locations.map((l) => l.id));
  const issues: ReferenceIssue[] = [];

  for (const scene of screenplay.scenes) {
    if (!locationIds.has(scene.heading.location_id)) {
      issues.push({
        scene_id: scene.id,
        kind: "location",
        ref: scene.heading.location_id,
        where: "heading.location_id",
      });
    }
    scene.elements.forEach((el, i) => {
      if (el.type === "dialogue" && !characterIds.has(el.character_id)) {
        issues.push({
          scene_id: scene.id,
          kind: "character",
          ref: el.character_id,
          where: `elements[${i}].character_id`,
        });
      }
    });
  }

  return issues;
}
