/**
 * Critic (责编) — the pipeline's second pure LLM agent. Semantic self-review of a
 * converted scene: character contradictions, inconsistent forms of address,
 * dropped dialogue, fidelity to the source. It only REPORTS problems + advice;
 * it never rewrites the scene. The orchestrator feeds the advice back into the
 * Scene Converter's `revision` (D1) for a retry.
 *
 * Mirrors the Converter's contracts: the system prompt carries no entity
 * examples so a content-keyed stub can route on the user message (PR4 I7); the
 * LLM output shape is zod-validated, droppable noise is coerced away, real
 * garbage throws with scene-id context; temperature is pinned to 0.
 *
 * Design rationale: docs/superpowers/specs/
 *   2026-06-06-pr6-validator-critic-orchestrator-design.md (§3.3).
 */

import { z } from "zod";
import type { Scene } from "../schema/screenplay";
import type { StoryBible } from "./storyBible";
import type { ChatMessage, LLMClient } from "../llm/client";

export type CritiqueCategory =
  | "character_inconsistency"
  | "naming"
  | "missing_dialogue"
  | "fidelity"
  | "other";

export interface CritiqueIssue {
  severity: "minor" | "major";
  category: CritiqueCategory;
  /** What is wrong. */
  detail: string;
  /** How to fix it (fed back to the Converter, never auto-applied). */
  suggestion: string;
}

export interface CritiqueResult {
  /** True when no `major` issue — `minor` issues are recorded but do not retry. */
  ok: boolean;
  issues: CritiqueIssue[];
}

// ---------------------------------------------------------------------------
// LLM output shape. strictObject so a hallucinated field is caught; coerce
// strips droppable noise before strict validation (Converter E3 philosophy).
// ---------------------------------------------------------------------------

const CritiqueIssueSchema = z.strictObject({
  severity: z.enum(["minor", "major"]),
  category: z.enum([
    "character_inconsistency",
    "naming",
    "missing_dialogue",
    "fidelity",
    "other",
  ]),
  detail: z.string().min(1),
  suggestion: z.string().min(1),
});

const RawCritiqueSchema = z.strictObject({
  issues: z.array(CritiqueIssueSchema),
});

const ISSUE_KEYS = ["severity", "category", "detail", "suggestion"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Strip unknown keys (top-level + per issue), then strict-validate. */
function coerceRawCritique(raw: unknown): z.infer<typeof RawCritiqueSchema> {
  const obj = isPlainObject(raw) ? raw : {};
  const issues = Array.isArray(obj.issues)
    ? obj.issues.map((it) => {
        if (!isPlainObject(it)) return it;
        const picked: Record<string, unknown> = {};
        for (const k of ISSUE_KEYS) if (k in it) picked[k] = it[k];
        return picked;
      })
    : obj.issues;
  return RawCritiqueSchema.parse({ issues });
}

// ---------------------------------------------------------------------------
// Prompt. No entity examples in the system prompt (I7). The user message carries
// the cast names, the ORIGINAL source text, and the converted scene, so the model
// can judge fidelity / naming / dropped dialogue against the truth.
// ---------------------------------------------------------------------------

const CRITIC_SYSTEM = `【场景审校】你是影视剧本责编。对照原文与人物表，审查给定【已转换场景】是否忠实、一致。
检查项（只报问题，不要改写）：
- character_inconsistency：人物行为/身份前后矛盾。
- naming：同一人物称谓不一致，或用了人物表外的称呼。
- missing_dialogue：原文有的关键对白在场景里漏了。
- fidelity：场景偏离原文、臆造了原文没有的情节。
严格输出 JSON：{"issues":[{"severity":"minor|major","category":"character_inconsistency|naming|missing_dialogue|fidelity|other","detail":"哪里错","suggestion":"怎么改"}]}。
没有问题就返回 {"issues":[]}。只报实质问题，措辞润色之类记 minor。`;

function castNames(bible: StoryBible): string {
  const chars = bible.characters
    .map((c) => [c.name, ...(c.aliases ?? [])].join("/"))
    .join("；");
  const locs = bible.locations
    .map((l) => [l.name, ...(l.aliases ?? [])].join("/"))
    .join("；");
  return `人物表：${chars || "（无）"}\n地点表：${locs || "（无）"}`;
}

function buildCritiquePrompt(
  scene: Scene,
  candidateText: string,
  bible: StoryBible,
): ChatMessage[] {
  return [
    { role: "system", content: CRITIC_SYSTEM },
    {
      role: "user",
      content:
        `${castNames(bible)}\n\n原文：\n${candidateText}\n\n已转换场景（JSON）：\n${JSON.stringify(scene)}`,
    },
  ];
}

/**
 * Critique one converted scene. Always pins temperature 0. `ok` is true iff no
 * `major` issue. Unparseable / malformed model output throws with scene-id
 * context (the orchestrator decides how to react — same boundary as the
 * Converter's structural-garbage throw).
 */
export async function critiqueScene(
  scene: Scene,
  candidateText: string,
  bible: StoryBible,
  llm: LLMClient,
): Promise<CritiqueResult> {
  let raw: unknown;
  try {
    raw = await llm.chatJSON(buildCritiquePrompt(scene, candidateText, bible), {
      temperature: 0,
    });
  } catch (err) {
    throw new Error(
      `Critic ${scene.id}: LLM response was not parseable JSON: ${(err as Error).message}`,
    );
  }

  let parsed: z.infer<typeof RawCritiqueSchema>;
  try {
    parsed = coerceRawCritique(raw);
  } catch (err) {
    throw new Error(
      `Critic ${scene.id}: malformed critique shape: ${(err as Error).message}`,
    );
  }

  const issues = parsed.issues;
  const ok = !issues.some((i) => i.severity === "major");
  return { ok, issues };
}
