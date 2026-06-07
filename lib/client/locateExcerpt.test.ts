import { describe, it, expect } from "vitest";
import { locateExcerpt, normalizeWithMap } from "./locateExcerpt";

describe("locateExcerpt — exact (step 1)", () => {
  it("locates a verbatim CJK excerpt and returns UTF-16 [start,end)", () => {
    const novel = "第一回\n甄士隐梦幻识通灵 贾雨村风尘怀闺秀";
    const excerpt = "甄士隐梦幻识通灵";
    // 第(0)一(1)回(2)\n(3)甄(4)… → start 4, len 8 → end 12
    expect(locateExcerpt(novel, excerpt)).toEqual({ start: 4, end: 12 });
  });

  it("strips a trailing ellipsis before matching", () => {
    const novel = "第一回\n甄士隐梦幻识通灵 贾雨村风尘怀闺秀";
    const excerpt = "甄士隐梦幻识通灵…";
    expect(locateExcerpt(novel, excerpt)).toEqual({ start: 4, end: 12 });
  });

  it("returns the first occurrence when the excerpt repeats (deterministic)", () => {
    const novel = "甲乙丙甲乙丙";
    expect(locateExcerpt(novel, "甲乙丙")).toEqual({ start: 0, end: 3 });
  });

  it("accounts for surrogate pairs in the offset (emoji before match)", () => {
    const novel = "😀甲乙丙"; // 😀 = 2 UTF-16 code units → 甲 at index 2
    expect(locateExcerpt(novel, "甲乙丙")).toEqual({ start: 2, end: 5 });
  });
});

describe("locateExcerpt — first-paragraph anchor (step 2)", () => {
  it("falls back to the first paragraph when the full excerpt is absent", () => {
    // exact fails (second paragraph not in novel); anchor = first paragraph
    const novel = "前文第一段话后文";
    const excerpt = "第一段话\n第二段话";
    // 前(0)文(1)第(2) → anchor "第一段话" at 2, len 4 → end 6 (NOT extended to whole excerpt)
    expect(locateExcerpt(novel, excerpt)).toEqual({ start: 2, end: 6 });
  });
});

describe("locateExcerpt — whitespace normalization (step 3)", () => {
  it("matches across CRLF and full-width spaces when exact+anchor fail", () => {
    const excerpt = "甲 乙\n丙丁"; // anchor "甲 乙" (ASCII space) won't match full-width
    const novel = "甲　乙\r\n丙丁"; // 　=full-width space, \r\n
    // 甲(0)　(1)乙(2)\r(3)\n(4)丙(5)丁(6) → whole string
    expect(locateExcerpt(novel, excerpt)).toEqual({ start: 0, end: 7 });
  });
});

describe("locateExcerpt — misses", () => {
  it("returns null for empty novel or empty excerpt", () => {
    expect(locateExcerpt("", "甲")).toBeNull();
    expect(locateExcerpt("甲乙丙", "")).toBeNull();
  });

  it("returns null when the novel no longer contains the excerpt", () => {
    expect(locateExcerpt("完全不同的文本", "甲乙丙")).toBeNull();
  });
});

describe("normalizeWithMap", () => {
  it("collapses CRLF runs to a single space, mapping back to the run start", () => {
    // a(0)\r(1)\n(2)\r(3)\n(4)b(5)
    const { norm, map } = normalizeWithMap("a\r\n\r\nb");
    expect(norm).toBe("a b");
    expect(map).toEqual([0, 1, 5]);
  });

  it("collapses tab + full-width space into a single space", () => {
    // 甲(0)\t(1)　(2)乙(3)
    const { norm, map } = normalizeWithMap("甲\t　乙");
    expect(norm).toBe("甲 乙");
    expect(map).toEqual([0, 1, 3]);
  });

  it("leaves non-whitespace text untouched with identity map", () => {
    const { norm, map } = normalizeWithMap("甲乙丙");
    expect(norm).toBe("甲乙丙");
    expect(map).toEqual([0, 1, 2]);
  });
});
