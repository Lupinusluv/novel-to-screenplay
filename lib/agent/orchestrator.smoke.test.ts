/**
 * Gated real-LLM smoke test (T23) — proves the whole pipeline runs end to end
 * against a real model: chunk → curate → per-scene convert/critic/retry →
 * assemble → SSE events → YAML. Fixtures cannot prove the four agents actually
 * cohere on real output.
 *
 * Runs ONLY when `LLM_SMOKE=1` AND a usable LLM config (e.g. DEEPSEEK_API_KEY)
 * is present. Default `npm test` skips it (PROJECT §8.1). Run with:
 *   LLM_SMOKE=1 npm test
 *
 * Reuses the existing 繁體 first-3-回 sample (E4: no corpus churn in PR6). That
 * truncated sample is dialogue-sparse, so we assert the *contract* (valid,
 * referentially-clean screenplay + ordered events + round-trippable YAML), not a
 * minimum dialogue count — same lesson the PR5 smoke learned.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runPipeline } from "./orchestrator";
import { validateScreenplay } from "./validator";
import { fromYAML } from "../schema/yaml";
import type { PipelineEvent } from "./events";
import { createLLMClient, loadLLMConfigFromEnv } from "../llm/client";

const RUN = !!process.env.LLM_SMOKE && !!process.env.DEEPSEEK_API_KEY;

describe.runIf(RUN)("runPipeline · real-LLM smoke", () => {
  it(
    "converts the 繁體 first-3-回 sample into a valid, gate-passing screenplay",
    async () => {
      const novel = readFileSync("samples/honglou-meng-ch1-3.txt", "utf8");
      const llm = createLLMClient(loadLLMConfigFromEnv());

      const events: PipelineEvent[] = [];
      // Keep the critic on (D2) but small budget to bound latency/spend.
      const sp = await runPipeline(novel, llm, {
        retryBudget: 1,
        onEvent: (e) => events.push(e),
      });

      // The deterministic gate (D3) accepts the output.
      const report = validateScreenplay(sp);
      expect(report.structural).toEqual([]);
      expect(report.references).toEqual([]);
      expect(report.duplicateSceneIds).toEqual([]);
      expect(sp.scenes.length).toBeGreaterThan(0);

      // Events: a final_result arrived and scenes-stage progress reached total.
      const fin = events.find((e) => e.type === "final_result");
      expect(fin).toBeDefined();
      const progress = events.filter(
        (e) => e.type === "stage_progress" && e.stage === "scenes",
      );
      const lastP = progress[progress.length - 1];
      expect(lastP.type === "stage_progress" && lastP.done === lastP.total).toBe(true);

      // YAML round-trips back to the same scene count.
      if (fin && fin.type === "final_result") {
        expect(fromYAML(fin.yaml).scenes).toHaveLength(sp.scenes.length);
      }
    },
    300_000,
  );
});
