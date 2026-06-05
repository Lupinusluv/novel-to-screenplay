import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { chunkNovel, splitScenes } from "./chunker";

/** Scene candidate texts for a single-chapter body. */
function scenesOf(body: string): string[] {
  return splitScenes(body).map((s) => s.text);
}

describe("chunkNovel · chapters", () => {
  it("splits a 3-chapter novel and captures index, marker and title", () => {
    const raw = [
      "第一回 风雪夜",
      "林深推门而入。",
      "",
      "第二回 旧案",
      "他翻开卷宗。",
      "",
      "第三回 真相",
      "凶手终于落网。",
    ].join("\n");

    const { chapters } = chunkNovel(raw);

    expect(chapters).toHaveLength(3);
    expect(chapters[0]).toMatchObject({ index: 0, marker: "第一回", title: "风雪夜" });
    expect(chapters[1]).toMatchObject({ index: 1, marker: "第二回", title: "旧案" });
    expect(chapters[2]).toMatchObject({ index: 2, marker: "第三回", title: "真相" });
    expect(chapters[0].body).toContain("林深推门而入");
    expect(chapters[0].body).not.toContain("第一回");
  });

  it("discards front-matter before the first chapter heading", () => {
    const raw = ["《红楼梦》 曹雪芹 著", "出版说明……", "第一回 甄士隐", "正文开始。"].join(
      "\n",
    );
    const { chapters } = chunkNovel(raw);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].marker).toBe("第一回");
    expect(chapters[0].body).not.toContain("出版说明");
  });

  it("treats heading-less text as a single untitled chapter", () => {
    const { chapters } = chunkNovel("没有任何章节标记的一段文字。\n第二段。");
    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({ index: 0, marker: "", title: "" });
    expect(chapters[0].body).toContain("没有任何章节标记");
  });

  it("supports 章 / 回 and Chinese / Arabic numerals", () => {
    const raw = ["第1章 起", "甲。", "", "第二章 承", "乙。", "", "第三章 转", "丙。"].join(
      "\n",
    );
    expect(chunkNovel(raw).chapters.map((c) => c.marker)).toEqual([
      "第1章",
      "第二章",
      "第三章",
    ]);
  });

  it("does not treat an in-text reference like '第四回中…' as a heading", () => {
    // Real pitfall from 红楼梦 source: a body line begins with `第四回中既將…`.
    // The anchored heading shape (marker then whitespace+title or EOL) rejects
    // it because `中` follows the marker with no separating space.
    const raw = [
      "第一回 起",
      "正文一句。",
      "第四回中既将薛家母子寄居等事略已表明，此回暂不写。",
    ].join("\n");
    const { chapters } = chunkNovel(raw);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].marker).toBe("第一回");
    expect(chapters[0].body).toContain("第四回中既将");
  });
});

describe("splitScenes · scene candidates", () => {
  it("returns one candidate when there is no scene signal", () => {
    const body = "林深推门而入。\n他环顾四周。\n证人坐在角落。";
    const scenes = splitScenes(body);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toMatchObject({ index: 0 });
    expect(scenes[0].text).toContain("林深推门而入");
    expect(scenes[0].text).toContain("证人坐在角落");
  });

  it("splits on an explicit separator line and drops the separator", () => {
    const body = "咖啡馆内的对话。\n***\n回到警局，林深摊开卷宗。";
    const scenes = scenesOf(body);
    expect(scenes).toHaveLength(2);
    expect(scenes[0]).toContain("咖啡馆");
    expect(scenes[1]).toContain("警局");
    expect(scenes.join("\n")).not.toContain("***");
  });

  it("splits on a paragraph-leading transition cue word", () => {
    const body = "林深审完最后一名证人。\n次日清晨，他赶往码头。";
    expect(scenesOf(body)).toEqual([
      "林深审完最后一名证人。",
      "次日清晨，他赶往码头。",
    ]);
  });

  it("splits 章回体 dense text on 却说 / 话说 cues", () => {
    const body = "话说林深奉命查案，连夜赶路。却说那凶手早已潜逃出城。";
    // Cues appear mid-line in classical dense prose; each starts a new scene.
    expect(scenesOf(body)).toEqual([
      "话说林深奉命查案，连夜赶路。",
      "却说那凶手早已潜逃出城。",
    ]);
  });

  it("splits on a large blank gap (>=2 blank lines) but not single spacing", () => {
    const singleGap = "第一段。\n\n第二段。";
    expect(scenesOf(singleGap)).toHaveLength(1); // normal paragraph spacing

    const bigGap = "场景一。\n\n\n场景二。";
    expect(scenesOf(bigGap)).toHaveLength(2);
  });

  it("trims candidate text and re-indexes from 0", () => {
    const body = "  甲。  \n***\n  乙。  ";
    expect(splitScenes(body)).toEqual([
      { index: 0, text: "甲。" },
      { index: 1, text: "乙。" },
    ]);
  });
});

describe("chunkNovel · real sample 《红楼梦》前三回", () => {
  const raw = readFileSync(
    join(process.cwd(), "samples", "honglou-meng-ch1-3.txt"),
    "utf8",
  );
  const { chapters } = chunkNovel(raw);

  it("detects exactly three chapters with markers and non-empty titles", () => {
    expect(chapters.map((c) => c.marker)).toEqual(["第一回", "第二回", "第三回"]);
    expect(chapters.every((c) => c.title.length > 0)).toBe(true);
  });

  it("gives every chapter at least one substantive scene candidate", () => {
    for (const c of chapters) {
      expect(c.sceneCandidates.length).toBeGreaterThanOrEqual(1);
      expect(c.sceneCandidates[0].text.length).toBeGreaterThan(20);
    }
  });
});
