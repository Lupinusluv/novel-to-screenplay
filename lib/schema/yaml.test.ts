import { describe, it, expect } from "vitest";
import { toYAML, fromYAML } from "./yaml";
import { parseScreenplay } from "./screenplay";
import { validScreenplay } from "./fixtures";

describe("toYAML / fromYAML round-trip", () => {
  it("round-trips a screenplay back to an equal object", () => {
    const original = validScreenplay();
    const restored = fromYAML(toYAML(original));
    expect(restored).toEqual(original);
  });

  it("produces human-readable YAML with block keys (not inline JSON)", () => {
    const yaml = toYAML(validScreenplay());
    expect(yaml).toContain("title: 深夜咖啡馆");
    expect(yaml).toContain("characters:");
    expect(yaml).toContain("- id: char_lin");
  });

  it("does not emit YAML anchors/aliases for repeated strings", () => {
    // The `yaml` lib can emit `&a1`/`*a1` for shared nodes; that would make
    // the screenplay hostile to human editing. Ensure it is disabled.
    const yaml = toYAML(
      validScreenplay({
        locations: [
          { id: "loc_a", name: "重复的名字" },
          { id: "loc_b", name: "重复的名字" },
        ],
      }),
    );
    expect(yaml).not.toMatch(/[*&]a\d/);
  });
});

describe("fromYAML validation", () => {
  it("throws on YAML that violates the schema", () => {
    expect(() => fromYAML("title: x\nlogline: y\n")).toThrow();
  });

  it("throws on malformed YAML", () => {
    expect(() => fromYAML("title: [unterminated")).toThrow();
  });

  it("validates through the schema (applies aliases default)", () => {
    const yaml = toYAML(
      parseScreenplay({
        ...validScreenplay(),
        characters: [{ id: "char_x", name: "无名" }],
      }),
    );
    expect(fromYAML(yaml).characters[0].aliases).toEqual([]);
  });
});
