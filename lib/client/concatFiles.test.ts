import { describe, it, expect } from "vitest";
import {
  naturalCompare,
  orderFilesNaturally,
  concatNovelFiles,
  type NamedText,
} from "./concatFiles";

describe("naturalCompare", () => {
  it("orders embedded numbers by value, not lexicographically", () => {
    expect(naturalCompare("第2章.txt", "第10章.txt")).toBeLessThan(0);
    expect(naturalCompare("第10章.txt", "第2章.txt")).toBeGreaterThan(0);
    expect(naturalCompare("part1", "part1")).toBe(0);
  });
});

describe("orderFilesNaturally", () => {
  it("sorts by filename in natural order without mutating the input", () => {
    const files: NamedText[] = [
      { name: "第10章.txt", text: "J" },
      { name: "第2章.txt", text: "B" },
      { name: "第1章.txt", text: "A" },
    ];
    const out = orderFilesNaturally(files);
    expect(out.map((f) => f.name)).toEqual([
      "第1章.txt",
      "第2章.txt",
      "第10章.txt",
    ]);
    // input untouched
    expect(files[0].name).toBe("第10章.txt");
  });
});

describe("concatNovelFiles", () => {
  it("joins natural-sorted file contents with a single blank line", () => {
    const files: NamedText[] = [
      { name: "第2章.txt", text: "二章正文" },
      { name: "第1章.txt", text: "一章正文" },
    ];
    expect(concatNovelFiles(files)).toBe("一章正文\n\n二章正文");
  });

  it("trims ragged whitespace so the joiner is exactly one blank line", () => {
    const files: NamedText[] = [
      { name: "a.txt", text: "  甲\n\n" },
      { name: "b.txt", text: "\n乙  " },
    ];
    expect(concatNovelFiles(files)).toBe("甲\n\n乙");
  });

  it("drops empty / whitespace-only files", () => {
    const files: NamedText[] = [
      { name: "a.txt", text: "甲" },
      { name: "b.txt", text: "   \n  " },
    ];
    expect(concatNovelFiles(files)).toBe("甲");
  });
});
