import { describe, it, expect } from "vitest";
import {
  naturalCompare,
  orderFilesNaturally,
  concatNovelFiles,
  parseOrdinal,
  chapterOrdinal,
  type NamedText,
} from "./concatFiles";

describe("parseOrdinal", () => {
  it("parses Arabic and Chinese numerals", () => {
    expect(parseOrdinal("36")).toBe(36);
    expect(parseOrdinal("三十六")).toBe(36);
    expect(parseOrdinal("十")).toBe(10);
    expect(parseOrdinal("一百二十")).toBe(120);
    expect(parseOrdinal("两")).toBe(2);
    expect(parseOrdinal("第七")).toBeNull(); // contains non-numeral 第
  });
});

describe("chapterOrdinal", () => {
  it("extracts the chapter number from a real filename", () => {
    expect(
      chapterOrdinal("《红楼梦》第三十六回 绣鸳鸯梦兆绛芸轩.txt"),
    ).toBe(36);
    expect(chapterOrdinal("第10章.txt")).toBe(10);
    expect(chapterOrdinal("追忆似水年华.txt")).toBeNull();
  });
});

describe("naturalCompare", () => {
  it("orders embedded Arabic numbers by value, not lexicographically", () => {
    expect(naturalCompare("第2章.txt", "第10章.txt")).toBeLessThan(0);
    expect(naturalCompare("第10章.txt", "第2章.txt")).toBeGreaterThan(0);
    expect(naturalCompare("part1", "part1")).toBe(0);
  });

  it("orders Chinese-numeral chapters by value (the multi-select bug)", () => {
    const names = [
      "《红楼梦》第三十八回 林潇湘魁夺菊花诗.txt",
      "《红楼梦》第三十六回 绣鸳鸯梦兆绛芸轩.txt",
      "《红楼梦》第三十七回 秋爽斋偶结海棠社.txt",
    ];
    const sorted = [...names].sort(naturalCompare);
    expect(sorted.map((n) => chapterOrdinal(n))).toEqual([36, 37, 38]);
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
