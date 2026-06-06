import { describe, it, expect } from "vitest";
import { critiqueScene } from "./critic";
import type { Scene } from "../schema/screenplay";
import type { StoryBible } from "./storyBible";
import type { ChatMessage, ChatOptions, LLMClient } from "../llm/client";

function bible(): StoryBible {
  return {
    characters: [
      { id: "char_jiamu", name: "贾母", aliases: ["老太太"] },
      { id: "char_daiyu", name: "林黛玉", aliases: ["黛玉"] },
    ],
    locations: [{ id: "loc_rongguofu", name: "荣国府", aliases: [] }],
    provenance: {},
  };
}

function scene(): Scene {
  return {
    id: "scene_3_1",
    heading: { int_ext: "INT", location_id: "loc_rongguofu", time_of_day: "DAY" },
    synopsis: "黛玉拜见贾母。",
    source: { chapter: 3, excerpt: "黛玉初入荣国府" },
    elements: [{ type: "dialogue", character_id: "char_jiamu", line: "可怜我的儿！" }],
  };
}

interface Call {
  messages: ChatMessage[];
  opts?: ChatOptions;
}
function criticStub(raw: unknown): { llm: LLMClient; calls: Call[] } {
  const calls: Call[] = [];
  const llm: LLMClient = {
    chat: async () => "",
    chatJSON: async <T = unknown>(messages: ChatMessage[], opts?: ChatOptions) => {
      calls.push({ messages, opts });
      if (raw instanceof Error) throw raw;
      return raw as T;
    },
  };
  return { llm, calls };
}

describe("critiqueScene (2nd LLM agent: semantic self-review)", () => {
  it("T8 — surfaces a major issue (称谓不一) reported by the model", async () => {
    const { llm } = criticStub({
      issues: [
        {
          severity: "major",
          category: "naming",
          detail: "同一人物在场景里既称黛玉又称林姑娘，但 bible 未登记林姑娘别名",
          suggestion: "统一为林黛玉",
        },
      ],
    });
    const r = await critiqueScene(scene(), "原文…", bible(), llm);
    expect(r.ok).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].category).toBe("naming");
    expect(r.issues[0].severity).toBe("major");
  });

  it("T9 — a faithful clean scene yields ok=true with no issues", async () => {
    const { llm, calls } = criticStub({ issues: [] });
    const r = await critiqueScene(scene(), "原文…", bible(), llm);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(calls[0].opts?.temperature).toBe(0);
  });

  it("minor-only issues do not fail the scene (ok stays true)", async () => {
    const { llm } = criticStub({
      issues: [
        { severity: "minor", category: "other", detail: "措辞略生硬", suggestion: "润色" },
      ],
    });
    const r = await critiqueScene(scene(), "原文…", bible(), llm);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(1);
  });

  it("T10a — coerces droppable noise (a stray key on an issue) and passes", async () => {
    const { llm } = criticStub({
      issues: [
        {
          severity: "major",
          category: "fidelity",
          detail: "漏了原文一句对白",
          suggestion: "补回",
          noise: "ignore me",
        },
      ],
      extra: "top-level noise",
    });
    const r = await critiqueScene(scene(), "原文…", bible(), llm);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toEqual({
      severity: "major",
      category: "fidelity",
      detail: "漏了原文一句对白",
      suggestion: "补回",
    });
  });

  it("T10b — throws on real garbage (bad severity enum), with scene id context", async () => {
    const { llm } = criticStub({
      issues: [{ severity: "fatal", category: "other", detail: "x", suggestion: "y" }],
    });
    await expect(critiqueScene(scene(), "原文…", bible(), llm)).rejects.toThrow(/scene_3_1/);
  });

  it("T10c — throws when the LLM response is not parseable as the critique shape", async () => {
    const { llm } = criticStub(new Error("not JSON"));
    await expect(critiqueScene(scene(), "原文…", bible(), llm)).rejects.toThrow(/scene_3_1/);
  });
});
