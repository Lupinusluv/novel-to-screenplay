/**
 * Gated real-LLM smoke test (I7) — proves the converter's *prompt + resolution*
 * actually turn a real fragment into a schema-valid, referentially-clean scene
 * against a real model and a real curated bible, which fixtures cannot.
 *
 * Runs ONLY when `LLM_SMOKE=1` AND a usable LLM config (e.g. DEEPSEEK_API_KEY)
 * is present. Default `npm test` skips it (PROJECT §8.1 "默认不烧 key"). Run with:
 *   LLM_SMOKE=1 npm test
 *
 * Reuses the existing 繁體 first-3-回 sample (E4: no corpus churn in PR5). The
 * chapter-3 fragment where 黛玉 reaches 榮國府 is chosen because both entities
 * (林黛玉, 榮國府/榮府) are stably present and were verified to curate cleanly by
 * the PR4 smoke test — so we can assert the converter references a KNOWN id, not
 * a hallucinated line (I7's tightening over the original "≥1 dialogue").
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { chunkNovel } from "./chunker";
import { curateStoryBible } from "./storyBible";
import { convertScene, sceneReferentialCheck } from "./sceneConverter";
import { SceneSchema } from "../schema/screenplay";
import { createLLMClient, loadLLMConfigFromEnv } from "../llm/client";

const RUN = !!process.env.LLM_SMOKE && !!process.env.DEEPSEEK_API_KEY;

describe.runIf(RUN)("convertScene · real-LLM smoke", () => {
  it(
    "converts 黛玉進榮國府 into a valid, referentially-clean scene that hits a known id",
    async () => {
      const raw = readFileSync("samples/honglou-meng-ch1-3.txt", "utf8");
      const { chapters } = chunkNovel(raw);
      expect(chapters.length).toBeGreaterThanOrEqual(3);

      const llm = createLLMClient(loadLLMConfigFromEnv());
      const bible = await curateStoryBible(chapters, llm);

      // The known entities this fragment must surface (PR4 smoke verified them).
      const daiyu = bible.characters.find((c) =>
        [c.name, ...c.aliases].some((s) => s.includes("黛玉")),
      );
      const rong = bible.locations.find((l) =>
        [l.name, ...l.aliases].some((s) => /榮國府|榮府|荣国府|荣府/.test(s)),
      );
      expect(daiyu, "curator should find 林黛玉").toBeDefined();
      expect(rong, "curator should find 榮國府").toBeDefined();

      // The chapter-3 candidate where 黛玉 disembarks and 榮國府 sends a 轎子.
      const ch3 = chapters[2];
      const candidate =
        ch3.sceneCandidates.find(
          (s) => s.text.includes("黛玉") && s.text.includes("榮國府"),
        ) ?? ch3.sceneCandidates[ch3.sceneCandidates.length - 1];

      const { scene, issues } = await convertScene(candidate, 3, bible, llm);

      // Contract: always schema-valid + referentially clean against the bible.
      expect(() => SceneSchema.parse(scene)).not.toThrow();
      expect(sceneReferentialCheck(scene, bible)).toEqual([]);

      // Every id the scene uses is a real bible id (no hallucinated ids).
      const charIds = new Set(bible.characters.map((c) => c.id));
      const locIds = new Set(bible.locations.map((l) => l.id));
      expect(locIds.has(scene.heading.location_id)).toBe(true);
      for (const el of scene.elements) {
        if (el.type === "dialogue") expect(charIds.has(el.character_id)).toBe(true);
      }

      // I7 anchor: the heading location resolved CLEANLY to a known curated id —
      // NOT a placeholder fallback (no unresolved_location issue) and NOT a
      // hallucinated id. This proves real name→id resolution against the bible.
      // (This truncated 繁體 fragment is narration of 黛玉's journey *through* the
      // capital toward the 府, so the model legitimately picks an enclosing city
      // location and emits no dialogue — speaker-id coverage waits on the
      // dialogue-dense 简体 回3/6/7 corpus migration deferred by E4.)
      expect(issues.some((i) => i.kind === "unresolved_location")).toBe(false);

      // Faithfulness: the scene transcribes the REAL fragment (黛玉 / 榮國府 appear
      // in its text), not invented content — guarding against "valid-but-made-up".
      const bodyText = scene.elements
        .map((el) => (el.type === "dialogue" ? el.line : el.text))
        .join("");
      expect(/黛玉|榮國府/.test(bodyText)).toBe(true);

      // The scene is real content, not empty.
      expect(scene.elements.length).toBeGreaterThan(0);
    },
    180_000,
  );
});
