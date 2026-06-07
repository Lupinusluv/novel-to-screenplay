/**
 * Parse + validate user-edited screenplay YAML for the "apply edit" round-trip.
 * Wraps `fromYAML` (yaml.parse + zod) and `checkReferentialIntegrity`, turning
 * thrown errors into a friendly, inline-displayable result and layering on the
 * invariants the schema deliberately does NOT enforce (id uniqueness, ≥1 scene).
 *
 * Result contract:
 *   - structural / syntax / invariant failure → `{ ok:false, error }` (the
 *     caller keeps the previous good state — a bad edit never destroys it),
 *   - broken references → `{ ok:true, refWarnings }` (applied, but flagged —
 *     a dangling id is editable-in-progress, not a hard error).
 *
 * E10 NARROW EXCEPTION: this is the one `lib/client` module that imports
 * lib/schema at RUNTIME (not type-only). AGENTS.md forbids lib/client →
 * lib/agent (backend/fs/env); lib/schema is a pure, fs-free, front/back-shared
 * module, so depending on its runtime (`fromYAML`/`checkReferentialIntegrity`)
 * is intentional and documented in the PR8 spec §5.1. Keeping applyEdit here
 * (rather than inlining it in the component) is what lets it node-unit-test.
 */

import { fromYAML } from "../schema/yaml";
import {
  checkReferentialIntegrity,
  type ReferenceIssue,
  type Screenplay,
} from "../schema/screenplay";

/** Reject pathologically large input before handing it to the YAML parser,
 *  which can blow up on alias-dense or huge documents. */
export const MAX_YAML_CHARS = 1_000_000;

export type ApplyResult =
  | { ok: true; screenplay: Screenplay; refWarnings: ReferenceIssue[] }
  | { ok: false; error: string };

interface ZodLikeIssue {
  path: Array<string | number>;
  message: string;
}

/** Turn a thrown parse/validation error into a short, human-readable Chinese
 *  message. ZodError → first issue's dotted path + message; anything else
 *  (the YAML parser) → a syntax-error string. */
function friendly(e: unknown): string {
  const issues = (e as { issues?: ZodLikeIssue[] })?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const first = issues[0];
    const path = first.path.join(".");
    return path ? `${path}: ${first.message}` : first.message;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return `YAML 语法错误：${msg}`;
}

/** First duplicated id in a list, or null when all are unique. */
function firstDuplicate(ids: string[]): string | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

export function applyEdit(text: string): ApplyResult {
  if (!text || !text.trim()) {
    return { ok: false, error: "内容为空" };
  }
  if (text.length > MAX_YAML_CHARS) {
    return { ok: false, error: "内容过长，无法解析" };
  }

  let screenplay: Screenplay;
  try {
    screenplay = fromYAML(text);
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }

  // Invariants the zod schema does not cover.
  if (screenplay.scenes.length === 0) {
    return { ok: false, error: "剧本至少需要一个场景" };
  }
  const dupScene = firstDuplicate(screenplay.scenes.map((s) => s.id));
  if (dupScene) return { ok: false, error: `scenes.id 重复：${dupScene}` };
  const dupChar = firstDuplicate(screenplay.characters.map((c) => c.id));
  if (dupChar) return { ok: false, error: `characters.id 重复：${dupChar}` };
  const dupLoc = firstDuplicate(screenplay.locations.map((l) => l.id));
  if (dupLoc) return { ok: false, error: `locations.id 重复：${dupLoc}` };

  const refWarnings = checkReferentialIntegrity(screenplay);
  return { ok: true, screenplay, refWarnings };
}
