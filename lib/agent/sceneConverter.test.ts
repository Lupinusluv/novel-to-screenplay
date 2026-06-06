import { describe, it, expect } from "vitest";
import {
  RawSceneSchema,
  coerceRawScene,
  buildResolver,
  resolveSurface,
  normalizeSurface,
  scopeCast,
  dominantLocation,
  assembleScene,
  capSceneBody,
  sceneReferentialCheck,
  convertScene,
  SCENE_BODY_CAP,
  SCENE_EXCERPT_CAP,
} from "./sceneConverter";
import type { StoryBible } from "./storyBible";
import type { SceneCandidate } from "./chunker";
import type { Element, SceneHeading } from "../schema/screenplay";
import type { ChatMessage, ChatOptions, LLMClient } from "../llm/client";

// ===========================================================================
// T1 — middle-layer zod (RawSceneSchema) + coerce (E3)
// The LLM speaks in NAMES (location, speaker), never ids. RawSceneSchema is the
// shape contract; coerceRawScene strips safely-droppable noise BEFORE strict
// validation, throwing only on real ambiguous garbage (D6/E3).
// ===========================================================================

/** A minimal raw scene as the LLM is asked to emit it (names, not ids). */
function rawScene(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    heading: { int_ext: "INT", location: "荣国府", time_of_day: "DAY" },
    synopsis: "黛玉初入荣国府，拜见贾母。",
    elements: [
      { type: "action", text: "黛玉下了轿。" },
      { type: "dialogue", speaker: "贾母", line: "可怜我的儿！" },
      { type: "transition", text: "CUT TO:" },
    ],
    ...over,
  };
}

describe("RawSceneSchema (middle-layer LLM output contract)", () => {
  it("parses a valid raw scene whose refs are NAMES, not ids", () => {
    const parsed = RawSceneSchema.parse(rawScene());
    expect(parsed.heading.location).toBe("荣国府");
    const dlg = parsed.elements.find((e) => e.type === "dialogue");
    expect(dlg && "speaker" in dlg && dlg.speaker).toBe("贾母");
  });

  it("rejects a bad time_of_day enum (structural garbage → throw, D6)", () => {
    expect(
      RawSceneSchema.safeParse(
        rawScene({ heading: { int_ext: "INT", location: "荣国府", time_of_day: "中午" } }),
      ).success,
    ).toBe(false);
  });

  it("rejects a dialogue element missing its required line", () => {
    expect(
      RawSceneSchema.safeParse(
        rawScene({ elements: [{ type: "dialogue", speaker: "贾母" }] }),
      ).success,
    ).toBe(false);
  });

  it("rejects unknown top-of-element keys via the strict element shape", () => {
    expect(
      RawSceneSchema.safeParse(
        rawScene({ elements: [{ type: "action", text: "x", speaker: "贾母" }] }),
      ).success,
    ).toBe(false);
  });

  it("allows an empty elements array (I11: no .min(1); emptiness is a business signal)", () => {
    const parsed = RawSceneSchema.parse(rawScene({ elements: [] }));
    expect(parsed.elements).toEqual([]);
  });
});

describe("coerceRawScene (E3: strip safe noise before strict, throw on real garbage)", () => {
  it("drops a stray `text` on a dialogue and a stray `speaker` on an action, counting drops", () => {
    const { scene, dropped } = coerceRawScene(
      rawScene({
        elements: [
          { type: "action", text: "黛玉下了轿。", speaker: "黛玉" },
          { type: "dialogue", speaker: "贾母", line: "可怜我的儿！", text: "noise" },
        ],
      }),
    );
    expect(dropped).toBe(2);
    const action = scene.elements[0];
    const dialogue = scene.elements[1];
    expect(action).toEqual({ type: "action", text: "黛玉下了轿。" });
    expect(dialogue).toEqual({ type: "dialogue", speaker: "贾母", line: "可怜我的儿！" });
  });

  it("passes a clean scene through with zero drops", () => {
    const { scene, dropped } = coerceRawScene(rawScene());
    expect(dropped).toBe(0);
    expect(scene.elements).toHaveLength(3);
  });

  it("still throws on real garbage a strip cannot fix (bad enum)", () => {
    expect(() =>
      coerceRawScene(
        rawScene({ heading: { int_ext: "INT", location: "荣国府", time_of_day: "中午" } }),
      ),
    ).toThrow();
  });

  it("still throws when a required field is missing (dialogue without line)", () => {
    expect(() =>
      coerceRawScene(rawScene({ elements: [{ type: "dialogue", speaker: "贾母" }] })),
    ).toThrow();
  });

  it("allows an empty elements array through (emptiness handled downstream, not here)", () => {
    const { scene, dropped } = coerceRawScene(rawScene({ elements: [] }));
    expect(dropped).toBe(0);
    expect(scene.elements).toEqual([]);
  });

  it("counts and drops unknown top-level keys instead of throwing", () => {
    const { scene, dropped } = coerceRawScene(rawScene({ title: "noise" }));
    expect(dropped).toBe(1);
    expect(scene.synopsis).toBe("黛玉初入荣国府，拜见贾母。");
  });
});

// ===========================================================================
// T2 — buildResolver (I2) + normalization (I3) + E2 three-tier resolution
// LLM emits names; code resolves name→id over the FULL bible. Aliases resolve
// natively; normalization absorbs full/half-width, quotes, trailing speech
// verbs; genuine multi-entity collisions are resolved by a deterministic tier
// ladder (name>alias, scoped>cross-chapter, then min code-point id) AND flagged.
// ===========================================================================

const CHARS = [
  { id: "char_baoyu", name: "贾宝玉", aliases: ["宝玉", "宝二爷"] },
  { id: "char_jiamu", name: "贾母", aliases: ["老太太"] },
  { id: "char_daiyu", name: "林黛玉", aliases: ["黛玉"] },
];

describe("normalizeSurface (I3 normalization boundary)", () => {
  it("trims and collapses full-width / ASCII whitespace", () => {
    expect(normalizeSurface("　贾母 ")).toBe("贾母");
  });

  it("strips Chinese quote marks", () => {
    expect(normalizeSurface("「宝二爷」")).toBe("宝二爷");
  });

  it("strips a trailing speech verb (道) so 宝玉道 → 宝玉", () => {
    expect(normalizeSurface("宝玉道")).toBe("宝玉");
  });

  it("strips a multi-char trailing speech verb (笑道) and a trailing colon", () => {
    expect(normalizeSurface("贾母笑道：")).toBe("贾母");
  });
});

describe("buildResolver + resolveSurface (name→id, E2 ladder)", () => {
  it("resolves a canonical name to its id (matchedBy name)", () => {
    const r = buildResolver(CHARS);
    expect(resolveSurface(r, "贾母")).toMatchObject({
      id: "char_jiamu",
      matchedBy: "name",
    });
  });

  it("resolves an alias to the canonical id (宝二爷 → char_baoyu) — demo ammo", () => {
    const r = buildResolver(CHARS);
    expect(resolveSurface(r, "宝二爷")).toMatchObject({
      id: "char_baoyu",
      matchedBy: "alias",
    });
  });

  it("resolves through normalization (full-width space + speech verb)", () => {
    const r = buildResolver(CHARS);
    expect(resolveSurface(r, "　宝玉道")).toMatchObject({ id: "char_baoyu" });
  });

  it("returns id null for a surface absent from the bible (unresolved)", () => {
    const r = buildResolver(CHARS);
    expect(resolveSurface(r, "焦大").id).toBeNull();
  });

  it("E2 tier 1: a canonical-name match beats an alias-only match, and flags ambiguity", () => {
    // 玉儿 is char_A's canonical name but char_B's alias → name wins.
    const r = buildResolver([
      { id: "char_a", name: "玉儿", aliases: [] },
      { id: "char_b", name: "甄宝玉", aliases: ["玉儿"] },
    ]);
    const res = resolveSurface(r, "玉儿");
    expect(res.id).toBe("char_a");
    expect(res.ambiguous).toBe(true);
    expect(res.candidates).toEqual(["char_a", "char_b"].sort());
  });

  it("E2 tier 2: among alias matches, a scoped candidate beats a cross-chapter one", () => {
    // Both match 凤 by alias; only char_x is scoped to this chapter.
    const r = buildResolver(
      [
        { id: "char_x", name: "王熙凤", aliases: ["凤"] },
        { id: "char_y", name: "凤姐儿", aliases: ["凤"] },
      ],
      new Set(["char_x"]),
    );
    const res = resolveSurface(r, "凤");
    expect(res.id).toBe("char_x");
    expect(res.ambiguous).toBe(true);
  });

  it("E2 tier 3: a true tie falls to the smallest code-point id", () => {
    const r = buildResolver([
      { id: "char_b", name: "同名", aliases: [] },
      { id: "char_a", name: "同名", aliases: [] },
    ]);
    expect(resolveSurface(r, "同名").id).toBe("char_a");
  });

  it("is NOT ambiguous when one entity matches by both its name and an alias", () => {
    const r = buildResolver([{ id: "char_z", name: "重名", aliases: ["重名"] }]);
    const res = resolveSurface(r, "重名");
    expect(res.id).toBe("char_z");
    expect(res.ambiguous).toBeFalsy();
  });
});

// ===========================================================================
// T3 — scopeCast (provenance scoping + full-bible fallback) +
// dominantLocation (E1: honest, neutral fallback = smallest-id scoped location,
// NOT the umbrella "most frequent" place which would manufacture a structurally
// valid semantic lie).
// ===========================================================================

function bible(over: Partial<StoryBible> = {}): StoryBible {
  return {
    characters: [
      { id: "char_jiamu", name: "贾母", aliases: ["老太太"] },
      { id: "char_daiyu", name: "林黛玉", aliases: ["黛玉"] },
      { id: "char_liu", name: "刘姥姥", aliases: [] },
    ],
    locations: [
      { id: "loc_rongguofu", name: "荣国府", aliases: ["荣府"] }, // umbrella
      { id: "loc_bixiaguan", name: "碧纱橱", aliases: [] },
    ],
    provenance: {
      char_jiamu: [3, 6, 7],
      char_daiyu: [3],
      char_liu: [6],
      loc_rongguofu: [3, 6, 7],
      loc_bixiaguan: [3],
    },
    ...over,
  };
}

describe("scopeCast (provenance scoping + fallback)", () => {
  it("keeps only entities whose provenance includes the chapter", () => {
    const cast = scopeCast(bible(), 6);
    expect(cast.characters.map((c) => c.id).sort()).toEqual([
      "char_jiamu",
      "char_liu",
    ]);
    expect(cast.locations.map((l) => l.id)).toEqual(["loc_rongguofu"]);
  });

  it("falls back to the full table when a chapter scopes nothing", () => {
    // Chapter 99 appears in no provenance entry → both tables fall back.
    const cast = scopeCast(bible(), 99);
    expect(cast.characters).toHaveLength(3);
    expect(cast.locations).toHaveLength(2);
  });

  it("falls back per-table independently (chars scoped, locs empty → all locs)", () => {
    const b = bible({
      provenance: {
        char_daiyu: [3],
        loc_rongguofu: [6], // no location scoped to chapter 3
        loc_bixiaguan: [6],
      },
    });
    const cast = scopeCast(b, 3);
    expect(cast.characters.map((c) => c.id)).toEqual(["char_daiyu"]);
    expect(cast.locations).toHaveLength(2); // fell back to all
  });
});

describe("dominantLocation (E1: smallest-id scoped location, no umbrella bias)", () => {
  it("picks the smallest code-point scoped id, NOT the most frequent place", () => {
    // Both scoped to ch3; loc_bixiaguan < loc_rongguofu, so the umbrella loses.
    expect(dominantLocation(bible(), 3)).toBe("loc_bixiaguan");
  });

  it("falls back to the full bible (same smallest-id rule) when chapter scopes no location", () => {
    expect(dominantLocation(bible(), 99)).toBe("loc_bixiaguan");
  });

  it("throws when the whole bible has no location at all (Curator's responsibility)", () => {
    const b = bible({ locations: [], provenance: { char_daiyu: [3] } });
    expect(() => dominantLocation(b, 3)).toThrow();
  });
});

// ===========================================================================
// T4 — assembleScene (deterministic code owns scene id + source/excerpt),
// capSceneBody (E6 truncation guard), sceneReferentialCheck (I4 defensive).
// ===========================================================================

const HEADING: SceneHeading = {
  int_ext: "INT",
  location_id: "loc_rongguofu",
  time_of_day: "DAY",
};
const ELEMENTS: Element[] = [
  { type: "action", text: "黛玉下了轿。" },
  { type: "dialogue", character_id: "char_jiamu", line: "可怜我的儿！" },
];
function candidate(over: Partial<SceneCandidate> = {}): SceneCandidate {
  return { index: 0, text: "黛玉初入荣国府，拜见贾母。", ...over };
}

describe("assembleScene (deterministic id + source provenance, I10/D2)", () => {
  it("builds the scene id as scene_<chapter>_<candidate.index + 1>", () => {
    const scene = assembleScene({
      chapter: 3,
      candidate: candidate({ index: 0 }),
      heading: HEADING,
      elements: ELEMENTS,
      synopsis: "黛玉拜见贾母。",
      issues: [],
    });
    expect(scene.id).toBe("scene_3_1");
  });

  it("derives source.chapter + a head-truncated excerpt deterministically", () => {
    const long = "甲".repeat(SCENE_EXCERPT_CAP + 50);
    const scene = assembleScene({
      chapter: 6,
      candidate: candidate({ index: 2, text: long }),
      heading: HEADING,
      elements: ELEMENTS,
      synopsis: "刘姥姥进荣国府。",
      issues: [],
    });
    expect(scene.id).toBe("scene_6_3");
    expect(scene.source.chapter).toBe(6);
    expect(scene.source.excerpt.length).toBeLessThanOrEqual(SCENE_EXCERPT_CAP + 1);
    expect(scene.source.excerpt.startsWith("甲")).toBe(true);
  });

  it("leaves needs_review unset when there are no issues and elements is non-empty", () => {
    const scene = assembleScene({
      chapter: 3,
      candidate: candidate(),
      heading: HEADING,
      elements: ELEMENTS,
      synopsis: "x",
      issues: [],
    });
    expect(scene.needs_review).toBeUndefined();
  });

  it("sets needs_review when any issue is present", () => {
    const scene = assembleScene({
      chapter: 3,
      candidate: candidate(),
      heading: HEADING,
      elements: ELEMENTS,
      synopsis: "x",
      issues: [
        { kind: "unresolved_character", surface: "焦大", where: "elements[0].speaker", resolution: "demoted to action" },
      ],
    });
    expect(scene.needs_review).toBe(true);
  });

  it("sets needs_review when elements is empty, even with no issues (I11)", () => {
    const scene = assembleScene({
      chapter: 3,
      candidate: candidate(),
      heading: HEADING,
      elements: [],
      synopsis: "x",
      issues: [],
    });
    expect(scene.needs_review).toBe(true);
  });
});

describe("capSceneBody (E6 truncation guard before the LLM)", () => {
  it("passes a short body through untruncated", () => {
    const { body, truncated } = capSceneBody("短场景");
    expect(truncated).toBe(false);
    expect(body).toBe("短场景");
  });

  it("truncates a body over SCENE_BODY_CAP and appends a marker", () => {
    const big = "字".repeat(SCENE_BODY_CAP + 100);
    const { body, truncated } = capSceneBody(big);
    expect(truncated).toBe(true);
    expect(body.length).toBeLessThan(big.length);
    expect(body).toContain("截断");
  });
});

describe("sceneReferentialCheck (I4 defensive self-check)", () => {
  it("returns no issues for a scene whose refs all resolve to the bible", () => {
    const scene = assembleScene({
      chapter: 3,
      candidate: candidate(),
      heading: HEADING,
      elements: ELEMENTS,
      synopsis: "x",
      issues: [],
    });
    expect(sceneReferentialCheck(scene, bible())).toEqual([]);
  });

  it("DOES surface a dangling reference (proves the check is wired, not vacuous)", () => {
    const scene = assembleScene({
      chapter: 3,
      candidate: candidate(),
      heading: { int_ext: "INT", location_id: "loc_ghost", time_of_day: "DAY" },
      elements: ELEMENTS,
      synopsis: "x",
      issues: [],
    });
    expect(sceneReferentialCheck(scene, bible()).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// T5 — convertScene orchestration. A content-keyed stub (PR4 I7) returns the
// raw scene; the pipeline resolves names→ids over the FULL bible, demotes /
// falls back / flags per E1–E6, and ALWAYS returns a schema-valid, referentially
// clean scene. Covers §7 + the review GAP branches.
// ===========================================================================

interface Call {
  messages: ChatMessage[];
  opts?: ChatOptions;
}

const RAW_CLEAN = {
  heading: { int_ext: "INT", location: "荣国府", time_of_day: "DAY" },
  synopsis: "黛玉初入荣国府，拜见贾母。",
  elements: [
    { type: "action", text: "黛玉下了轿，众人迎接。" },
    { type: "dialogue", speaker: "贾母", line: "可怜我的儿！" },
    { type: "dialogue", speaker: "黛玉", line: "外祖母安好。" },
  ],
};

/** A stub whose single chatJSON call returns `raw` (or throws if it's an Error). */
function sceneStub(raw: unknown): { llm: LLMClient; calls: Call[] } {
  const calls: Call[] = [];
  const llm: LLMClient = {
    chat: async () => "",
    chatJSON: async <T = unknown>(messages: ChatMessage[], opts?: ChatOptions) => {
      calls.push({ messages, opts });
      if (raw instanceof Error) throw raw;
      return raw as T;
    },
  };
  return { llm, calls };
}

function userText(calls: Call[]): string {
  return calls[0].messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
}

describe("convertScene (orchestration)", () => {
  it("cleanly resolves a scene: ids assigned, issues empty, needs_review unset, refs clean", async () => {
    const { llm, calls } = sceneStub(RAW_CLEAN);
    const { scene, issues } = await convertScene(candidate(), 3, bible(), llm);

    expect(scene.heading.location_id).toBe("loc_rongguofu");
    const dlg = scene.elements.filter((e) => e.type === "dialogue");
    expect(dlg.map((d) => d.character_id).sort()).toEqual(["char_daiyu", "char_jiamu"]);
    expect(issues).toEqual([]);
    expect(scene.needs_review).toBeUndefined();
    expect(scene.id).toBe("scene_3_1");

    // Always referentially clean against the bible (defensive invariant).
    expect(sceneReferentialCheck(scene, bible())).toEqual([]);
    // temperature pinned to 0 (降方差).
    expect(calls[0].opts?.temperature).toBe(0);
  });

  it("resolves an alias speaker (老太太 → char_jiamu) with no issue", async () => {
    const raw = {
      ...RAW_CLEAN,
      elements: [{ type: "dialogue", speaker: "老太太", line: "可怜我的儿！" }],
    };
    const { llm } = sceneStub(raw);
    const { scene, issues } = await convertScene(candidate(), 3, bible(), llm);
    const dlg = scene.elements[0];
    expect(dlg.type === "dialogue" && dlg.character_id).toBe("char_jiamu");
    expect(issues).toEqual([]);
  });

  it("demotes an unresolved speaker to action wrapped in 「」 (E5) + issue + needs_review", async () => {
    const raw = {
      ...RAW_CLEAN,
      elements: [{ type: "dialogue", speaker: "焦大", line: "祖宗造的孽！" }],
    };
    const { llm } = sceneStub(raw);
    const { scene, issues } = await convertScene(candidate(), 3, bible(), llm);

    const el = scene.elements[0];
    expect(el.type).toBe("action");
    expect(el.type === "action" && el.text).toBe("「祖宗造的孽！」");
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: "unresolved_character", surface: "焦大", where: "elements[0].speaker" }),
    );
    expect(scene.needs_review).toBe(true);
  });

  it("falls back an unresolved location to the placeholder dominant id (E1) + flags it unverified", async () => {
    const raw = { ...RAW_CLEAN, heading: { int_ext: "INT", location: "大观园", time_of_day: "DAY" } };
    const { llm } = sceneStub(raw);
    const { scene, issues } = await convertScene(candidate(), 3, bible(), llm);

    expect(scene.heading.location_id).toBe("loc_bixiaguan"); // smallest-id scoped, not umbrella
    const loc = issues.find((i) => i.kind === "unresolved_location");
    expect(loc).toMatchObject({ surface: "大观园", where: "heading.location" });
    expect(loc!.resolution).toMatch(/placeholder|unverified/i);
    expect(scene.needs_review).toBe(true);
  });

  it("flags an ambiguous speaker, still picks the tier winner, sets needs_review (E2)", async () => {
    const ambig = bible({
      characters: [
        { id: "char_x", name: "王熙凤", aliases: ["凤姐"] },
        { id: "char_y", name: "琏二奶奶", aliases: ["凤姐"] },
      ],
      provenance: {
        char_x: [3],
        char_y: [3],
        loc_rongguofu: [3],
        loc_bixiaguan: [3],
      },
    });
    const raw = {
      ...RAW_CLEAN,
      elements: [{ type: "dialogue", speaker: "凤姐", line: "我来迟了！" }],
    };
    const { llm } = sceneStub(raw);
    const { scene, issues } = await convertScene(candidate(), 3, ambig, llm);

    const dlg = scene.elements[0];
    expect(dlg.type === "dialogue" && dlg.character_id).toBe("char_x"); // min code-point id
    const amb = issues.find((i) => i.kind === "ambiguous_reference");
    expect(amb?.candidates).toEqual(["char_x", "char_y"]);
    expect(scene.needs_review).toBe(true);
  });

  it("resolves a cross-chapter reference via the full bible — scoping is focus, not constraint (I6)", async () => {
    // Chapter 6 scopes only 荣国府; the LLM references 碧纱橱 (scoped to ch3).
    const raw = { ...RAW_CLEAN, heading: { int_ext: "INT", location: "碧纱橱", time_of_day: "DAY" } };
    const { llm, calls } = sceneStub(raw);
    const { scene, issues } = await convertScene(candidate(), 6, bible(), llm);

    expect(scene.heading.location_id).toBe("loc_bixiaguan"); // resolved via full bible
    expect(issues.find((i) => i.kind === "unresolved_location")).toBeUndefined();
    // The prompt only showed the chapter-6 cast (focus): 碧纱橱 was NOT offered.
    expect(userText(calls)).toContain("荣国府");
    expect(userText(calls)).not.toContain("碧纱橱");
  });

  it("throws with scene context on structural garbage — bad enum (D6/I8)", async () => {
    const raw = { ...RAW_CLEAN, heading: { int_ext: "INT", location: "荣国府", time_of_day: "中午" } };
    const { llm } = sceneStub(raw);
    await expect(convertScene(candidate(), 3, bible(), llm)).rejects.toThrow(/scene_3_1/);
  });

  it("throws with scene context when the model output is not parseable JSON (I8)", async () => {
    const { llm } = sceneStub(new Error("Could not extract JSON from LLM response"));
    await expect(convertScene(candidate(), 3, bible(), llm)).rejects.toThrow(/scene_3_1/);
  });

  it("flags a truncated body (E6) when the candidate exceeds SCENE_BODY_CAP", async () => {
    const { llm, calls } = sceneStub(RAW_CLEAN);
    const big = candidate({ text: "荣国府" + "字".repeat(SCENE_BODY_CAP) + "尾部哨兵TAIL" });
    const { scene, issues } = await convertScene(big, 3, bible(), llm);

    expect(issues.find((i) => i.kind === "truncated_scene")).toBeDefined();
    expect(scene.needs_review).toBe(true);
    // The body sent to the LLM was capped: the far tail is cut, a marker added.
    expect(userText(calls)).not.toContain("尾部哨兵TAIL");
    expect(userText(calls)).toContain("截断");
  });

  it("tolerates trivially noisy element shapes (E3) — strips and still converts", async () => {
    const raw = {
      ...RAW_CLEAN,
      elements: [
        { type: "action", text: "黛玉下了轿。", speaker: "黛玉" }, // stray speaker
        { type: "dialogue", speaker: "贾母", line: "可怜我的儿！", text: "noise" },
      ],
    };
    const { llm } = sceneStub(raw);
    const { scene, issues } = await convertScene(candidate(), 3, bible(), llm);
    expect(issues).toEqual([]);
    expect(scene.elements[0]).toEqual({ type: "action", text: "黛玉下了轿。" });
    expect(scene.elements[1]).toMatchObject({ type: "dialogue", character_id: "char_jiamu" });
  });
});
