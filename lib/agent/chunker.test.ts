import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { chunkNovel, splitScenes, SCENE_SOFT_TARGET } from "./chunker";

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

  it("detects a heading whose title is attached with no separating space", () => {
    // Some public-domain e-texts concatenate marker and title with no space:
    // `第一回甄士隱…` instead of `第一回　甄士隱…`. The marker shape is
    // unambiguous, so the title is everything after it — as long as it isn't a
    // prose continuation (those carry sentence punctuation; see next test).
    const raw = [
      "第一回甄士隱夢幻識通靈　賈雨村風塵懷閨秀",
      "此開卷第一回也。",
      "第二回賈夫人仙逝揚州城",
      "卻說封肅聞得公差傳喚。",
    ].join("\n");
    const { chapters } = chunkNovel(raw);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toMatchObject({
      marker: "第一回",
      title: "甄士隱夢幻識通靈　賈雨村風塵懷閨秀",
    });
    expect(chapters[1]).toMatchObject({
      marker: "第二回",
      title: "賈夫人仙逝揚州城",
    });
    expect(chapters[0].body).toContain("此開卷第一回也");
  });

  it("recognizes a heading carrying a 《书名》 prefix (the real dogfood bug)", () => {
    // User's real paste: `《红楼梦》第三回 …`. The `《》` prefix made the
    // line fail `^…第N回`, collapsing the whole novel to 1 chapter with
    // every scene's source.chapter === 1.
    const raw = [
      "《红楼梦》第一回 甄士隐",
      "正文一。",
      "《红楼梦》第二回 贾夫人",
      "正文二。",
      "《红楼梦》第三回 林黛玉",
      "正文三。",
    ].join("\n");
    const { chapters } = chunkNovel(raw);
    expect(chapters.map((c) => c.marker)).toEqual(["第一回", "第二回", "第三回"]);
    expect(chapters[0].title).toBe("甄士隐");
    expect(chapters[0].body).not.toContain("第一回");
    expect(chapters[0].body).not.toContain("红楼梦");
  });

  it("recognizes a 【栏目】 prefix and a full-width space after the prefix", () => {
    const raw = ["【正文】　第1章 开端", "甲。", "【正文】　第2章 发展", "乙。"].join("\n");
    expect(chunkNovel(raw).chapters.map((c) => c.marker)).toEqual(["第1章", "第2章"]);
  });

  it("recognizes English-translation headings (Chapter N / Ch. N), title optional", () => {
    const raw = [
      "Chapter 1: The Storm",
      "He walked in.",
      "Ch. 2 Aftermath",
      "She left.",
      "CHAPTER 3",
      "The end.",
    ].join("\n");
    const { chapters } = chunkNovel(raw);
    expect(chapters).toHaveLength(3);
    expect(chapters[0].title).toBe("The Storm");
    expect(chapters[1]).toMatchObject({ title: "Aftermath" });
    expect(chapters[2].title).toBe("");
  });

  it("recognizes 卷·章 combo and 节/部/篇 markers, keeping both levels in marker", () => {
    const raw = [
      "第一卷·第一章 起",
      "甲。",
      "第一卷 第二章 承",
      "乙。",
      "第三节 转",
      "丙。",
    ].join("\n");
    const { chapters } = chunkNovel(raw);
    expect(chapters.map((c) => c.marker)).toEqual([
      "第一卷第一章",
      "第一卷第二章",
      "第三节",
    ]);
  });

  it("recognizes 第N回：标题 with a colon separator", () => {
    const raw = ["第三回：黛玉进府", "正文。"].join("\n");
    const { chapters } = chunkNovel(raw);
    expect(chapters[0]).toMatchObject({ marker: "第三回", title: "黛玉进府" });
  });

  it("does NOT treat a bare number line or roman-numeral chapter as a heading", () => {
    // Out-of-scope by design: bare numbers collide with phone numbers / years
    // / lists; roman numerals are not parsed.
    const raw = ["1", "正文一。", "01", "正文二。", "Chapter IV", "正文三。"].join("\n");
    const { chapters } = chunkNovel(raw);
    expect(chapters).toHaveLength(1); // no heading recognized → single chapter
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

  it("splits on TRADITIONAL-character cues (話說 / 卻說) too", () => {
    // Synthetic 林深 fixture written in 繁體 — NOT a 红楼梦 quote. The real
    // 公有领域《红楼梦》sample (samples/) happens to be 繁體, so the cue
    // matcher must handle both simplified and traditional forms.
    const body = "話說林深奉命查案，連夜趕路。卻說那兇手早已潛逃出城。";
    expect(scenesOf(body)).toEqual([
      "話說林深奉命查案，連夜趕路。",
      "卻說那兇手早已潛逃出城。",
    ]);
  });

  it("splits on a large blank gap (>=2 blank lines) but not single spacing", () => {
    const singleGap = "第一段。\n\n第二段。";
    expect(scenesOf(singleGap)).toHaveLength(1); // normal paragraph spacing

    const bigGap = "场景一。\n\n\n场景二。";
    expect(scenesOf(bigGap)).toHaveLength(2);
  });

  it("length fallback: splits an over-target paragraph blob on paragraph breaks", () => {
    // Modern prose with no chapter/separator/cue signal but real paragraph
    // breaks (single blank lines). Each paragraph ~600 chars; 4 of them blow
    // past the soft target, so they must be packed into <=target candidates.
    const para = (n: number) => `${"段".repeat(600)}${n}`;
    const body = [para(1), para(2), para(3), para(4)].join("\n\n");
    const scenes = splitScenes(body);
    expect(scenes.length).toBeGreaterThan(1);
    for (const s of scenes) expect(s.text.length).toBeLessThanOrEqual(SCENE_SOFT_TARGET);
  });

  it("length fallback: splits a single over-target paragraph on sentence punctuation", () => {
    // One paragraph, no blank lines, but sentence-ending punctuation. Must
    // split on 。！？ so no candidate exceeds the soft target.
    const sentence = "他走进房间看了看四周然后坐下来又站起来。";
    const body = sentence.repeat(200); // ~4000 chars, single paragraph
    const scenes = splitScenes(body);
    expect(scenes.length).toBeGreaterThan(1);
    for (const s of scenes) expect(s.text.length).toBeLessThanOrEqual(SCENE_SOFT_TARGET);
    // Lossless: rejoining recovers the original (no chars dropped/added).
    expect(scenes.map((s) => s.text).join("")).toBe(body);
  });

  it("length fallback: hard-slices a punctuation-free long string (backstop of last resort)", () => {
    const body = "字".repeat(4001); // no punctuation, no breaks at all
    const scenes = splitScenes(body);
    expect(scenes.length).toBeGreaterThan(1);
    for (const s of scenes) expect(s.text.length).toBeLessThanOrEqual(SCENE_SOFT_TARGET);
    expect(scenes.map((s) => s.text).join("")).toBe(body);
  });

  it("length fallback: leaves an under-target body as a single candidate", () => {
    const body = "短".repeat(SCENE_SOFT_TARGET - 1);
    expect(splitScenes(body)).toHaveLength(1);
  });

  // A long, varied passage (distinct trigrams ≈ length) so a tiny suffix barely
  // moves the Jaccard score, and well over NEAR_DUP_MIN_LEN.
  const PASSAGE =
    "林黛玉抛父进京都那日清晨天色微明贾府门前车马喧嚣众人早起洒扫庭除迎接远客" +
    "王熙凤携丫鬟立于阶下笑语盈盈贾母端坐厅中等候多时宝玉闻讯急急赶来一睹神仙" +
    "似的妹妹众姊妹亦皆好奇张望整个荣国府上下因这位姑娘的到来而显得格外热闹非常";
  const OTHER =
    "薛蟠在金陵城中惹下人命官司冯渊一家告到衙门贾雨村新任应天府尹徇情枉法胡乱" +
    "判了一桩糊涂案门子献上护官符提点四大家族的根基盘根错节牵一发而动全身不可轻慢";

  it("near-dup: merges adjacent near-identical candidates, keeping the longer", () => {
    const longer = PASSAGE + "。事后又添了几句闲话作罢。";
    const body = [PASSAGE, "***", longer].join("\n");
    const scenes = splitScenes(body);
    expect(scenes).toHaveLength(1);
    expect(scenes[0].text).toContain("事后又添了几句闲话");
  });

  it("near-dup: flags a NON-adjacent near-duplicate via nearDuplicateOf, keeps both", () => {
    const body = [PASSAGE, "***", OTHER, "***", PASSAGE].join("\n");
    const scenes = splitScenes(body);
    expect(scenes).toHaveLength(3);
    expect(scenes[0].nearDuplicateOf).toBeUndefined();
    expect(scenes[2].nearDuplicateOf).toBe(0);
  });

  it("near-dup: does NOT touch short repeated candidates (formulaic-dialogue guard)", () => {
    const body = ["「好。」", "***", "「好。」"].join("\n");
    const scenes = splitScenes(body);
    expect(scenes).toHaveLength(2);
    expect(scenes.every((s) => s.nearDuplicateOf === undefined)).toBe(true);
  });

  it("trims candidate text and re-indexes from 0", () => {
    const body = "  甲。  \n***\n  乙。  ";
    expect(splitScenes(body)).toEqual([
      { index: 0, text: "甲。" },
      { index: 1, text: "乙。" },
    ]);
  });
});

describe("chunkNovel · PR9 dirty fixtures (three genres)", () => {
  const fixture = (name: string) =>
    readFileSync(join(process.cwd(), "lib", "agent", "__fixtures__", name), "utf8");

  it("红楼·脏: 《》-prefixed + clean headings mix → 3 chapters, not collapsed to 1", () => {
    const { chapters } = chunkNovel(fixture("honglou-prefixed-dirty.txt"));
    expect(chapters.map((c) => c.marker)).toEqual(["第一回", "第二回", "第三回"]);
    // The 《书名》 prefix must NOT leak into the body (the original bug).
    expect(chapters[0].body).not.toContain("红楼梦");
    expect(chapters.every((c) => c.title.length > 0)).toBe(true);
  });

  it("红楼·脏: a multi-version repeated passage is flagged as a near-duplicate", () => {
    const { chapters } = chunkNovel(fixture("honglou-prefixed-dirty.txt"));
    const ch3 = chapters[2];
    expect(ch3.sceneCandidates.length).toBeGreaterThanOrEqual(3);
    expect(ch3.sceneCandidates.some((c) => c.nearDuplicateOf !== undefined)).toBe(true);
  });

  it("现代散文·无章回: 1 untitled chapter, >1 candidate, none over the soft target", () => {
    const { chapters } = chunkNovel(fixture("modern-prose-no-headings.txt"));
    expect(chapters).toHaveLength(1);
    expect(chapters[0].marker).toBe("");
    const cands = chapters[0].sceneCandidates;
    expect(cands.length).toBeGreaterThan(1);
    for (const c of cands) expect(c.text.length).toBeLessThanOrEqual(SCENE_SOFT_TARGET);
  });

  it("网文短章: 5 chapters incl. English Chapter/Ch., ~1 candidate each, order kept", () => {
    const { chapters } = chunkNovel(fixture("webnovel-short-chapters.txt"));
    expect(chapters).toHaveLength(5);
    expect(chapters.slice(0, 3).map((c) => c.marker)).toEqual(["第1章", "第2章", "第3章"]);
    expect(chapters[3].title).toBe("Showdown");
    expect(chapters[4].title).toBe("Epilogue");
    for (const c of chapters) expect(c.sceneCandidates.length).toBe(1);
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
      expect(c.sceneCandidates.some((s) => s.text.length > 20)).toBe(true);
    }
  });

  it("actually splits scenes on the 繁體 sample via 卻說/話說 cues", () => {
    // Regression for the simplified-only cue gap caught while dogfooding:
    // the 繁體 corpus must produce >1 scene candidate somewhere.
    const total = chapters.reduce((n, c) => n + c.sceneCandidates.length, 0);
    expect(total).toBeGreaterThan(chapters.length);
  });
});
