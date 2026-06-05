# PR4 · StoryBible Curator — 设计文档（spec）

> 状态：已通过 brainstorming 评审（2026-06-06）。本文件是 PR4 的设计事实来源，
> 实现计划见后续 writing-plans 产物。背景与 PR 路线图见 `docs/PROJECT.md §4/§6`。

## 1. 目标与边界

**目标**：实现 pipeline 的首个 LLM agent——StoryBible Curator（设定集）。扫全文（Chunker
切好的 `Chapter[]`），产出**统一的人物表（aliases 合并）+ 地点表**，每个实体带**稳定 id**，
作为后续 Scene Converter 引用的**跨章共享记忆**。

**边界（不做什么，对齐 `PROJECT.md §4` 职责表）**：
- 不生成场景剧本元素（那是 PR5 Scene Converter）。
- 不碰 HTTP——依赖注入 `LLMClient`。
- 不在公开输出里加 schema 之外的字段（YAGNI，见 §6 决策四）。

## 2. 已确认的设计决策（brainstorming 结论）

| # | 决策 | 选定 | 理由 |
|---|---|---|---|
| 一 | 抽取策略 | **分章抽取 + LLM 二次合并**（map-reduce） | 可扩展到长篇、逐章可并行；合并质量靠 LLM 而非确定性 name 重叠；最能展示 agentic 架构 |
| 二 | 稳定 id 谁分配 | **确定性代码后处理** | 同一输入同一 id，可复现、好测试；LLM 职责更纯 |
| 三 | id 命名方案 | **LLM 提供 romanization 提示 + 确定性代码为权威** | 规避拼音库的多音字问题（贾 jiǎ/gǔ）；id 可读（`char_baoyu`）强化 SCHEMA.md「id 引用」叙事；代码仍是 id 权威（sanitize/去重/兜底） |
| 四 | 输出契约 | **只产 schema 已有字段**（不带出场章节溯源） | YAGNI——无消费方需要；跨章叙事已由 aliases 合并承载；`strictObject` 加字段会侵入 PR2 schema。逐章出场信息只在内部 map 阶段暂留 |

## 3. 架构形态：map-reduce + 确定性 id 后处理

```
Chapter[]  ──map(逐章, 可并行)──▶  每章局部实体表(内部含章节号)
                                      │
                                 reduce(单次 LLM 合并去重/归并别名)
                                      │
                              规范实体(无 id, 带 romanization)
                                      │
                          确定性代码：分配稳定 id + sanitize + 去重兜底
                                      │
                              zod 校验(CharacterSchema/LocationSchema)
                                      │
                                  StoryBible
```

**阶段职责**：

1. **Map（逐章 LLM）**：对每个 `Chapter`，`chatJSON` 抽取该章局部表：
   - 人物：`{ name, aliases: string[], romanization, description }`
   - 地点：`{ name, romanization, description }`
   - 约束：只抽取原文出现的实体，不编造；`aliases` 是同一实体在原文里的不同称呼。
   - 内部保留该章号（供 reduce 提示与潜在调试），**不进入最终公开输出**。

2. **Reduce（单次 LLM）**：把所有章的局部表汇总喂一次 LLM，合并跨章同一实体：
   - 归并别名（`宝玉` / `宝二爷` / `贾宝玉` → 一条人物，aliases 并齐）。
   - 选定规范 `name` 与合并后的 `aliases`、`description`、`romanization`。
   - 人物可选填 `arc`（3 章信息薄，best-effort，可空）。
   - **不分配 id。**

3. **确定性 id 分配（代码）**：
   - 把 LLM 给的 `romanization` sanitize 成 slug（小写、非 `[a-z0-9]` 转 `_`、压缩连续下划线、去首尾下划线）。
   - 人物前缀 `char_`、地点前缀 `loc_`。
   - 重名 slug 冲突 → 追加 `_2` / `_3`…
   - `romanization` 缺失/sanitize 后为空 → 回退顺序号 `char_N` / `loc_N`。
   - **代码是 id 唯一权威**。

4. **zod 校验**：每条实体过 `CharacterSchema` / `LocationSchema`，保证输出契约与 PR2 schema 硬绑定。

## 4. 模块与公开接口

新增 `lib/agent/storyBible.ts`：

```ts
import type { Chapter } from "./chunker";
import type { Character, Location } from "../schema/screenplay";
import type { LLMClient } from "../llm/client";

export interface StoryBible {
  characters: Character[];
  locations: Location[];
}

export async function curateStoryBible(
  chapters: Chapter[],
  llm: LLMClient,
  opts?: { concurrency?: number },
): Promise<StoryBible>;
```

- 输入直接吃 Chunker 的 `ChunkResult.chapters`。
- 输出是 PR2 schema 类型（`Character` / `Location`）。
- 依赖注入 `LLMClient`，**不碰 HTTP**，便于 fixture 测试。
- `concurrency` 控制 map 阶段并行度（默认 3）。

内部辅助（不导出或按需导出供测试）：
- map prompt / reduce prompt 构造函数。
- `assignIds(entities, prefix): T[]`——确定性 id 分配（sanitize + 去重 + 兜底）。

## 5. LLM 配置缺口（`PROJECT.md §6` 备注①）

扩展 `lib/llm/client.ts` 的 `loadLLMConfigFromEnv`：

- 显式 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` **优先**。
- 三者缺失但存在 `DEEPSEEK_API_KEY` 时**回退**：
  - `baseUrl = "https://api.deepseek.com"`
  - `model = "deepseek-chat"`
  - `apiKey = DEEPSEEK_API_KEY`
- 既无显式配置也无 DeepSeek key → 维持原报错（列出缺失项）。
- 单测覆盖回退分支，**不依赖真实 key**。

## 6. 错误处理

| 情况 | 处理 |
|---|---|
| LLM 返回非法 JSON | `extractJSON` 抛错，带章节上下文向上冒泡（PR6 orchestrator 接管重试） |
| 实体缺 `name` | 该条丢弃，防脏数据进表 |
| `romanization` 缺失/sanitize 为空 | id 回退 `char_N` / `loc_N`，不阻塞 |
| 某章 map 调用失败 | 传播错误（`LLMClient` 自带瞬时重试）；不静默吞 |
| reduce 输出结构非法 | zod 校验拦截，抛带定位的错误 |

## 7. 测试计划（TDD 先红，fixture，不烧 key）

注入 **stub `LLMClient`**（按调用顺序返回预置 fixture JSON），隔离纯逻辑、零网络。

- map：逐章产出局部实体表（先红，证明真在调 LLM 抽取）。
- reduce 合并：`宝玉` / `宝二爷` / `贾宝玉` → 单人物，aliases 并齐（**核心 demo 弹药**）。
- 地点合并：`荣国府` / `荣府` → 单条。
- id 分配：
  - romanization `baoyu` → `char_baoyu`；
  - 同 slug 冲突 → `_2` 后缀；
  - romanization 缺失 → `char_N` 兜底。
- 输出校验：全部实体通过 `CharacterSchema` / `LocationSchema`。
- 配置：`loadLLMConfigFromEnv` 的 DeepSeek 回退分支（含「既无显式也无 DeepSeek → 报错」）。

fixture 用《红楼梦》前三回真实片段构造（与 PR3 样本同源），确保测到真实别名密度。

## 8. 质量门禁（`PROJECT.md §8.1`）

- 每 PR 必跑：`npm test`（vitest 全绿）+ `npx tsc --noEmit`，贴原始输出。
- TDD：新测试先红再绿。
- 合并前追加 `docs/DEVLOG.md` PR4 一节。
- **PR4 是大审查批次**：`pr create` 前派 `/code-review` + `/security-review` 冷读，
  **diff 基线锚到 `dd47ed3`**（覆盖 PR3+PR4，因 PR3 已先并入 main）。
- 用户点头才 merge。

## 9. 非目标（YAGNI）

- 不做出场章节溯源字段（决策四）。
- 不引入拼音库（决策三）。
- 不实现 orchestrator / SSE / 重试编排（PR6）。
- 不做时间线抽取（§4 提到 timeline，但当前 schema 无对应结构，PR4 聚焦人物/地点；
  若后续需要再单独评估）。
