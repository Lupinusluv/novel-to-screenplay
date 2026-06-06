import { describe, it, expect } from "vitest";
import { validateScreenplay, validateScene } from "./validator";
import type { Scene, Screenplay } from "../schema/screenplay";
import type { StoryBible } from "./storyBible";

function bible(): StoryBible {
  return {
    characters: [
      { id: "char_jiamu", name: "贾母", aliases: ["老太太"] },
      { id: "char_daiyu", name: "林黛玉", aliases: ["黛玉"] },
    ],
    locations: [{ id: "loc_rongguofu", name: "荣国府", aliases: ["荣府"] }],
    provenance: {},
  };
}

function scene(over: Partial<Scene> = {}): Scene {
  return {
    id: "scene_3_1",
    heading: { int_ext: "INT", location_id: "loc_rongguofu", time_of_day: "DAY" },
    synopsis: "黛玉拜见贾母。",
    source: { chapter: 3, excerpt: "黛玉初入荣国府" },
    elements: [
      { type: "action", text: "黛玉下了轿。" },
      { type: "dialogue", character_id: "char_jiamu", line: "可怜我的儿！" },
    ],
    ...over,
  };
}

function screenplay(over: Partial<Screenplay> = {}): Screenplay {
  const b = bible();
  return {
    title: "红楼梦改编",
    logline: "一句话梗概。",
    characters: b.characters,
    locations: b.locations,
    scenes: [scene()],
    ...over,
  };
}

describe("validateScreenplay (D3: whole-screenplay gate)", () => {
  it("T1 — a clean screenplay passes: ok=true, no structural/reference issues", () => {
    const r = validateScreenplay(screenplay());
    expect(r.ok).toBe(true);
    expect(r.structural).toEqual([]);
    expect(r.references).toEqual([]);
    expect(r.duplicateSceneIds).toEqual([]);
  });

  it("T2 — a dangling reference fails: references non-empty, ok=false", () => {
    const bad = screenplay({
      scenes: [
        scene({
          elements: [{ type: "dialogue", character_id: "char_ghost", line: "?" }],
        }),
      ],
    });
    const r = validateScreenplay(bad);
    expect(r.ok).toBe(false);
    expect(r.references.length).toBeGreaterThan(0);
    expect(r.references[0].ref).toBe("char_ghost");
  });

  it("T3 — duplicate scene ids are reported (I10)", () => {
    const dup = screenplay({ scenes: [scene(), scene()] }); // both scene_3_1
    const r = validateScreenplay(dup);
    expect(r.duplicateSceneIds).toEqual(["scene_3_1"]);
    expect(r.ok).toBe(false);
  });

  it("T4 — needs_review census lists the flagged scene ids", () => {
    const sp = screenplay({
      scenes: [
        scene({ id: "scene_3_1" }),
        scene({ id: "scene_3_2", needs_review: true }),
      ],
    });
    const r = validateScreenplay(sp);
    expect(r.needsReview).toEqual(["scene_3_2"]);
    // needs_review is a signal, not a hard failure on its own.
    expect(r.ok).toBe(true);
  });

  it("flags structural garbage (bad enum) in `structural`", () => {
    const broken = {
      ...screenplay(),
      scenes: [{ ...scene(), heading: { int_ext: "MID", location_id: "loc_rongguofu", time_of_day: "DAY" } }],
    } as unknown as Screenplay;
    const r = validateScreenplay(broken);
    expect(r.structural.length).toBeGreaterThan(0);
    expect(r.ok).toBe(false);
  });
});

describe("validateScene (E12: defensive per-scene check returns a rich report)", () => {
  it("T5a — a clean scene returns empty structural + references", () => {
    const r = validateScene(scene(), bible());
    expect(r.structural).toEqual([]);
    expect(r.references).toEqual([]);
  });

  it("T5b — a dangling reference surfaces in references", () => {
    const r = validateScene(
      scene({ heading: { int_ext: "INT", location_id: "loc_ghost", time_of_day: "DAY" } }),
      bible(),
    );
    expect(r.references.length).toBeGreaterThan(0);
    expect(r.references[0].kind).toBe("location");
  });

  it("T5c — structural garbage surfaces in structural (not throwing)", () => {
    const broken = { ...scene(), elements: [{ type: "dialogue" }] } as unknown as Scene;
    const r = validateScene(broken, bible());
    expect(r.structural.length).toBeGreaterThan(0);
  });
});
