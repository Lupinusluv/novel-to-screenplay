import { describe, it, expect } from "vitest";
import {
  MapEntitiesSchema,
  ReduceEntitiesSchema,
  validateStoryBible,
  type StoryBible,
} from "./storyBible";

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
