# PR6 设计 — Validator + Critic + Orchestrator + SSE

> 状态：设计草案（Phase 4）。本文件是 PR6 的权威设计来源；codex 冷读 / gstack 工程评审的增量将在末尾 §11「评审增量」累加（沿用 PR4/PR5 体例）。
> 分支 `pr6-validator-critic-orchestrator`（基于 main `42454b7`）。**PR6 是大审查批次**，diff 基线锚 `f41c257`（覆盖 PR5+PR6）。

---

## 1. 背景与目标

PR1–PR5 已就绪：`chunkNovel`（分章/分场景候选）、`curateStoryBible`（跨章人物/地点表 + 稳定 id + `provenance` 侧表）、`convertScene`（单候选→单 `Scene`，LLM 只说名字、代码权威解析 name→id，自带 issues 二分 + `sceneReferentialCheck` + `needs_review`）。schema/序列化在 `lib/schema/screenplay.ts` + `yaml.ts`。

PR6 是 agent 流水线的**收尾闭环**：把这些零件串成一条端到端管线，加上**确定性校验**（Validator）、**语义自评**（Critic，第二个纯 LLM agent）、**编排 + 自纠重试**（Orchestrator），并通过 **SSE** 把进度流式推给前端。完成后「≥3 章小说 → 结构化可编辑 YAML 剧本」端到端跑通。

**为什么现在**：这是把前 5 个 PR 的能力变成「能 demo 的产品」的关键一跳——求职作品的招牌正是这条**多 agent 自纠流水线**（规划/记忆/工具/自纠四能力），SSE 时间线是 demo 的视觉主轴。

**完成判据（可观测）**：
1. `runPipeline(novelText, llm, opts)` 对繁體前三回样本产出一个 `parseScreenplay` 通过、`checkReferentialIntegrity` 为空、scene id 全局唯一的 `Screenplay`。
2. 自纠闭环可证：注入"引用问题"的场景触发**带反馈重试**（确定性臂）；注入"语义问题"触发 **Critic 重试**（语义臂）；预算耗尽打 `needs_review` 不阻塞。
3. SSE 路由 `POST /api/convert` 流式发出 `stage_start/stage_progress/partial_result/stage_done/error` 事件，末帧带完整剧本。
4. 门禁：`npm test` 全绿 + `tsc` 干净 + `lint` 干净；TDD 先红；`LLM_SMOKE=1` 端到端真冒烟（默认 skip）。

---

## 2. 范围

**In scope**
- `lib/agent/validator.ts` — 确定性整部门禁 + 防御性单场景复检。
- `lib/agent/critic.ts` — 第二个纯 LLM agent，语义自评，输出问题清单 + 修订建议（不直接改写）。
- `lib/agent/orchestrator.ts` — 串联 + 自纠重试循环 + 并行 + 发射 SSE 事件。
- `lib/agent/sceneConverter.ts` — **改动**：加可选 `revision` 参数（D1），向后兼容。
- `app/api/convert/route.ts` — Next.js 16 SSE 路由。
- `lib/agent/sse.ts`（或同等位置）— 纯函数 `eventToSSE`，可单测。
- `docs/DEVLOG.md` — PR6 实现纪实节。

**Out of scope（YAGNI / 留给后续 PR）**
- 前端 UI（输入区/剧本卡片/YAML 视图/进度时间线渲染）→ **PR7/PR8**。本 PR 只产出 SSE 事件契约与后端，不碰 `app/page.tsx` 的可视化。
- 简体回3/6/7 语料重拉（E4 决定的独立预备步骤）→ demo 前。PR6 冒烟复用现有繁體前三回样本。
- 用户账号/数据库、PDF/Fountain 导出、多语言、实时协同（PROJECT.md 非目标）。
- 流式**逐元素**生成单个场景（partial token streaming）；PR6 的流式粒度是**逐场景**（`partial_result` per scene），足够 demo。

---

## 3. 角色契约（精确签名）

### 3.1 `convertScene` 改动（D1：反馈注入）

`convertScene` 把 `temperature` 钉死在 0（确定性、可复现）。**同样输入重跑 = 一模一样输出**，所以重试必须改变输入。决策 D1=A：加可选 `revision` 参数，把上一版的问题 + 上一版场景**喂回 prompt**，温度仍保持 0——这是真正的「带反馈自纠」，不是靠随机性碰运气。

```ts
export interface SceneRevision {
  /** 上一版存在的问题（确定性臂来自 ConversionIssue，语义臂来自 Critic 建议）。 */
  critique: string[];
  /** 上一版场景，供模型"修订"而非"重写"。可选（首版无）。 */
  prior?: Scene;
}

export async function convertScene(
  candidate: SceneCandidate,
  chapter: number,
  bible: StoryBible,
  llm: LLMClient,
  revision?: SceneRevision,   // 新增可选参数，向后兼容
): Promise<SceneConversionResult>;
```

渲染：当 `revision` 存在时，在现有 system+user 两条消息后追加一条 user 消息：
```
上一版转换存在以下问题，请据此修订（保持只用所给人物/地点称呼、忠实原文、严格 JSON）：
- <critique[0]>
- <critique[1]>
（可选）上一版结果：<JSON.stringify(prior 的精简视图)>
```
其余逻辑（coerce / resolver / E1–E6 / assemble / 自检）完全不变。PR5 的 48 个 fixture 测**不受影响**（不传 revision 即旧行为）——这是向后兼容的硬约束，必须有一条测试钉死「不传 revision 时 prompt 与 PR5 一致」。

### 3.2 `validator.ts`（D3：整部门禁 + 跨章去重）

确定性，无 LLM，无语义判断。Converter 已保证**单场景** schema 合法 + 引用干净，所以 Validator 的真实价值在**整部 Screenplay 汇编后**的整体门禁 + 跨章 scene id 唯一性普查（I10）。

```ts
export interface ValidationReport {
  ok: boolean;
  /** 整部结构校验（ScreenplaySchema.safeParse）失败信息，扁平化为可读字符串。 */
  structural: string[];
  /** checkReferentialIntegrity 的逐条结果（应为空）。 */
  references: ReferenceIssue[];
  /** 跨章重复的 scene id（I10；按构造应为空，非空即 bug）。 */
  duplicateSceneIds: string[];
  /** 带 needs_review 标记的 scene id 普查（供前端高亮 / demo 讲述）。 */
  needsReview: string[];
}

/** 整部门禁。checkReferentialIntegrity 对 screenplay 自带的顶层 characters/
 *  locations 表校验（orchestrator 汇编时已从 bible 填入），无 bible 参数（E11）。 */
export function validateScreenplay(screenplay: Screenplay): ValidationReport;

/** 循环内对单场景的防御性复检（E12）：断言 Converter 的"schema 合法 + 引用干净"
 *  承诺。两者皆空 = 通过；非空 = Converter 违约（orchestrator 处理）。 */
export function validateScene(
  scene: Scene,
  bible: StoryBible,
): { structural: string[]; references: ReferenceIssue[] };
```

> ⚠️ §3.2 的签名以 **§11 E11/E12 为准**（本框已对齐）。

> 注：scene id = `scene_<chapter>_<index+1>`，chapter 唯一、index 章内唯一 ⇒ **id 本就全局唯一**。`duplicateSceneIds` 因此是防御性断言（出现即上游 bug），但 D3=A 要求 Validator 拥有这条普查，不外推给 orchestrator。

### 3.3 `critic.ts`（第二个纯 LLM agent）

语义自评：人物矛盾 / 称谓不一 / 漏对白 / 是否还原原文。输出问题 + 建议，**不直接改写**（建议回灌 Converter 的 `revision.critique`）。沿用 PR4 I7：system prompt 不放实体示例，stub 可纯按 user 消息路由；temperature 0。

```ts
export type CritiqueCategory =
  | "character_inconsistency"  // 人物矛盾
  | "naming"                   // 称谓不一
  | "missing_dialogue"         // 漏对白
  | "fidelity"                 // 偏离原文
  | "other";

export interface CritiqueIssue {
  severity: "minor" | "major";
  category: CritiqueCategory;
  detail: string;       // 哪里错了
  suggestion: string;   // 怎么改（回灌，不直接应用）
}

export interface CritiqueResult {
  ok: boolean;                 // 无 major 即 ok（minor 不强制重试）
  issues: CritiqueIssue[];
}

export async function critiqueScene(
  scene: Scene,
  candidateText: string,       // 原文，供"是否还原"判定
  bible: StoryBible,           // 供称谓/人物一致性判定
  llm: LLMClient,
): Promise<CritiqueResult>;
```

形状处理与 Converter 同philosophy：用 zod 校验 LLM 输出形状，可平凡修复的噪音 coerce 丢弃，真垃圾抛错（带 scene id 上下文）。`ok = issues 中无 severity==="major"`（minor 记录但不触发重试，避免无谓烧调用）。

### 3.4 `orchestrator.ts`（编排 + 自纠 + 并行 + SSE）

```ts
export type Stage = "chunk" | "storybible" | "scenes" | "assemble";

export type PipelineEvent =
  | { type: "stage_start"; stage: Stage; total?: number }
  | { type: "stage_progress"; stage: Stage; done: number; total: number; sceneId?: string }
  | { type: "partial_result"; scene: Scene }       // 逐场景流式（完成顺序，E5b）
  | { type: "stage_done"; stage: Stage }
  | { type: "final_result"; screenplay: Screenplay; yaml: string }  // 末帧，E10
  | { type: "error"; stage: Stage; sceneId?: string; message: string };

export interface OrchestratorOptions {
  retryBudget?: number;                    // 每臂最大重试次数，默认 2（§4）
  critic?: boolean;                        // 是否启用 Critic，默认 true（D2）
  criticScope?: "all" | "needs_review";    // Critic 范围，默认 "all"（D2=A；语义见 E4）
  concurrency?: number;                    // 场景并行度，默认 4
  onEvent?: (e: PipelineEvent) => void;    // 事件回调，transport-agnostic
  signal?: AbortSignal;                    // 透传给每个 llm 调用，支持取消（E7）
  title?: string;                          // 默认派生（见 §3.5）
  logline?: string;                        // 默认占位（见 §3.5）
}

export async function runPipeline(
  novelText: string,
  llm: LLMClient,
  opts?: OrchestratorOptions,
): Promise<Screenplay>;
```

**onEvent 而非直接写 SSE**：orchestrator 不知道 HTTP，只发回调；`route.ts` 把回调适配成 SSE 帧。好处：orchestrator 可用 fixture + fake llm 纯函数式单测，不碰网络。

### 3.5 title / logline 来源

`ScreenplaySchema` 要求 `title` / `logline` 非空。PR6 **确定性派生**，不额外烧 LLM：
- `title` = `opts.title ?? (首章 title 非空 ? 首章 title : "未命名剧本")`。
- `logline` = `opts.logline ?? "（自动生成，待人工润色）"`。
- 注：「用一句话 LLM 生成 logline」是后续 PR7/8 的打磨增量，PR6 不做（避免 scope 蔓延 + 多一次 LLM 调用）。

---

## 4. self-correction 闭环（重试语义）

> ⚠️ **本节的循环伪代码以 §11 E1–E5 为权威**（codex 冷读收紧后：双层「确定性修复到不动点 → Critic → 再修复到不动点」+ throw 纳入重试 + 不动点/环检测 + 并行定序）。下面是初稿直觉版，**实现按 §11 E1**。

每个场景跑两条重试臂，各自独立预算（默认 2），都用 D1 的 `revision` 把反馈喂回 Converter：

```
attempt = convertScene(candidate, chapter, bible, llm)          // 首版，无 revision

# 确定性臂（Validator 视角）：Converter 报了引用问题 → 带反馈重试
tries = 0
while attempt.issues.length > 0 and tries < retryBudget:
    feedback = issuesToFeedback(attempt.issues, scopedCast)     // 列出坏 surface + 可用称呼
    attempt = convertScene(candidate, chapter, bible, llm, {critique: feedback, prior: attempt.scene})
    tries += 1

# 语义臂（Critic 视角）：仅当 critic 启用且 (scope=all 或 该场景 needs_review)
if critic and (criticScope == "all" or attempt.scene.needs_review):
    ctries = 0
    crit = critiqueScene(attempt.scene, candidate.text, bible, llm)
    while not crit.ok and ctries < retryBudget:
        attempt = convertScene(candidate, chapter, bible, llm,
                               {critique: crit.issues.filter(major).map(suggestion), prior: attempt.scene})
        crit = critiqueScene(attempt.scene, candidate.text, bible, llm)
        ctries += 1
    if not crit.ok:                # 预算耗尽仍有 major
        attempt.scene.needs_review = true

# 收尾：防御性 validateScene（应通过）；任何残留 issue ⇒ needs_review 必为 true
final = attempt.scene
```

- **不阻塞**：任一臂耗尽预算都不抛错，保留最后一版 + `needs_review=true`，继续下个场景（§4 设计）。
- **并行**：章内/跨章场景用 `Promise.all` + 并行度上限（`concurrency`，仿 `curateStoryBible` 的 map）。`stage_progress` 用一个完成计数器（`done/total`），并行下用原子自增。
- **确定性臂的 feedback** 是确定性文本（无 LLM）：把 `ConversionIssue.surface`/`where` 拼成"X 不在人物表，请用以下称呼之一：…"。

---

## 5. 关键设计决策（用户拍板）

| # | 决策 | 选项 | 理由 |
|---|---|---|---|
| **D1** | 重试如何让 Converter 产出不同结果 | **A：反馈注入 prompt**（加可选 `revision` 参数，温度仍 0） | 真正的「带反馈自纠」，演示价值最高；向后兼容 PR5。否则 temp=0 重试是白跑。 |
| **D2** | Critic 对哪些场景跑 | **A：全量逐场 + 并行 + 配置开关** | 实测成本 ≈ $0.03/次（可忽略），最能展示「责编逐场审稿」headline agent；延迟靠 `Promise.all` 并行 + SSE 进度化解。 |
| **D3** | Validator 职责 | **A：整部门禁 + 跨章 id 去重 + needs_review 普查** | Converter 已自查单场景；真空白在整部汇编校验 + 跨章 id 唯一性（I10）。确定性逻辑归确定性工具。 |
| **默认** | SSE 发射机制 | 注入 `onEvent` 回调，route.ts 适配 | orchestrator 不耦合 HTTP，可 fixture 单测。 |

**成本实测依据**（D2）：繁體前三回样本 = 3 章 / 9 场景候选。全量跑（curate 4 + convert 9 + critic 9 + 重试 ~10 ≈ 32 次调用）≈ 输入 37k / 输出 17k tokens，按 `deepseek-chat`（$0.27/1M in、$1.10/1M out）≈ **$0.03/次**；3× 悲观仍 < $0.10。瓶颈是延迟（串行 1.5–2.5 min），用并行 + SSE 进度化解。

---

## 6. SSE 事件契约

- 端点：`POST /api/convert`，body `{ "novel": "<全文>" , "options"?: {...} }`。
- 响应：`Content-Type: text/event-stream`，每事件一帧 `data: <JSON>\n\n`。
- 事件类型见 §3.4 `PipelineEvent`。顺序保证：
  ```
  stage_start(chunk) → stage_done(chunk)
  stage_start(storybible) → stage_done(storybible)
  stage_start(scenes, total=N) → [stage_progress×N, partial_result×N 交错] → stage_done(scenes)
  stage_start(assemble) → stage_done(assemble)
  最终帧：stage_done(assemble) 后发一条完整结果（screenplay JSON + YAML 文本）
  ```
- 错误：任一 stage 抛错 → 发 `error` 事件（带 stage + message）后关闭流。**致命**错误（如 bible 无地点、LLM 完全不可用）才走 error；单场景重试耗尽是 `needs_review`，不是 error。
- `eventToSSE(event): string` 是纯函数，单测覆盖编码（含尾部 `\n\n`、JSON 转义）。

> Next.js 16 路由 API 与训练记忆可能不同（AGENTS.md 警告）。实现前**必读** `node_modules/next/dist/docs/` 里 Route Handler / streaming 相关指南，确认 `POST(req: Request): Promise<Response>` + `ReadableStream` 的正确写法与 `export const runtime` / `dynamic` 配置。

---

## 7. 数据流与类型复用

```
novelText
  └─ chunkNovel ──▶ ChunkResult { chapters: Chapter[] }       (PR3)
        └─ curateStoryBible(chapters, llm) ──▶ StoryBible      (PR4，稳定 id + provenance)
              └─ 逐 chapter 逐 candidate（并行）：
                    convertScene(candidate, chap, bible, llm, revision?) ──▶ {scene, issues}   (PR5+D1)
                       ├─ 确定性臂重试（issues→feedback→revision）
                       └─ 语义臂重试（critiqueScene→suggestion→revision）         (PR6 critic)
              └─ 汇编 scenes + bible.characters/locations + title/logline ──▶ Screenplay
                    └─ validateScreenplay ──▶ ValidationReport（门禁 + 普查）        (PR6 validator)
                    └─ toYAML ──▶ YAML 文本                                          (PR2)
  全程 onEvent 发 PipelineEvent；route.ts 适配为 SSE。
```

无新增 schema：复用 `Screenplay/Scene/Character/Location/ReferenceIssue` + `StoryBible`。新增类型都在各 agent 文件内导出（`ValidationReport` / `CritiqueResult` / `SceneRevision` / `PipelineEvent` / `OrchestratorOptions`）。

---

## 8. 测试计划（TDD，先红后绿）

单测一律 fixture + fake `LLMClient`（实现 `chat`/`chatJSON`，按 user 消息内容路由——PR4 I7 内容键控 stub），零网络。

| # | 目标 | 层 |
|---|---|---|
| T1 | `validateScreenplay`：合法剧本 ok=true、空 references | 单元 |
| T2 | `validateScreenplay`：构造悬空引用 → references 非空、ok=false | 单元 |
| T3 | `validateScreenplay`：注入重复 scene id → duplicateSceneIds 命中 | 单元 |
| T4 | `validateScreenplay`：needs_review 普查列出对应 id | 单元 |
| T5 | `validateScene`：干净场景返回 null；悬空引用返回 ReferenceIssue[] | 单元 |
| T6 | `convertScene` 传 `revision` → prompt 含 critique 文本（stub 断言消息体） | 单元 |
| T7 | `convertScene` **不传** revision → prompt 与 PR5 完全一致（向后兼容回归） | 单元 |
| T8 | `critiqueScene`：注入称谓不一/漏对白的场景 → 返回对应 category 的 major issue | 单元 |
| T9 | `critiqueScene`：忠实干净场景 → ok=true、issues=[] | 单元 |
| T10 | `critiqueScene`：形状噪音 coerce 通过、真垃圾抛错（带 scene id） | 单元 |
| T11 | `eventToSSE`（E9）：编码出 `event: <type>\ndata: {...}\n\n`、JSON 正确转义 | 单元 |
| T12 | `runPipeline` happy path（fake llm）→ 产出 parseScreenplay 通过、references 空、id 唯一的 Screenplay | 集成 |
| T13 | `runPipeline` 确定性臂：首版有 issue 的场景触发带 feedback 重试，预算耗尽停、打 needs_review | 集成 |
| T14 | `runPipeline` 语义臂：Critic 报 major → 重试；耗尽 → needs_review=true | 集成 |
| T15 | `runPipeline` 事件顺序 + 进度计数（stage_start/progress/partial/done 序列、done==total） | 集成 |
| T16 | `runPipeline` `criticScope`：`needs_review` 模式下干净场景不调 critic（stub 计数） | 集成 |
| T17 | `runPipeline` 并行：concurrency 限制下全部场景仍完成，且 `scenes[]` 为确定性章节序（E5b——故意让靠后场景的 fake llm 先返回，断言顺序不被打乱） | 集成 |
| T18 | `runPipeline` throw 处理（E2）：fake llm 对某场景持续吐坏 JSON → 预算耗尽插入占位 needs_review 场景 + 发 error 事件，整部仍产出 | 集成 |
| T19 | `runPipeline` 不动点早停（E3）：fake llm 重试返回逐字相同场景 → 不再调用、打 needs_review（stub 计数证明早停） | 集成 |
| T20 | `runPipeline` 环检测（E5）：A→B→A 振荡 → 命中 seen 即停，保留最佳确定性干净候选 | 集成 |
| T21 | `runPipeline` abort（E7）：触发 `signal` → 后续 llm 不再被调用、流可停（stub 计数 + guard） | 集成 |
| T22 | `final_result` 事件（E10）：流末发 `{type:"final_result", screenplay, yaml}`，yaml 可 `fromYAML` 往返 | 集成 |
| T23 | **门控真冒烟** `LLM_SMOKE=1`：runPipeline 跑繁體前三回样本，断言产出合法 Screenplay + 至少 1 场景含 dialogue 或合理 needs_review（默认 skip） | 冒烟 |

route.ts 本身保持极薄（parse req → runPipeline(onEvent=enqueue SSE) → stream），逻辑都在可测的 orchestrator/eventToSSE 里；route 端到端由 T18 真冒烟覆盖（可选另加一条结构 smoke）。

---

## 9. 文件清单

| 文件 | 改动 |
|---|---|
| `lib/agent/sceneConverter.ts` | 加可选 `SceneRevision` 参数 + prompt 追加渲染（D1）；导出 `SceneRevision` |
| `lib/agent/validator.ts` | 新增：`validateScreenplay` / `validateScene` / `ValidationReport`（D3） |
| `lib/agent/critic.ts` | 新增：`critiqueScene` / `CritiqueResult` / `CritiqueIssue`（第二个 LLM agent） |
| `lib/agent/orchestrator.ts` | 新增：`runPipeline` / `PipelineEvent` / `OrchestratorOptions` / `Stage` |
| `lib/agent/sse.ts` | 新增：`eventToSSE` 纯函数 |
| `app/api/convert/route.ts` | 新增：Next 16 SSE 路由（薄适配层） |
| `lib/agent/validator.test.ts` / `critic.test.ts` / `orchestrator.test.ts` / `sse.test.ts` | 新增测试 |
| `lib/agent/sceneConverter.test.ts` | 加 D1 回归测（T6/T7） |
| `lib/agent/orchestrator.smoke.test.ts` | 新增门控真冒烟（T18） |
| `docs/DEVLOG.md` | PR6 实现纪实节 |

---

## 10. 门禁与大审查

- **每-PR 轻量门禁（A 档）**：`npm test` 全绿 + `npx tsc --noEmit` exit 0 + `npm run lint` 干净，贴原始输出；TDD 先红证据；更新 DEVLOG；用户点头才 merge。
- **大审查（B 档，PR6 是批次）**：`pr create` 前派 `/code-review` + `/security-review` 冷读 `git diff f41c257...HEAD`（覆盖 PR5+PR6 两批），结论交用户。**基线必须锚 `f41c257`**（PR4 合并点），用 `main...` 会漏掉已并入 main 的 PR5。
- codex 跨模型冷读：本设计落盘后跑 `codex exec` 冷读（gstack 约定），增量记入 §11。

---

## 11. 评审增量（codex 冷读权威覆盖）

> **本节是对正文的权威覆盖**（沿用 PR4/PR5 §11 体例）。2026-06-06 codex 跨模型冷读（read-only，`model_reasoning_effort=medium`）对草案打 **6/10**，逮到 17 条；下面 E1–E14 是采纳并细化后的权威增量，E15 记录一条驳回。冲突时以本节为准。

### 自纠循环（codex #1/#3/#2/#4/#5 — 最关键）

- **E1（HIGH，覆盖 §4）单臂改双层「修复到不动点」**。重试不是「确定性臂跑完再跑语义臂」两段，而是嵌套：
  ```
  # 确定性修复到不动点（含对 throw 的处理，见 E2）
  def convergeDeterministic(candidate, chap, bible, llm, budget, revision=None):
      attempt = tryConvert(candidate, chap, bible, llm, revision)   # E2 包 throw
      tries = 0
      while attempt.issues.length > 0 and tries < budget:
          fb = issuesToFeedback(attempt.issues, scopedCast)
          nextAttempt = tryConvert(candidate, chap, bible, llm,
                                   {critique: fb, prior: attempt.scene})
          if sceneHash(nextAttempt.scene) == sceneHash(attempt.scene): break  # E3 不动点
          attempt = nextAttempt; tries += 1
      return attempt

  attempt = convergeDeterministic(...)                 # 首轮
  if critic and inCriticScope(attempt.scene):
      ctries = 0
      crit = critiqueScene(attempt.scene, candidate.text, bible, llm)
      seen = { sceneHash(attempt.scene) }              # E5 跨臂环检测
      while not crit.ok and ctries < budget:
          revised = convergeDeterministic(..., {critique: majorSuggestions(crit), prior: attempt.scene})
          # 关键：语义改写后 **再次确定性修复到不动点**，语义臂不会留下未检的引用问题
          h = sceneHash(revised.scene)
          if h in seen: break                          # 环 → 停，保留当前最佳
          seen.add(h); attempt = revised
          crit = critiqueScene(attempt.scene, candidate.text, bible, llm)
          ctries += 1
      if not crit.ok: attempt.scene.needs_review = true
  final = attempt.scene
  ```
  要点：① **每次 convert（含语义改写）后都跑确定性修复到不动点**，杜绝「Critic 把场景改出新的未解析引用却没人复检」（codex #1/#3）；② Critic 只在确定性已 settle 的场景上跑。

- **E2（HIGH，覆盖 §4）convertScene 的 throw 必须纳入重试语义**。`convertScene` 对坏 JSON / 坏 shape 会**抛错**（非返回 issues）。`tryConvert` 包裹：捕获后按确定性预算重试（模型吐垃圾，重试常能恢复）；**预算耗尽**则不让一个坏场景毁掉整部小说——插入一个**最小占位 `Scene`**（`elements=[{action: 原文 excerpt}]`、`needs_review=true`、heading 用 `dominantLocation` 兜底）并发 `error` 事件（带 stage+sceneId+message）。注意区分：`sceneReferentialCheck` 的「dangling references (bug)」throw 是**真 bug**，不重试、直接冒泡（按构造不该发生）。

- **E3（MED，覆盖 §4）不动点早停**。temp=0 下同样的 critique 会复现同样的坏场景；用 `sceneHash(scene)`（对 `JSON.stringify(scene)` 取稳定哈希）比较：若一次重试产出与上一版**逐字相同**，立即停（不再烧调用）并打 `needs_review`。

- **E5（MED，覆盖 §4）跨臂环检测 + 保留最佳**。两臂的 critique 文本不同，仍可能 A→B→A 振荡。维护 `seen` 哈希集跨两臂；命中即停，保留**最后一个确定性干净**的候选（issues 最少者）。

- **E4（MED，覆盖 §3.4）criticScope 精确定义**（在**确定性不动点之后**求值）：`"all"`（默认，D2）= 每个 settle 后的场景都过 Critic；`"needs_review"` = 只对 settle 后**仍带 needs_review**（残留未解析引用/截断）的场景过 Critic。语义无歧义，因为求值点固定在确定性 settle 之后。

### 并行与事件（codex #7/#8/#9/#12/#13/#10/#11）

- **E5b（HIGH，覆盖 §4）并行不得打乱产出顺序**。每个场景按**全局序**（chapter, candidate.index）定位存入预分配槽位；所有 worker 完成后**按序汇编** `scenes[]`。`partial_result` 可按**完成顺序**发（流式体验），但最终 `Screenplay.scenes` 必须是确定性章节序。

- **E6（MED，覆盖 §6）进度计数 = 完成的场景候选数，不是 attempt 数**。`stage_progress.done` 只在一个候选**彻底 settle（含所有重试）**后自增一次；`done==total` 收尾。每完成一个场景，**固定先发 `partial_result` 再发 `stage_progress`**，并在并发测试里钉死这个顺序（codex #9）。

- **E10（MED，覆盖 §3.4/§6）最终结果是 typed 事件**。`PipelineEvent` 增一支 `{ type: "final_result"; screenplay: Screenplay; yaml: string }`，取代「正文散文描述的末帧」。流末发 `final_result`。

- **E9（MED，覆盖 §6）SSE 用 typed event 通道**。`eventToSSE` 输出 `event: <type>\ndata: <json>\n\n`（不是只 `data:`），单测钉死格式；前端按 `event` 类型分发。

- **E7（HIGH，覆盖 §3.4/§6）abort 全链路打通**。`OrchestratorOptions` 增 `signal?: AbortSignal`；`runPipeline` 把它透传给每个 `llm.chat*`（client 已支持 `opts.signal`，client.ts:37）。route 把 `req.signal` 传入，并在 `onEvent` 里 **guard `controller.enqueue`**（流已关/已 abort 则不 enqueue），`ReadableStream.cancel` 时停止后续工作。

- **E8（HIGH，覆盖 §6）锁定 Next 16 路由 runtime**。实现前**必读** `node_modules/next/dist/docs/` 的 Route Handler/streaming 章节，显式设置 route 段配置（预期 `export const runtime = "nodejs"`、`export const dynamic = "force-dynamic"`，禁用缓冲），并用**真实 `ReadableStream` 响应**测首字节流式行为（不是等全部生成再返回）。

### 契约修正（codex #14/#15/#16/#6）

- **E11（HIGH，覆盖 §3.2）`validateScreenplay` 签名修正**。删除「bible 传入则…」的过时措辞——`checkReferentialIntegrity` 本就对 `screenplay` **自带的顶层 characters/locations 表**校验（orchestrator 汇编时已从 bible 填入这两张表）。最终签名：`validateScreenplay(screenplay: Screenplay): ValidationReport`，无 bible 参数。

- **E12（MED，覆盖 §3.2）`validateScene` 返回富报告**。改为 `validateScene(scene, bible): { structural: string[]; references: ReferenceIssue[] }`（两者皆空 = 通过），使其能报告结构性 zod 错误，而非 `ReferenceIssue[] | null` 表达不了结构问题。

- **E13（MED，覆盖 §8 T7）向后兼容断言精确化**。`revision` 缺省时 `buildScenePrompt` 输出**逐字节不变**；仅当 `revision` 存在时**追加**一条 user 消息。T7 直接断言两条消息数组与 PR5 相等。

- **E14（采纳，§3.4）`criticScope` 取值维持 `"all" | "needs_review"`**（E4 已给精确语义），不引入 codex 建议的第三档 `"clean_only"`——在 E1 的「先确定性 settle 再 critic」结构下，`"all"` 已等价覆盖「对干净场景做语义检查」，第三档冗余。

### 驳回

- **E15（驳回 codex #17）title 派生安全**。codex 担心 `Chapter` 无 `title` 字段;经核 `chunker.ts:41` 确有 `title: string`（无标题为空串），§3.5 的「首章 title 非空则用之、否则 "未命名剧本"」成立，无需改动。

### 评分

codex 初评 **6/10**（「架构可实现，但重试循环契约需在编码前收紧」）。E1–E14 已收紧重试不动点、throw 语义、并行定序、事件 typed 化、abort 链路与契约签名；预期复评 ≥7。是否复跑 codex 由用户定。
