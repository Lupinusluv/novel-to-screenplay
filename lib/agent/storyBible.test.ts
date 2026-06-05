import { describe, it, expect } from "vitest";
import {
  MapEntitiesSchema,
  ReduceEntitiesSchema,
  validateStoryBible,
  assignIds,
  coerceMapEntities,
  computeProvenance,
  curateStoryBible,
  type StoryBible,
} from "./storyBible";
import type { Chapter } from "./chunker";
import type { ChatMessage, ChatOptions, LLMClient } from "../llm/client";

// --- Content-keyed stub (I7) -------------------------------------------------
// map calls (tagged 【分章抽取】) are routed by a token unique to each chapter's
// body; the reduce call (tagged 【合并去重】) returns the merged table. Keyed by
// content, NOT call order, so it stays correct under the map stage's Promise.all.

const CH1 = "甄士隐梦幻识通灵，贾宝玉初见，荣国府气派非凡。";
const CH2 = "宝二爷顽劣异常，荣府上下皆有议论。";
const CH3 = "林黛玉抛父进京都，初入府中，众人见黛玉怜其孤。";

const threeChapters: Chapter[] = [
  { index: 0, marker: "第一回", title: "", body: CH1, sceneCandidates: [] },
  { index: 1, marker: "第二回", title: "", body: CH2, sceneCandidates: [] },
  { index: 2, marker: "第三回", title: "", body: CH3, sceneCandidates: [] },
];

const MAP_BY_TOKEN: Record<string, unknown> = {
  甄士隐: {
    characters: [{ name: "贾宝玉", aliases: ["宝玉"], romanization: "baoyu" }],
    locations: [{ name: "荣国府", romanization: "rongguofu" }],
  },
  宝二爷: {
    characters: [{ name: "宝二爷", aliases: [], romanization: "baoeryea" }],
    locations: [{ name: "荣府", romanization: "rongfu" }],
  },
  林黛玉: {
    characters: [{ name: "林黛玉", aliases: ["黛玉"], romanization: "daiyu" }],
    locations: [],
  },
};

const REDUCE_RESULT = {
  characters: [
    { name: "贾宝玉", aliases: ["宝玉", "宝二爷"], romanization: "baoyu", arc: "顽石历劫" },
    { name: "林黛玉", aliases: ["黛玉"], romanization: "daiyu" },
  ],
  locations: [{ name: "荣国府", aliases: ["荣府"], romanization: "rongguofu" }],
};

interface Call {
  messages: ChatMessage[];
  opts?: ChatOptions;
}

function makeStub(
  over: { reduce?: unknown; mapFor?: (token: string) => unknown } = {},
): { llm: LLMClient; calls: Call[] } {
  const calls: Call[] = [];
  const llm: LLMClient = {
    chat: async () => "",
    chatJSON: async <T = unknown>(messages: ChatMessage[], opts?: ChatOptions) => {
      calls.push({ messages, opts });
      // Reduce is identified by its system tag; map is routed by a token in the
      // *user* message (the chapter body) only — the system prompt's «宝玉/宝二爷»
      // example must not pollute routing (I7: key by content, order-independent).
      const sysText = messages.map((m) => m.content).join("\n");
      if (sysText.includes("【合并去重】")) {
        return (over.reduce ?? REDUCE_RESULT) as T;
      }
      const body = messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");
      const token = Object.keys(MAP_BY_TOKEN).find((k) => body.includes(k));
      if (!token) throw new Error("stub: no map route for content");
      return ((over.mapFor ? over.mapFor(token) : MAP_BY_TOKEN[token]) as T);
    },
  };
  return { llm, calls };
}

describe("curateStoryBible (map → reduce → ids → provenance)", () => {
  it("merges 宝玉 aliases across chapters, assigns stable ids, builds provenance", async () => {
    const { llm, calls } = makeStub();
    const bible = await curateStoryBible(threeChapters, llm);

    const baoyu = bible.characters.find((c) => c.id === "char_baoyu");
    expect(baoyu).toBeDefined();
    expect(baoyu!.aliases).toEqual(expect.arrayContaining(["宝玉", "宝二爷"]));
    expect(bible.characters.map((c) => c.id).sort()).toEqual([
      "char_baoyu",
      "char_daiyu",
    ]);

    const loc = bible.locations[0];
    expect(loc.id).toBe("loc_rongguofu");
    expect(loc.aliases).toContain("荣府");

    // Provenance spans the chapters where each entity's surface forms appear.
    expect(bible.provenance["char_baoyu"]).toEqual([1, 2]);
    expect(bible.provenance["char_daiyu"]).toEqual([3]);
    expect(bible.provenance["loc_rongguofu"]).toEqual([1, 2]);

    // Output is structurally sound and romanization never leaks into it.
    expect(validateStoryBible(bible)).toEqual([]);
    expect((loc as Record<string, unknown>).romanization).toBeUndefined();

    // temperature pinned to 0 on every LLM call (R1 reproducibility).
    expect(calls.length).toBe(4); // 3 map + 1 reduce
    expect(calls.every((c) => c.opts?.temperature === 0)).toBe(true);
  });

  it("propagates a map failure tagged with its 1-based chapter number (I3)", async () => {
    const { llm } = makeStub({
      mapFor: (token) => {
        if (token === "宝二爷") throw new Error("invalid JSON from model");
        return MAP_BY_TOKEN[token];
      },
    });
    await expect(curateStoryBible(threeChapters, llm)).rejects.toThrow(/chapter 2/);
  });

  it("rejects a reduce output that violates the strict schema (I1)", async () => {
    const { llm } = makeStub({
      reduce: { characters: [{ name: "贾宝玉", id: "char_baoyu" }], locations: [] },
    });
    await expect(curateStoryBible(threeChapters, llm)).rejects.toThrow();
  });

  it("carries the reduce-chosen description and arc through to the final entity", async () => {
    const { llm } = makeStub({
      reduce: {
        characters: [
          { name: "贾宝玉", aliases: [], romanization: "baoyu", description: "荣府二公子", arc: "顽石历劫" },
        ],
        locations: [
          { name: "荣国府", aliases: [], romanization: "rongguofu", description: "贾府正宅" },
        ],
      },
    });
    const bible = await curateStoryBible(threeChapters, llm);
    expect(bible.characters[0].description).toBe("荣府二公子");
    expect(bible.characters[0].arc).toBe("顽石历劫");
    expect(bible.locations[0].description).toBe("贾府正宅");
  });

  it("returns an empty, valid bible when no entities are extracted", async () => {
    const { llm } = makeStub({
      mapFor: () => ({ characters: [], locations: [] }),
      reduce: { characters: [], locations: [] },
    });
    const bible = await curateStoryBible(threeChapters, llm);
    expect(bible.characters).toEqual([]);
    expect(bible.locations).toEqual([]);
    expect(bible.provenance).toEqual({});
    expect(validateStoryBible(bible)).toEqual([]);
  });

  it("sends only the capped chapter body to map, never scene candidates (I4)", async () => {
    const big = "甄士隐" + "字".repeat(20000);
    const chs: Chapter[] = [
      {
        index: 0,
        marker: "第一回",
        title: "",
        body: big,
        sceneCandidates: [{ index: 0, text: "SHOULD_NOT_APPEAR" }],
      },
    ];
    const { llm, calls } = makeStub();
    await curateStoryBible(chs, llm);
    const mapCall = calls.find((c) =>
      c.messages.some((m) => m.content.includes("【分章抽取】")),
    )!;
    const text = mapCall.messages.map((m) => m.content).join("\n");
    expect(text).not.toContain("SHOULD_NOT_APPEAR");
    expect(text.length).toBeLessThan(big.length); // body was truncated
    expect(text).toContain("截断"); // truncation marker present
  });
});

/** A minimal, fully-valid StoryBible fixture. */
function validBible(over: Partial<StoryBible> = {}): StoryBible {
  return {
    characters: [
      { id: "char_baoyu", name: "贾宝玉", aliases: ["宝玉", "宝二爷"] },
    ],
    locations: [{ id: "loc_rongguo", name: "荣国府", aliases: ["荣府"] }],
    provenance: { char_baoyu: [1, 2], loc_rongguo: [1] },
    ...over,
  };
}

describe("MapEntitiesSchema (per-chapter LLM output)", () => {
  it("parses a valid map-stage extraction", () => {
    const parsed = MapEntitiesSchema.parse({
      characters: [
        { name: "贾宝玉", aliases: ["宝玉", "宝二爷"], romanization: "baoyu", description: "荣府公子" },
      ],
      locations: [{ name: "荣国府", romanization: "rongguofu" }],
    });
    expect(parsed.characters[0].aliases).toEqual(["宝玉", "宝二爷"]);
    expect(parsed.locations[0].name).toBe("荣国府");
  });

  it("defaults missing characters/locations arrays and character aliases to []", () => {
    const parsed = MapEntitiesSchema.parse({ characters: [{ name: "黛玉" }] });
    expect(parsed.characters[0].aliases).toEqual([]);
    expect(parsed.locations).toEqual([]);
  });

  it("rejects a character missing its name", () => {
    expect(
      MapEntitiesSchema.safeParse({ characters: [{ aliases: ["x"] }] }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict) to catch hallucinated fields", () => {
    expect(
      MapEntitiesSchema.safeParse({
        characters: [{ name: "宝玉", gender: "male" }],
      }).success,
    ).toBe(false);
  });

  it("accepts location aliases at the map stage (real models emit them)", () => {
    const parsed = MapEntitiesSchema.parse({
      locations: [{ name: "荣国府", aliases: ["荣府"], romanization: "rongguofu" }],
    });
    expect(parsed.locations[0].aliases).toEqual(["荣府"]);
  });
});

describe("ReduceEntitiesSchema (merged, still id-less)", () => {
  it("parses merged entities carrying location aliases", () => {
    const parsed = ReduceEntitiesSchema.parse({
      characters: [
        { name: "贾宝玉", aliases: ["宝玉", "宝二爷"], romanization: "baoyu", arc: "顽石入世" },
      ],
      locations: [{ name: "荣国府", aliases: ["荣府"], romanization: "rongguofu" }],
    });
    expect(parsed.locations[0].aliases).toEqual(["荣府"]);
    expect(parsed.characters[0].arc).toBe("顽石入世");
  });

  it("rejects unknown keys (strict)", () => {
    expect(
      ReduceEntitiesSchema.safeParse({
        characters: [{ name: "宝玉", id: "char_baoyu" }],
      }).success,
    ).toBe(false);
  });
});

describe("validateStoryBible (strong structural checks, I2)", () => {
  it("returns no issues for a valid bible", () => {
    expect(validateStoryBible(validBible())).toEqual([]);
  });

  it("flags a duplicate id within the character table", () => {
    const b = validBible({
      characters: [
        { id: "char_baoyu", name: "贾宝玉", aliases: [] },
        { id: "char_baoyu", name: "甄宝玉", aliases: [] },
      ],
    });
    const issues = validateStoryBible(b);
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: "duplicate_id", id: "char_baoyu" }),
    );
  });

  it("flags a malformed id (wrong prefix / non-slug)", () => {
    const b = validBible({
      characters: [{ id: "Baoyu", name: "贾宝玉", aliases: [] }],
      provenance: { Baoyu: [1], loc_rongguo: [1] },
    });
    expect(validateStoryBible(b)).toContainEqual(
      expect.objectContaining({ kind: "bad_id_format", id: "Baoyu" }),
    );
  });

  it("flags duplicate aliases within one entity", () => {
    const b = validBible({
      characters: [{ id: "char_baoyu", name: "贾宝玉", aliases: ["宝玉", "宝玉"] }],
    });
    expect(validateStoryBible(b)).toContainEqual(
      expect.objectContaining({ kind: "duplicate_alias", id: "char_baoyu" }),
    );
  });

  it("flags an entity whose canonical name leaks into its own aliases", () => {
    const b = validBible({
      characters: [{ id: "char_baoyu", name: "贾宝玉", aliases: ["贾宝玉", "宝玉"] }],
    });
    expect(validateStoryBible(b)).toContainEqual(
      expect.objectContaining({ kind: "name_in_aliases", id: "char_baoyu" }),
    );
  });

  it("flags an id reused across the character and location tables", () => {
    const b = validBible({
      characters: [{ id: "dup", name: "贾宝玉", aliases: [] }],
      locations: [{ id: "dup", name: "荣国府", aliases: [] }],
      provenance: { dup: [1] },
    });
    expect(validateStoryBible(b)).toContainEqual(
      expect.objectContaining({ kind: "cross_table_id", id: "dup" }),
    );
  });
});

describe("assignIds (deterministic id post-processing, R1)", () => {
  it("slugs the romanization hint into a prefixed id", () => {
    const out = assignIds(
      [{ name: "贾宝玉", romanization: "Bao Yu!", aliases: [] }],
      "char",
    );
    expect(out[0].id).toBe("char_bao_yu");
  });

  it("disambiguates colliding slugs with numeric suffixes, name-sorted", () => {
    const out = assignIds(
      [
        { name: "甲", romanization: "yu", aliases: [] }, // U+7532
        { name: "乙", romanization: "yu", aliases: [] }, // U+4E59, sorts first
      ],
      "char",
    );
    const byName = Object.fromEntries(out.map((e) => [e.name, e.id]));
    expect(byName["乙"]).toBe("char_yu");
    expect(byName["甲"]).toBe("char_yu_2");
  });

  it("falls back to a positional id when romanization is missing/empty", () => {
    const out = assignIds(
      [{ name: "无名地", romanization: "", aliases: [] }],
      "loc",
    );
    expect(out[0].id).toBe("loc_1");
  });

  it("is reproducible regardless of input order (stable sort before fallback)", () => {
    const forward = assignIds(
      [
        { name: "甲", romanization: "", aliases: [] },
        { name: "乙", romanization: "", aliases: [] },
      ],
      "char",
    );
    const reversed = assignIds(
      [
        { name: "乙", romanization: "", aliases: [] },
        { name: "甲", romanization: "", aliases: [] },
      ],
      "char",
    );
    expect(forward).toEqual(reversed);
  });
});

describe("coerceMapEntities (I5 drop counting + I1 strict)", () => {
  it("drops entities missing a usable name and counts them", () => {
    const { entities, dropped } = coerceMapEntities({
      characters: [{ name: "宝玉", aliases: [] }, { aliases: ["x"] }, { name: "  " }],
      locations: [],
    });
    expect(entities.characters).toHaveLength(1);
    expect(dropped).toBe(2);
  });

  it("throws on dirty data the strict schema rejects (unknown key)", () => {
    expect(() =>
      coerceMapEntities({ characters: [{ name: "宝玉", gender: "male" }] }),
    ).toThrow();
  });

  it("treats missing arrays as empty with zero drops (empty chapter)", () => {
    expect(coerceMapEntities({})).toEqual({
      entities: { characters: [], locations: [] },
      dropped: 0,
    });
  });
});

describe("computeProvenance (R6 side-table)", () => {
  it("maps each id to the 1-based chapters its surface forms appear in", () => {
    const prov = computeProvenance(
      [{ id: "loc_rongguo", name: "荣国府", aliases: ["荣府"] }],
      [
        { chapter: 1, forms: ["荣国府"] },
        { chapter: 2, forms: ["荣府"] },
        { chapter: 3, forms: ["别处"] },
      ],
    );
    expect(prov).toEqual({ loc_rongguo: [1, 2] });
  });
});
