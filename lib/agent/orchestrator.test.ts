import { describe, it, expect } from "vitest";
import { runPipeline, pipelineToSSEStream } from "./orchestrator";
import { validateScreenplay } from "./validator";
import type { PipelineEvent } from "./events";
import { fromYAML } from "../schema/yaml";
import type { ChatMessage, LLMClient } from "../llm/client";

// A two-chapter novel that chunks to one scene candidate per chapter (total 2).
const NOVEL = `第一回 初见
甲对乙说了一句话。乙也回了话。丙在旁边看着。

第二回 再会
丁来了，戊走了。`;

// Bible the fake curator produces (same entities each chapter ⇒ provenance spans
// both chapters, so any scene resolves). Ids come out char_jiamu / loc_rongguofu.
const MAP_ENTITIES = {
  characters: [
    { name: "贾母", aliases: ["老太太"], romanization: "jiamu" },
    { name: "林黛玉", aliases: ["黛玉"], romanization: "daiyu" },
  ],
  locations: [{ name: "荣国府", aliases: [], romanization: "rongguofu" }],
};

function cleanRaw(tag = ""): unknown {
  return {
    heading: { int_ext: "INT", location: "荣国府", time_of_day: "DAY" },
    synopsis: `测试场景${tag}`,
    elements: [{ type: "dialogue", speaker: "贾母", line: "可怜我的儿！" }],
  };
}
function unresolvedRaw(tag = ""): unknown {
  return {
    heading: { int_ext: "INT", location: "荣国府", time_of_day: "DAY" },
    synopsis: `测试场景${tag}`,
    elements: [{ type: "dialogue", speaker: "焦大", line: "祖宗造的孽！" }],
  };
}

interface FakeCfg {
  /** raw scene per scene-call (1-based index, also gets the user text). */
  scene?: (n: number, userText: string) => unknown | Promise<unknown>;
  /** raw critique per critique-call. Default {issues:[]} (clean). */
  critique?: (n: number, userText: string) => unknown | Promise<unknown>;
}
interface Counts {
  map: number;
  reduce: number;
  scene: number;
  critique: number;
}

function fakeLLM(cfg: FakeCfg = {}): { llm: LLMClient; counts: Counts } {
  const counts: Counts = { map: 0, reduce: 0, scene: 0, critique: 0 };
  const llm: LLMClient = {
    chat: async () => "",
    chatJSON: async <T = unknown>(messages: ChatMessage[]) => {
      const text = messages.map((m) => m.content).join("\n");
      if (text.includes("逐章实体表")) {
        counts.reduce++;
        return MAP_ENTITIES as T;
      }
      if (text.includes("本章原文")) {
        counts.map++;
        return MAP_ENTITIES as T;
      }
      if (text.includes("已转换场景")) {
        counts.critique++;
        const r = cfg.critique
          ? await cfg.critique(counts.critique, text)
          : { issues: [] };
        return r as T;
      }
      counts.scene++;
      const r = cfg.scene ? await cfg.scene(counts.scene, text) : cleanRaw();
      return r as T;
    },
  };
  return { llm, counts };
}

describe("runPipeline (orchestrator: wiring + self-correction + events)", () => {
  it("T12 — happy path: end-to-end produces a valid, referentially-clean Screenplay", async () => {
    const { llm, counts } = fakeLLM();
    const sp = await runPipeline(NOVEL, llm, { critic: false });

    expect(sp.scenes).toHaveLength(2);
    expect(sp.scenes.map((s) => s.id)).toEqual(["scene_1_1", "scene_2_1"]);
    expect(sp.title.length).toBeGreaterThan(0);
    expect(sp.logline.length).toBeGreaterThan(0);
    expect(sp.characters.length).toBeGreaterThan(0);
    // refs clean: every dialogue/heading id is a real bible id
    const charIds = new Set(sp.characters.map((c) => c.id));
    const locIds = new Set(sp.locations.map((l) => l.id));
    for (const s of sp.scenes) {
      expect(locIds.has(s.heading.location_id)).toBe(true);
      for (const el of s.elements)
        if (el.type === "dialogue") expect(charIds.has(el.character_id)).toBe(true);
    }
    expect(counts.map).toBe(2);
    expect(counts.reduce).toBe(1);
    expect(counts.scene).toBe(2);
    expect(counts.critique).toBe(0); // critic disabled

    // The whole-screenplay gate (D3) passes the orchestrator's output.
    const report = validateScreenplay(sp);
    expect(report.ok).toBe(true);
    expect(report.duplicateSceneIds).toEqual([]);
  });

  it("T15 — emits stages in order with a per-scene progress counter", async () => {
    const events: PipelineEvent[] = [];
    const { llm } = fakeLLM();
    await runPipeline(NOVEL, llm, { critic: false, onEvent: (e) => events.push(e) });

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("stage_start");
    expect(types[types.length - 1]).toBe("final_result");

    // scenes stage opens with a total, progress counts to total
    const start = events.find((e) => e.type === "stage_start" && e.stage === "scenes");
    expect(start && "total" in start && start.total).toBe(2);
    const progress = events.filter((e) => e.type === "stage_progress" && e.stage === "scenes");
    expect(progress.map((p) => (p.type === "stage_progress" ? p.done : 0))).toEqual([1, 2]);
    const last = progress[progress.length - 1];
    expect(last.type === "stage_progress" && last.done === last.total).toBe(true);

    // per completed scene: partial_result precedes its stage_progress (E6)
    const idxPartial = events.findIndex((e) => e.type === "partial_result");
    const idxProgress = events.findIndex((e) => e.type === "stage_progress" && e.stage === "scenes");
    expect(idxPartial).toBeLessThan(idxProgress);
  });

  it("T22 — final_result carries the screenplay + round-trippable YAML (E10)", async () => {
    const events: PipelineEvent[] = [];
    const { llm } = fakeLLM();
    const sp = await runPipeline(NOVEL, llm, { critic: false, onEvent: (e) => events.push(e) });
    const fin = events.find((e) => e.type === "final_result");
    expect(fin).toBeDefined();
    if (fin && fin.type === "final_result") {
      expect(fin.screenplay.scenes).toHaveLength(2);
      expect(fromYAML(fin.yaml).scenes).toHaveLength(2);
      expect(fin.screenplay).toEqual(sp);
    }
  });

  it("T17 — parallel completion does not scramble scene order (E5b)", async () => {
    // Make chapter-1's scene resolve LAST by delaying it; order must still hold.
    const { llm } = fakeLLM({
      scene: async (_n, userText) => {
        if (userText.includes("甲")) await new Promise((r) => setTimeout(r, 20));
        return cleanRaw();
      },
    });
    const sp = await runPipeline(NOVEL, llm, { critic: false, concurrency: 4 });
    expect(sp.scenes.map((s) => s.id)).toEqual(["scene_1_1", "scene_2_1"]);
  });

  it("T13 — deterministic arm: residual issue retries to budget then needs_review", async () => {
    // Distinct unresolved scene each call ⇒ no fixed-point ⇒ full budget burned.
    const { llm, counts } = fakeLLM({
      scene: (n) => unresolvedRaw(String(n)),
    });
    const sp = await runPipeline(NOVEL, llm, { critic: false, retryBudget: 2 });
    // 2 scenes × (1 initial + 2 retries) = 6 convert calls
    expect(counts.scene).toBe(6);
    expect(sp.scenes.every((s) => s.needs_review === true)).toBe(true);
  });

  it("T19 — deterministic arm: identical retry stops early at the fixed point (E3)", async () => {
    // Same unresolved scene every call ⇒ fixed point after the first retry.
    const { llm, counts } = fakeLLM({ scene: () => unresolvedRaw("same") });
    const sp = await runPipeline(NOVEL, llm, { critic: false, retryBudget: 2 });
    // 2 scenes × (1 initial + 1 retry that matches → stop) = 4 convert calls
    expect(counts.scene).toBe(4);
    expect(sp.scenes.every((s) => s.needs_review === true)).toBe(true);
  });

  it("T14 — semantic arm: persistent major critique retries then sets needs_review", async () => {
    // Clean conversion (distinct each call so no cycle), critic always major.
    const { llm, counts } = fakeLLM({
      scene: (n) => cleanRaw(String(n)),
      critique: () => ({
        issues: [{ severity: "major", category: "fidelity", detail: "漏对白", suggestion: "补回" }],
      }),
    });
    const sp = await runPipeline(NOVEL, llm, { retryBudget: 2 });
    expect(sp.scenes.every((s) => s.needs_review === true)).toBe(true);
    // per scene: critique called > 1 (initial + retries)
    expect(counts.critique).toBeGreaterThan(2);
  });

  it("T20 — semantic arm: an oscillation cycle is detected and broken (E5)", async () => {
    // Identical clean scene every call + always-major critique ⇒ cycle on first
    // semantic retry ⇒ break (do not burn full budget).
    const { llm, counts } = fakeLLM({
      scene: () => cleanRaw("fixed"),
      critique: () => ({
        issues: [{ severity: "major", category: "fidelity", detail: "x", suggestion: "y" }],
      }),
    });
    const sp = await runPipeline(NOVEL, llm, { retryBudget: 2 });
    expect(sp.scenes.every((s) => s.needs_review === true)).toBe(true);
    // cycle break: only the initial critique per scene (2), no re-critique
    expect(counts.critique).toBe(2);
  });

  it("T16 — criticScope 'needs_review' skips Critic on clean scenes", async () => {
    const { llm, counts } = fakeLLM(); // clean scenes, clean critique
    await runPipeline(NOVEL, llm, { critic: true, criticScope: "needs_review" });
    expect(counts.scene).toBe(2);
    expect(counts.critique).toBe(0); // clean scenes are not flagged ⇒ skipped
  });

  it("T18 — structural throw retries then inserts a placeholder + emits error (E2)", async () => {
    const events: PipelineEvent[] = [];
    // Every scene call returns malformed JSON-able garbage (bad enum) ⇒ throw.
    const { llm } = fakeLLM({
      scene: () => ({ heading: { int_ext: "MID", location: "荣国府", time_of_day: "DAY" }, synopsis: "x", elements: [] }),
    });
    const sp = await runPipeline(NOVEL, llm, {
      critic: false,
      retryBudget: 1,
      onEvent: (e) => events.push(e),
    });
    // Pipeline still completes with placeholder scenes, all flagged.
    expect(sp.scenes).toHaveLength(2);
    expect(sp.scenes.every((s) => s.needs_review === true)).toBe(true);
    expect(events.some((e) => e.type === "error" && e.stage === "scenes")).toBe(true);
  });

  it("T21 — a pre-aborted signal stops the run before any LLM call (E7)", async () => {
    const { llm, counts } = fakeLLM();
    const ac = new AbortController();
    ac.abort();
    await expect(runPipeline(NOVEL, llm, { signal: ac.signal })).rejects.toThrow();
    expect(counts.map).toBe(0);
    expect(counts.scene).toBe(0);
  });
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe("pipelineToSSEStream (route glue: events → SSE frames)", () => {
  it("streams typed SSE frames and ends with final_result", async () => {
    const { llm } = fakeLLM();
    const text = await readAll(pipelineToSSEStream(NOVEL, llm, { critic: false }));
    expect(text).toContain("event: stage_start\n");
    expect(text).toContain("event: final_result\n");
    expect(text.trim().endsWith("}")).toBe(true); // last frame is JSON data
  });

  it("turns a fatal pipeline error into an SSE error frame and closes cleanly", async () => {
    // Fake whose map stage throws ⇒ curate fails ⇒ fatal.
    const llm: LLMClient = {
      chat: async () => "",
      chatJSON: async () => {
        throw new Error("boom");
      },
    };
    const text = await readAll(pipelineToSSEStream(NOVEL, llm));
    expect(text).toContain("event: error\n");
    expect(text).toContain("boom");
  });
});
