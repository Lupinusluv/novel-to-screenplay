/**
 * Gated real-LLM smoke test (R4/I6) — proves the curator's *prompts* actually
 * merge cross-chapter aliases against a real model, which fixtures cannot.
 *
 * Runs ONLY when `LLM_SMOKE=1` AND a usable LLM config (e.g. DEEPSEEK_API_KEY)
 * is present. Default `npm test` — even on a dev box where DEEPSEEK_API_KEY is
 * always exported — skips it, so the routine suite stays free, offline and
 * deterministic (PROJECT §8.1 "默认不烧 key"). Run deliberately with:
 *   LLM_SMOKE=1 npm test
 *
 * Targets are chosen from entities that actually appear in the *truncated*
 * first-3-回 sample: 林黛玉 (character alias merge), 榮國府/榮府 (location alias
 * merge — the R5 fix in action), and 寧國府 (must NOT be merged into 榮國府).
 * NB: 寶玉-the-person has not yet entered the novel within this truncation, so
 * he is intentionally not a target here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { chunkNovel } from "./chunker";
import {
  curateStoryBible,
  validateStoryBible,
  type StoryBible,
} from "./storyBible";
import { createLLMClient, loadLLMConfigFromEnv } from "../llm/client";

const RUN = !!process.env.LLM_SMOKE && !!process.env.DEEPSEEK_API_KEY;

/** Characters whose canonical name or aliases intersect any of `forms`. */
function charsMatching(bible: StoryBible, forms: string[]) {
  const want = new Set(forms);
  return bible.characters.filter((c) =>
    [c.name, ...c.aliases].some((s) => want.has(s)),
  );
}

/** Locations whose canonical name or aliases intersect any of `forms`. */
function locsMatching(bible: StoryBible, forms: string[]) {
  const want = new Set(forms);
  return bible.locations.filter((l) =>
    [l.name, ...l.aliases].some((s) => want.has(s)),
  );
}

const DAIYU_FORMS = ["黛玉", "林黛玉"];
const RONG_FORMS = ["榮國府", "荣国府", "榮府", "荣府"];
const NING_FORMS = ["寧國府", "宁国府"];
const RUHAI_FORMS = ["林如海", "林海", "如海"];

describe.runIf(RUN)("curateStoryBible · real-LLM smoke", () => {
  it(
    "merges 黛玉 and 榮國府 aliases without over-merging distinct entities",
    async () => {
      const raw = readFileSync("samples/honglou-meng-ch1-3.txt", "utf8");
      const { chapters } = chunkNovel(raw);
      expect(chapters.length).toBeGreaterThanOrEqual(3);

      const llm = createLLMClient(loadLLMConfigFromEnv());
      const bible = await curateStoryBible(chapters, llm);

      // Internally valid (ids unique/well-formed, alias hygiene, no collisions).
      expect(validateStoryBible(bible)).toEqual([]);

      // Character alias merge: 黛玉's surfaces collapse to ONE character.
      const daiyu = charsMatching(bible, DAIYU_FORMS);
      expect(daiyu).toHaveLength(1);
      expect(daiyu[0].aliases.length).toBeGreaterThanOrEqual(1);

      // Location alias merge (R5): 榮國府/榮府 collapse to ONE location.
      const rong = locsMatching(bible, RONG_FORMS);
      expect(rong).toHaveLength(1);
      expect(rong[0].aliases.length).toBeGreaterThanOrEqual(1);

      // Must NOT over-merge: 寧國府 is a different place than 榮國府.
      const ning = locsMatching(bible, NING_FORMS);
      if (ning.length) expect(ning[0].id).not.toBe(rong[0].id);

      // Must NOT over-merge: 林如海 (黛玉's father) is a different character.
      const ruhai = charsMatching(bible, RUHAI_FORMS);
      if (ruhai.length)
        expect(ruhai.some((r) => r.id === daiyu[0].id)).toBe(false);

      // Provenance points each merged entity at chapters it appears in.
      expect(bible.provenance[daiyu[0].id]?.length).toBeGreaterThanOrEqual(1);
      expect(bible.provenance[rong[0].id]?.length).toBeGreaterThanOrEqual(1);
    },
    180_000,
  );
});
