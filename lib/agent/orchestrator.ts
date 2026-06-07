/**
 * Orchestrator (导演) — the non-LLM conductor. Plans the order, owns the shared
 * state, drives the self-correction retry loop, runs scenes in parallel, and
 * emits progress events. It does no business logic itself; it sequences the
 * other roles.
 *
 *   chunkNovel → curateStoryBible → (per scene, parallel:
 *        convergeDeterministic → Critic → convergeDeterministic) → assemble.
 *
 * Self-correction is a two-layer loop (review delta §11 E1): every conversion —
 * including a Critic-driven revision — is repaired to a deterministic fixed point
 * before the Critic sees it, so the semantic arm can never leave an unexamined
 * reference problem behind. Structural throws are folded into the retry budget
 * (E2); identical retries (E3) and cross-arm oscillation (E5) stop early; parallel
 * completion never scrambles output order (E5b).
 *
 * Design rationale & deltas: docs/superpowers/specs/
 *   2026-06-06-pr6-validator-critic-orchestrator-design.md (§3.4, §4, §11).
 */

import { chunkNovel, type SceneCandidate } from "./chunker";
import { curateStoryBible, type StoryBible } from "./storyBible";
import {
  convertScene,
  dominantLocation,
  type ConversionIssue,
  type SceneRevision,
} from "./sceneConverter";
import { critiqueScene } from "./critic";
import { toYAML } from "../schema/yaml";
import { eventToSSE } from "./sse";
import type { Scene, Screenplay } from "../schema/screenplay";
import type { PipelineEvent } from "./events";

export type { PipelineEvent, Stage } from "./events";

export interface OrchestratorOptions {
  /** Max retries per arm (deterministic / semantic). Default 2. */
  retryBudget?: number;
  /** Run the Critic (2nd LLM agent). Default true (D2). */
  critic?: boolean;
  /** Which scenes the Critic evaluates (after deterministic fixed point, E4).
   *  "all" = every scene (default, D2); "needs_review" = only flagged ones. */
  criticScope?: "all" | "needs_review";
  /** Parallel scene workers. Default 4. */
  concurrency?: number;
  /** Event sink, transport-agnostic (the SSE route adapts it). */
  onEvent?: (e: PipelineEvent) => void;
  /** Cancellation — checked between stages/scenes (E7). */
  signal?: AbortSignal;
  /** Screenplay title. Default: first chapter title, else "未命名剧本". */
  title?: string;
  /** Screenplay logline. Default a placeholder (deterministic, §3.5). */
  logline?: string;
}

interface WorkItem {
  globalIndex: number;
  chapter: number; // 1-based
  candidate: SceneCandidate;
}

const PLACEHOLDER_BODY_CAP = 200;
const PLACEHOLDER_EXCERPT_CAP = 120;

/** Upper bound on per-arm retries, regardless of caller-supplied `retryBudget`
 *  (review #2: untrusted options must not fan out unbounded LLM calls). */
export const MAX_RETRY_BUDGET = 5;
/** Upper bound on input size (review #2: a pathological novel must not fan out
 *  into unbounded chunking + per-scene LLM calls). ~200k chars ≫ any real demo. */
export const MAX_NOVEL_CHARS = 200_000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const e = new Error("Pipeline aborted");
    e.name = "AbortError";
    throw e;
  }
}

/** Stable identity of a scene for fixed-point / cycle detection (E3/E5). */
function sceneHash(scene: Scene): string {
  return JSON.stringify(scene);
}

/** Turn the Converter's located issues into actionable retry feedback (D1).
 *  Non-actionable kinds (truncation) yield nothing — retrying cannot fix them. */
function issuesToFeedback(issues: ConversionIssue[]): string[] {
  const out: string[] = [];
  for (const it of issues) {
    switch (it.kind) {
      case "unresolved_character":
        out.push(
          `说话人「${it.surface}」不在人物表（${it.where}）。请改用人物表中已有的称呼；若此处其实不是对白，请写成 action。`,
        );
        break;
      case "unresolved_location":
        out.push(
          `地点「${it.surface}」不在地点表（${it.where}）。请改用地点表中已有的地点名。`,
        );
        break;
      case "ambiguous_reference":
        out.push(
          `「${it.surface}」指代不明（${it.where}，候选：${(it.candidates ?? []).join("、")}）。请用更明确、唯一的称呼。`,
        );
        break;
      case "truncated_scene":
        break; // not fixable by a retry
    }
  }
  return out;
}

/** A minimal valid scene used when conversion fails past budget (E2). Keeps the
 *  novel complete instead of letting one bad scene abort the whole run. */
function placeholderScene(
  chapter: number,
  candidate: SceneCandidate,
  bible: StoryBible,
): Scene {
  const text =
    candidate.text.length > PLACEHOLDER_BODY_CAP
      ? candidate.text.slice(0, PLACEHOLDER_BODY_CAP) + "…"
      : candidate.text;
  return {
    id: `scene_${chapter}_${candidate.index + 1}`,
    heading: {
      int_ext: "INT",
      location_id: dominantLocation(bible, chapter),
      time_of_day: "DAY",
    },
    synopsis: "（自动占位：本场景转换反复失败，待人工处理）",
    source: { chapter, excerpt: text.slice(0, PLACEHOLDER_EXCERPT_CAP) },
    elements: [{ type: "action", text }],
    needs_review: true,
  };
}

/** PR9: if the chunker flagged this candidate as a non-adjacent near-duplicate
 *  of an earlier one (multi-version paste), mark the scene needs_review with a
 *  human note. Never deletes — a recurring passage may be legitimate; the call
 *  leaves the judgment to a person. */
function flagNearDuplicate(scene: Scene, candidate: SceneCandidate): Scene {
  if (candidate.nearDuplicateOf === undefined) return scene;
  if (scene.synopsis.includes("疑似与本章")) return scene; // idempotent
  const note = `（疑似与本章第 ${candidate.nearDuplicateOf + 1} 个场景重复，或为多版本粘贴所致，请人工确认）`;
  return { ...scene, needs_review: true, synopsis: scene.synopsis + note };
}

type TryResult =
  | { ok: true; scene: Scene; issues: ConversionIssue[] }
  | { ok: false; error: string };

/** Wrap convertScene: a structural throw becomes a retryable failure, but a
 *  "dangling references (bug)" throw is a real bug and propagates (E2). */
async function tryConvert(
  item: WorkItem,
  bible: StoryBible,
  llm: Parameters<typeof convertScene>[3],
  revision?: SceneRevision,
): Promise<TryResult> {
  try {
    const { scene, issues } = await convertScene(
      item.candidate,
      item.chapter,
      bible,
      llm,
      revision,
    );
    return { ok: true, scene, issues };
  } catch (err) {
    const msg = (err as Error).message;
    if (/dangling references/.test(msg)) throw err;
    return { ok: false, error: msg };
  }
}

interface ConvergeResult {
  scene: Scene;
  issues: ConversionIssue[];
  errored: boolean;
  errorMsg?: string;
}

/** Convert and repair to a deterministic fixed point (E1/E2/E3): retry on issues
 *  or structural throws within `budget`; stop early on an identical retry; on a
 *  budget-exhausted throw, return a placeholder (errored). `seed` lets the
 *  semantic arm prime the first attempt with the Critic's advice. */
async function convergeDeterministic(
  item: WorkItem,
  bible: StoryBible,
  llm: Parameters<typeof convertScene>[3],
  budget: number,
  seed?: SceneRevision,
): Promise<ConvergeResult> {
  let revision = seed;
  let last: Scene | null = null;
  let tries = 0;

  for (;;) {
    const r = await tryConvert(item, bible, llm, revision);

    if (!r.ok) {
      if (tries >= budget) {
        return {
          scene: placeholderScene(item.chapter, item.candidate, bible),
          issues: [],
          errored: true,
          errorMsg: r.error,
        };
      }
      revision = {
        critique: [`上一版输出结构非法，请严格按 JSON schema 重新输出：${r.error}`],
        prior: last ?? undefined,
      };
      tries++;
      continue;
    }

    const { scene, issues } = r;
    if (issues.length === 0) return { scene, issues, errored: false };
    // E3 fixed point: an identical retry will keep being identical → stop.
    if (last && sceneHash(scene) === sceneHash(last)) {
      return { scene, issues, errored: false };
    }
    const feedback = issuesToFeedback(issues);
    if (feedback.length === 0) return { scene, issues, errored: false }; // nothing actionable
    if (tries >= budget) return { scene, issues, errored: false }; // exhausted

    last = scene;
    revision = { critique: feedback, prior: scene };
    tries++;
  }
}

/** Full per-scene pipeline: deterministic fixed point → Critic → (revise →
 *  deterministic fixed point) until semantically OK, budget, or a cycle (E5). */
async function processCandidate(
  item: WorkItem,
  bible: StoryBible,
  llm: Parameters<typeof convertScene>[3],
  opts: OrchestratorOptions,
  emit: (e: PipelineEvent) => void,
): Promise<Scene> {
  // Clamp the caller-supplied budget (review #2): never exceed MAX_RETRY_BUDGET.
  const budget = Math.min(Math.max(opts.retryBudget ?? 2, 0), MAX_RETRY_BUDGET);
  const det = await convergeDeterministic(item, bible, llm, budget);
  let scene = det.scene;

  if (det.errored) {
    emit({
      type: "error",
      stage: "scenes",
      sceneId: scene.id,
      message: det.errorMsg ?? "scene conversion failed",
    });
    return flagNearDuplicate(scene, item.candidate); // placeholder; skip the Critic
  }

  const criticOn = opts.critic ?? true;
  const scope = opts.criticScope ?? "all";
  const inScope = scope === "all" || scene.needs_review === true;
  if (!criticOn || !inScope) return flagNearDuplicate(scene, item.candidate);

  const seen = new Set([sceneHash(scene)]);
  let ctries = 0;
  let crit = await critiqueScene(scene, item.candidate.text, bible, llm);
  while (!crit.ok && ctries < budget) {
    const seed: SceneRevision = {
      critique: crit.issues.filter((i) => i.severity === "major").map((i) => i.suggestion),
      prior: scene,
    };
    const re = await convergeDeterministic(item, bible, llm, budget, seed);
    // FIX #1: a failed revision must not replace the good scene with a
    // placeholder — keep the current best (still flagged needs_review below).
    if (re.errored) break;
    const h = sceneHash(re.scene);
    if (seen.has(h)) break; // E5 oscillation → keep current best
    seen.add(h);
    scene = re.scene;
    crit = await critiqueScene(scene, item.candidate.text, bible, llm);
    ctries++;
  }
  if (!crit.ok) scene = { ...scene, needs_review: true };
  return flagNearDuplicate(scene, item.candidate);
}

/** Bounded-concurrency pool; preserves index→slot mapping (E5b). */
async function runPool(
  items: WorkItem[],
  worker: (item: WorkItem) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i]);
    }
  };
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, runner));
}

/**
 * Run the full novel→screenplay pipeline. Emits `PipelineEvent`s through
 * `opts.onEvent`; returns the assembled `Screenplay` (scenes in deterministic
 * chapter order). The final `final_result` event also carries the YAML.
 */
export async function runPipeline(
  novelText: string,
  llm: Parameters<typeof convertScene>[3],
  opts: OrchestratorOptions = {},
): Promise<Screenplay> {
  const emit = (e: PipelineEvent) => opts.onEvent?.(e);
  const signal = opts.signal;
  throwIfAborted(signal);

  // Review #2: reject pathological input before any work / LLM call.
  if (novelText.length > MAX_NOVEL_CHARS) {
    throw new Error(
      `novel too large: ${novelText.length} chars exceeds MAX_NOVEL_CHARS (${MAX_NOVEL_CHARS}).`,
    );
  }

  emit({ type: "stage_start", stage: "chunk" });
  const { chapters } = chunkNovel(novelText);
  emit({ type: "stage_done", stage: "chunk" });

  throwIfAborted(signal);
  emit({ type: "stage_start", stage: "storybible" });
  let bible: StoryBible;
  try {
    bible = await curateStoryBible(chapters, llm);
  } catch (err) {
    emit({ type: "error", stage: "storybible", message: (err as Error).message });
    throw err;
  }
  // FIX #3: a location-less bible cannot yield referentially-valid scenes; fail
  // early and cleanly (one error event) instead of crashing mid-scene when a
  // placeholder's dominantLocation throws inside a pool worker.
  if (bible.locations.length === 0) {
    const message =
      "StoryBible has no locations; cannot build a referentially-valid screenplay (upstream Curator produced no location).";
    emit({ type: "error", stage: "storybible", message });
    throw new Error(message);
  }
  emit({ type: "stage_done", stage: "storybible" });

  const items: WorkItem[] = [];
  chapters.forEach((ch) => {
    const chapter = ch.index + 1;
    ch.sceneCandidates.forEach((candidate) => {
      items.push({ globalIndex: items.length, chapter, candidate });
    });
  });
  const total = items.length;
  emit({ type: "stage_start", stage: "scenes", total });

  const slots: Scene[] = new Array(total);
  let done = 0;
  await runPool(
    items,
    async (item) => {
      throwIfAborted(signal);
      const scene = await processCandidate(item, bible, llm, opts, emit);
      slots[item.globalIndex] = scene; // index→slot keeps chapter order (E5b)
      emit({ type: "partial_result", scene });
      done++;
      emit({ type: "stage_progress", stage: "scenes", done, total, sceneId: scene.id });
    },
    opts.concurrency ?? 4,
  );
  emit({ type: "stage_done", stage: "scenes" });

  throwIfAborted(signal);
  emit({ type: "stage_start", stage: "assemble" });
  const title = opts.title ?? (chapters[0]?.title || "未命名剧本");
  const logline = opts.logline ?? "（自动生成，待人工润色）";
  const screenplay: Screenplay = {
    title,
    logline,
    characters: bible.characters,
    locations: bible.locations,
    scenes: slots,
  };
  emit({ type: "stage_done", stage: "assemble" });
  emit({ type: "final_result", screenplay, yaml: toYAML(screenplay) });
  return screenplay;
}

/**
 * Route glue: run the pipeline and stream its events as SSE frames. Pure enough
 * to unit-test (a fake LLM in, an SSE byte stream out) so the Next route stays a
 * one-liner. Enqueues are guarded so a closed/cancelled stream never throws (E7),
 * and a fatal pipeline error becomes a terminal `error` SSE frame before close.
 */
export function pipelineToSSEStream(
  novelText: string,
  llm: Parameters<typeof convertScene>[3],
  options: OrchestratorOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let sawError = false;
      const safeEnqueue = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
        }
      };
      try {
        await runPipeline(novelText, llm, {
          ...options,
          onEvent: (e) => {
            if (e.type === "error") sawError = true;
            safeEnqueue(eventToSSE(e));
          },
        });
      } catch (err) {
        // FIX #4: runPipeline already emits a stage-specific error event before
        // throwing; only synthesize one here if it didn't (avoid duplicate frames).
        if (!sawError) {
          safeEnqueue(
            eventToSSE({ type: "error", stage: "assemble", message: (err as Error).message }),
          );
        }
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          closed = true;
        }
      }
    },
  });
}
