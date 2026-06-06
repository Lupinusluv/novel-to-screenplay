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
- 不做 reduce 的分层/流式合并（见 §10 R2）；不做 map 阶段并发限流（见 §10 R3）。

---

## 10. 评审结论与设计增量（gstack /plan-eng-review + codex outside-voice，2026-06-06）

> 本节是对 §1–§9（v1 设计）的**权威增量**。实现以本节为准；冲突处本节覆盖 v1。
> 来源：plan-eng-review 四段评审（6 决策）+ codex 跨模型冷读（12 发现，3 条新盲点）。

### 已敲定决策（覆盖 v1）

- **R1（id 确定性 / 取代 §3.3 兜底）**：`assignIds` 在分配兜底 `char_N` 和 `_2` 冲突后缀**之前**，
  先按规范 `name` 稳定排序，使兜底路径跨运行可复现。**并**在 Curator 的 LLM 调用强制 `temperature: 0`
  （codex #2：client 默认未设，否则连 slug 路径也会 run-to-run 漂移）。
- **R2（reduce 扩展天花板 / 收紧 §2 决策一措辞）**：决策一的「可扩展到长篇」**收紧**为
  「**扩展点在 map；reduce 是单次合并，长篇需分层/流式合并，列为后续**」。reduce 仍为单次 LLM 调用（MVP 够用）。
- **R3（取消并发参数 / 取代 §4 opts）**：移除 `opts.concurrency` 与手写限流器；map 阶段直接 `Promise.all`
  全部章。长篇需限流时与 R2 一并升级。
- **R4（prompt 效力门控测试 / 扩充 §7）**：新增**仅在检测到 `DEEPSEEK_API_KEY` 时运行、CI/无 key 自动 skip**
  的真 LLM 冒烟测试：拿红楼样本跑真 Curator，断言宝玉别名被合并。`npm test` 默认不烧 key（合 §8.1）。
- **R5（地点别名 / 改 PR2 schema，codex #1）**：给 `LocationSchema` 增 `aliases: string[]`（与 Character 对称），
  Curator 填入，地点合并保留变体；同步 `docs/SCHEMA.md` 一句。否则「荣府」合并后无处可存、PR5 解析不到 `loc_rongguo`。
- **R6（溯源侧表 / 反转决策四，codex #4）**：`StoryBible` 增**侧表** `provenance: Record<entityId, number[]>`
  （实体→出场章号），**不进** `Character`/`Location` 的 strictObject。数据 map 阶段已算出，不丢弃即可；
  供 PR5 按章圈定候选实体、供误合并审计。§9「不做出场章节溯源」**作废**。

### 并入实现的增量改进（codex 发现，无需再抉择）

- **I1（中间层 zod，codex #12）**：定义 `MapEntitiesSchema` / `ReduceEntitiesSchema`（zod），map/reduce 的 LLM
  输出先过各自 schema 再进业务逻辑，而非只校验最终 `Character`/`Location`。`chatJSON` 只解析不校验。
- **I2（强校验，codex #5）**：在 zod 形状之外补**确定性校验**（仿 `checkReferentialIntegrity`）：id 唯一性、
  id 格式、别名去重、规范名不混入别名、跨表 id 冲突。
- **I3（章号语义，codex #7）**：明确 map 用 `Chapter.index + 1`（1-based）作章号，对齐 `SceneSourceSchema.chapter`
  正整数；写进注释与测试。
- **I4（map 输入体积，codex #8）**：map 只发 `Chapter.body`（不发 `sceneCandidates`）；加长度上限保护，超限截断并记日志。
- **I5（丢弃要可见，codex #6）**：实体缺 `name` 丢弃时，dev/测试下返回/记录 drop 计数（>0 告警），不静默吞 LLM 失败。
- **I6（中文别名规则，codex #9 / 深化 R4）**：reduce prompt 显式约束——**别名须原文出现**；泛称/亲属称谓
  （`老爷/太太/姑娘`）须有消歧上下文才合并；不确定保持分开。冒烟测试覆盖一个「不可过度合并」用例。
- **I7（stub 按内容键控，codex #10 / 配合 R3）**：因 map 改 `Promise.all` 并发，测试 stub **按章节 marker/内容**
  键控返回，**禁止**按调用顺序，避免并发下虚假/flaky。
- **I8（CQ1 配置边界）**：`loadLLMConfigFromEnv`——部分显式 `LLM_*` + `DEEPSEEK_API_KEY` 时**报缺失项错、不回退**
  （回退仅在三者全缺）；加测试钉死。

### 测试 GAP（并入 §7，每条须有测）

零实体章 / 实体缺 name 丢弃（+drop 计数）/ map 非法 JSON 抛错带章号 / reduce 非法 JSON / 跨章 description 冲突取舍 /
稳定排序兜底可复现（R1）/ 部分配置报错（I8）/ 中间层 schema 拒绝脏数据（I1）/ 强校验命中重复 id 与跨表冲突（I2）/
门控真 LLM 冒烟：宝玉别名合并 + 一个「不可过度合并」用例（R4/I6）。

### NOT in scope（本次评审显式 defer）

- reduce 分层/流式合并（R2）——长篇才需要。
- map 并发限流（R3）——与 R2 一并。
- 跨「多次 curate」的 id 稳定（仅单次 curation 内稳定）——orchestrator/持久化是 PR6。
- timeline 抽取——schema 无对应结构。

### What already exists（复用，未重建）

`lib/llm/client.ts`（chat/chatJSON/extractJSON/retry，注入 fetch）、`lib/schema/screenplay.ts`
（`CharacterSchema`/`LocationSchema` 输出契约 + `checkReferentialIntegrity` 校验范式可仿）、
`lib/agent/chunker.ts`（`Chapter[]` 输入）、`lib/schema/fixtures.ts`（fixture 范式）。

### Failure modes（新代码路径 × 是否有测/有错误处理/是否静默）

| 失败 | 有测 | 有错误处理 | 用户可见 |
|---|---|---|---|
| map 某章 LLM 非法 JSON | 是(GAP) | 抛错带章号 | 是(冒泡 PR6) |
| reduce 过度合并别名 | 冒烟+I6 | prompt 约束 | 部分(需审计→R6) |
| romanization 缺失致 id 漂移 | 是(R1) | 稳定排序兜底 | 否(已修) |
| 实体缺 name 静默丢弃 | 是(I5) | drop 计数告警 | dev 可见 |

无「无测 且 无错误处理 且 静默」的关键 gap。

### 并行化策略

单模块（`lib/agent/storyBible.ts` + 一处 `client.ts`/`screenplay.ts` 编辑）——**顺序实现，无并行机会**。

### 实现任务（TDD 顺序）

1. **T1（P1）** schema：`LocationSchema.aliases`（R5）+ `MapEntitiesSchema`/`ReduceEntitiesSchema`（I1）+ 强校验（I2）+ SCHEMA.md。
2. **T2（P1）** 配置：`loadLLMConfigFromEnv` DeepSeek 回退 + I8 边界（先红）。
3. **T3（P1）** Curator 核心：map（I3/I4/I5）→ reduce（I6）→ `assignIds`（R1）→ 强校验 → `StoryBible{characters,locations,provenance}`（R6）；`temperature:0`；`Promise.all`（R3）；stub 按内容键控（I7）。
4. **T4（P2）** 门控真 LLM 冒烟（R4/I6），CI skip。
5. 跑 `npm test` + `npx tsc --noEmit` 贴原始输出；更新 DEVLOG/PROJECT；大审查锚 `dd47ed3`。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (optional) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open→resolved | 4 issues + 6 test gaps, all decided |
| Outside Voice | codex `exec` | Independent 2nd opinion | 1 | issues_found | 12 findings, 3 new blind spots adopted (R5/R6/I1) |
| Design Review | `/plan-design-review` | UI/UX | 0 | — | n/a (backend module) |
| DX Review | `/plan-devex-review` | Dev experience | 0 | — | n/a |

- **CROSS-MODEL:** codex confirmed Issues 1/2/3/CQ1 (stronger signal) and独立 surfaced location-aliases (R5), provenance-for-PR5 (R6), intermediate zod (I1) — adopted via user decision.
- **UNRESOLVED:** 0 — all 6 AskUserQuestion decisions answered (R1–R6); 8 fold-ins (I1–I8) accepted.
- **VERDICT:** ENG CLEARED — architecture locked, test plan complete, ready to implement (TDD). 大审查（/code-review + /security-review，锚 `dd47ed3`）仍在 `pr create` 前跑（§8.1）。
