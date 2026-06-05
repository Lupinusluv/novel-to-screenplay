import { describe, it, expect } from "vitest";
import {
  ScreenplaySchema,
  parseScreenplay,
  checkReferentialIntegrity,
} from "./screenplay";
import { validScreenplay } from "./fixtures";

describe("ScreenplaySchema", () => {
  it("parses a fully-valid screenplay", () => {
    const data = validScreenplay();
    const parsed = parseScreenplay(data);
    expect(parsed).toEqual(data);
  });

  it("exposes a zod schema whose safeParse succeeds on valid input", () => {
    expect(ScreenplaySchema.safeParse(validScreenplay()).success).toBe(true);
  });

  it("rejects an unknown time_of_day enum value", () => {
    const bad = validScreenplay();
    // @ts-expect-error intentionally invalid enum
    bad.scenes[0].heading.time_of_day = "MIDNIGHT";
    expect(ScreenplaySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown keys (strict) to catch hallucinated fields", () => {
    const bad = validScreenplay() as Record<string, unknown>;
    bad.unexpected = "hallucinated";
    expect(ScreenplaySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a dialogue element missing its line", () => {
    const bad = validScreenplay();
    // @ts-expect-error intentionally drop a required field
    delete bad.scenes[0].elements[1].line;
    expect(ScreenplaySchema.safeParse(bad).success).toBe(false);
  });

  it("defaults aliases to [] when omitted", () => {
    const parsed = parseScreenplay({
      ...validScreenplay(),
      characters: [{ id: "char_x", name: "无名" }],
    });
    expect(parsed.characters[0].aliases).toEqual([]);
  });
});

describe("checkReferentialIntegrity", () => {
  it("returns no issues when every reference resolves", () => {
    expect(checkReferentialIntegrity(validScreenplay())).toEqual([]);
  });

  it("flags a heading location_id that does not exist", () => {
    const s = validScreenplay();
    s.scenes[0].heading.location_id = "loc_ghost";
    expect(checkReferentialIntegrity(s)).toEqual([
      {
        scene_id: "scene_1",
        kind: "location",
        ref: "loc_ghost",
        where: "heading.location_id",
      },
    ]);
  });

  it("flags a dialogue character_id that does not exist, with its element index", () => {
    const s = validScreenplay();
    // elements[1] is the dialogue element in the fixture.
    (s.scenes[0].elements[1] as { character_id: string }).character_id =
      "char_ghost";
    expect(checkReferentialIntegrity(s)).toEqual([
      {
        scene_id: "scene_1",
        kind: "character",
        ref: "char_ghost",
        where: "elements[1].character_id",
      },
    ]);
  });
});
