import { describe, it, expect } from "vitest";
import { screenplayFileName } from "./filename";

describe("screenplayFileName", () => {
  it("keeps a clean (incl. CJK) title and appends .yaml", () => {
    expect(screenplayFileName("红楼梦")).toBe("红楼梦.yaml");
  });

  it("replaces Windows-illegal characters / \\ : * ? \" < > |", () => {
    expect(screenplayFileName('a/b\\c:d*e?f"g<h>i|j')).toBe(
      "a_b_c_d_e_f_g_h_i_j.yaml",
    );
  });

  it("trims leading/trailing whitespace", () => {
    expect(screenplayFileName("  剧本  ")).toBe("剧本.yaml");
  });

  it("falls back to screenplay.yaml for empty/undefined titles", () => {
    expect(screenplayFileName(undefined)).toBe("screenplay.yaml");
    expect(screenplayFileName("")).toBe("screenplay.yaml");
  });

  it("falls back when the title is only illegal/whitespace", () => {
    expect(screenplayFileName("  //  ")).toBe("screenplay.yaml");
  });
});
