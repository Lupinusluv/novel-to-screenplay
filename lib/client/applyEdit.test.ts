import { describe, it, expect } from "vitest";
import { applyEdit, MAX_YAML_CHARS } from "./applyEdit";
import { toYAML } from "../schema/yaml";
import { validScreenplay } from "../schema/fixtures";

describe("applyEdit — success", () => {
  it("parses valid YAML to a screenplay with no reference warnings", () => {
    const result = applyEdit(toYAML(validScreenplay()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.screenplay.title).toBe("深夜咖啡馆");
      expect(result.refWarnings).toEqual([]);
    }
  });

  it("applies but warns when a reference is broken (ok + refWarnings)", () => {
    const yaml = toYAML(
      validScreenplay({
        scenes: [
          {
            id: "scene_1",
            heading: { int_ext: "INT", location_id: "loc_cafe", time_of_day: "DAY" },
            synopsis: "x",
            source: { chapter: 1, excerpt: "第1段" },
            elements: [
              { type: "dialogue", character_id: "char_missing", line: "谁?" },
            ],
          },
        ],
      }),
    );
    const result = applyEdit(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.refWarnings.length).toBeGreaterThan(0);
      expect(result.refWarnings[0].ref).toBe("char_missing");
    }
  });
});

describe("applyEdit — failures preserve nothing (ok:false)", () => {
  it("rejects malformed YAML with a syntax message", () => {
    const result = applyEdit("title: [unterminated");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("语法");
  });

  it("rejects a schema violation with a readable path", () => {
    const yaml = toYAML(validScreenplay()).replace(
      "title: 深夜咖啡馆",
      'title: ""',
    );
    const result = applyEdit(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("title");
  });

  it("rejects duplicate scene ids (would clobber React keys / refs)", () => {
    const scene = validScreenplay().scenes[0];
    const yaml = toYAML(validScreenplay({ scenes: [scene, { ...scene }] }));
    const result = applyEdit(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("重复");
      expect(result.error).toContain("scene_1");
    }
  });

  it("rejects an empty scene list", () => {
    const yaml = toYAML(validScreenplay({ scenes: [] }));
    const result = applyEdit(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("场景");
  });

  it("rejects empty input", () => {
    expect(applyEdit("").ok).toBe(false);
  });

  it("rejects input over the length guard", () => {
    const result = applyEdit("a".repeat(MAX_YAML_CHARS + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("过长");
  });
});
