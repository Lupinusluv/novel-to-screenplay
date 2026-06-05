import type { Screenplay } from "./screenplay";

/** A minimal but fully-valid screenplay used as a test fixture. */
export function validScreenplay(over: Partial<Screenplay> = {}): Screenplay {
  return {
    title: "深夜咖啡馆",
    logline: "一名刑警在街角咖啡馆遇见关键证人。",
    characters: [
      {
        id: "char_lin",
        name: "林深",
        aliases: ["小林", "林队长"],
        description: "三十岁刑警",
        arc: "从怀疑到信任",
      },
    ],
    locations: [{ id: "loc_cafe", name: "街角咖啡馆" }],
    scenes: [
      {
        id: "scene_1",
        heading: { int_ext: "INT", location_id: "loc_cafe", time_of_day: "DAY" },
        synopsis: "林深进入咖啡馆与证人对话。",
        source: { chapter: 1, excerpt: "第1-3段" },
        elements: [
          { type: "action", text: "林深推门而入。" },
          {
            type: "dialogue",
            character_id: "char_lin",
            parenthetical: "(压低声音)",
            line: "你来了。",
          },
          { type: "transition", text: "CUT TO:" },
        ],
      },
    ],
    ...over,
  };
}
