# PR5 · Scene Converter — 设计文档（spec）

> 状态：已通过 brainstorming 评审（2026-06-06）。本文件是 PR5 的设计事实来源，
> 实现计划见后续 writing-plans 产物。背景与 PR 路线图见 `docs/PROJECT.md §4/§6`。
> 复用 PR4 产出：`StoryBible`（`characters`/`locations` 带稳定 id + `provenance` 侧表）。

## 1. 目标与边界

**目标**：实现 pipeline 的第二个 LLM agent——Scene Converter（场景编剧）。把**单个场景候选**
（Chunker 的 `SceneCandidate` 文本 + 1-based 章号）转换为一个结构化 `Scene`（PR2 schema），
**强制引用 StoryBible 已有的稳定 id**（`heading.location_id` / `dialogue.character_id`）。

**边界（不做什么，对齐 `PROJECT.md §4` 职责表）**：
- **不新增/修改人物或地点**——只引用 Bible 已有实体（新增是 Curator 的事，PR4）。
- **不跨场景**——一个候选 → 一个 `Scene`，不拆、不并、不重排。
- **不做校验/自评/编排重试**——`Validator`/`Critic`/`Orchestrator` 是 PR6。本模块只产出
  「最佳努力的单场景 + 带定位的未解析引用报告」，把重试决策留给 PR6。
- **不碰 HTTP**——依赖注入 `LLMClient`，便于 fixture 测试。

## 2. 已确认的设计决策（brainstorming 结论）

| # | 决策 | 选定 | 理由 |
|---|---|---|---|
| D1 | id 引用策略 | **LLM 只输出名字，代码解析 name→id**（延续 PR4 决策三「LLM 提示、代码权威」） | LLM 不擅长精确复制 `char_lin_dai_yu` 这种 id，却很擅长写人物名；代码用 Bible 的 `name + aliases` 反查 id，**天然消化别名**（「宝二爷」→ `char_baoyu`）；LLM 永不接触 id |
| D2 | source / id / excerpt 谁权威 | **确定性代码**（LLM 不碰溯源） | `source.chapter` = 候选的章号（已知）、`source.excerpt` = 候选文本头部（已知原文）、`scene.id` = `scene_<章>_<序>`（可复现）。代码已知原文，**绝不让 LLM 臆造溯源**——闭合 SCHEMA.md「反幻觉/可信」叙事 |
| D3 | 解析不到 id 时 | **最佳努力净场景 + issues 报告** | `convertScene` 返回 `{scene, issues}`：未解析说话人→降级为 `action`（保留台词文本）；未解析地点→回退本章主导地点；两者置 `needs_review` + 返回带定位 issue。场景永远 schema 有效 + 引用干净，issues 驱动 PR6 重试 |
| D4 | prompt 里展示多少 cast | **按 `provenance` 圈本章实体 + 全库代码兜底** | prompt 只展示 provenance 含本章的人物/地点（token 经济 + 聚焦，兑现 PR4 codex R6 投资）；但**代码 name→id 解析用全 bible**，跨章别名仍能解析，抵消 curator provenance 不全的风险 |
| D5 | 粒度契约 | **一候选 → 一 `Scene`**（不拆/不并/不重排） | 对齐 §4「不跨场景」边界；单场景=单次 LLM 调用=单一职责，最易测；候选不完美的再切分留给后续（PR6 Critic 可打 `needs_review`），本模块忠实转换 |
| D6 | 结构 vs 引用 二分 | **结构垃圾抛错 / 引用未命中走 issues** | 把 PR2「结构有效 vs 引用完整」的分离一路贯彻：坏枚举/缺字段/多字段 = 结构垃圾 → 中间层 zod **抛错**（交 PR6 重试）；名字不在 bible = 引用未命中 → D3 最佳努力 + issues。两类问题分流，互不污染 |
| S | demo / 冷烟样本 | **《红楼梦》回3+回6+回7，简体** | 回3 黛玉进贾府（群戏、对白密、别名丰、地点清晰）作台柱；回6 劉姥姥一進、回7 送宮花续家庭群戏线；鳳姐/寶玉/黛玉跨三回反复出场→跨章合并弹药足。简体便于 demo 展示（§6 待议①）。详见 §8 |

## 3. 架构形态：scope → LLM 转换 → 解析 → 组装 → 校验

```
SceneCandidate + chapter + StoryBible
        │
   scope cast(确定性): provenance 圈本章人物/地点 → 规范名+aliases(无 id)
        │
   LLM 转换(单次 chatJSON, temperature:0): 输出用【名字】的 raw scene
        │   { heading:{int_ext, location(名), time_of_day}, synopsis, elements[ {action|dialogue(speaker 名)|transition} ] }
        │
   中间层 zod(RawSceneSchema, strict): 坏枚举/缺字段 → 抛错(D6)
        │
   解析 name→id(确定性, 全 bible): location 名→location_id; speaker 名→character_id
        │   未解析: 地点回退本章主导地点; 说话人降级 action; 记 issue + needs_review(D3)
        │
   组装 Scene(确定性掌权): id=scene_<章>_<序>; source={chapter, excerpt 头部}; synopsis(LLM); needs_review
        │
   校验: SceneSchema.parse + 对 bible 本地引用自检(防御, 按构造恒空)
        │
   { scene, issues }
```

**阶段职责**：

1. **Scope cast（确定性，无 LLM）**：从 `bible.provenance` 选出 provenance 含本章号的人物/地点，
   构造给 LLM 看的 cast 清单（规范 `name` + `aliases`，**不含 id**）。本章无候选时退回全 bible（兜底）。

2. **LLM 转换（单次 `chatJSON`，`temperature: 0`）**：system 约束「只能用所给 cast 的称呼、忠实原文、
   不新增人物地点」；user 给场景原文 + cast 清单。输出 raw scene（元素用**名字**）：
   - `heading: { int_ext: INT|EXT, location: <名字>, time_of_day: <枚举> }`
   - `synopsis: <一句话>`
   - `elements: [ {type:action,text} | {type:dialogue,speaker:<名字>,parenthetical?,line} | {type:transition,text} ]`
   - LLM 负责语义：INT/EXT 与日夜推断、动作/对白/转场分解、按名字归属说话人。

3. **中间层 zod（I1 风格，`RawSceneSchema` strict）**：校验 LLM 输出形状，复用 schema 的
   `IntExt`/`TimeOfDay` 枚举。**坏枚举/缺字段/多字段 → 抛错**（D6 结构垃圾，PR6 重试）。

4. **解析 name→id（确定性，代码权威，全 bible）**：
   - 建 resolver：把每个实体的 `name` 与每个 `alias` 归一化（去空白、大小写）映射到其 id（人物表、地点表各一份）。
   - `heading.location` 名 → `location_id`；解析不到 → 回退**本章主导地点**（provenance 含本章的地点中
     出场章数最多者，并列取规范名码点序最小者；本章无任何地点 → 回退全 bible 同法），记 `unresolved_location` issue。
   - 每个 `dialogue.speaker` → `character_id`；解析不到 → 该元素**降级为 `action`**，`text` = 原 `line`
     原样（**不加说话人名前缀**——该名未在 bible 命中、属未核实信息，不注入旁白），记 `unresolved_character` issue。
   - 任一未解析 → `needs_review = true`。

5. **组装 Scene（确定性掌权 source 与 id）**：
   - `id = scene_<chapter>_<candidate.index + 1>`（代码定，可复现）。
   - `source = { chapter, excerpt }`，`excerpt` = `candidate.text` 头部截断（上限 `SCENE_EXCERPT_CAP`，
     保证 `min(1)`；候选已被 Chunker trim 过、非空）。
   - `heading`/`elements` = 解析后结果；`synopsis` = LLM；`needs_review` 按 D3。

6. **校验**：`SceneSchema.parse(scene)`（结构）+ 对本 bible 跑一次引用自检（防御——按构造应恒为空；
   非空即代码 bug，抛错）。返回 `{ scene, issues }`。

## 4. 模块与公开接口

新增 `lib/agent/sceneConverter.ts`：

```ts
import type { SceneCandidate } from "./chunker";
import type { StoryBible } from "./storyBible";
import type { Scene } from "../schema/screenplay";
import type { LLMClient } from "../llm/client";

/** 一条解析不到 Bible id 的引用报告（仿 PR2 ReferenceIssue / PR4 BibleIssue）。 */
export interface ConversionIssue {
  kind: "unresolved_character" | "unresolved_location";
  /** LLM 给的、解析不到的表面名字。 */
  surface: string;
  /** 定位，如 `elements[2].speaker` / `heading.location`。 */
  where: string;
  /** 实际兜底动作，如 `demoted to action` / `fell back to loc_xx`。 */
  resolution: string;
}

export interface SceneConversionResult {
  /** 永远 schema 有效 + 对 bible 引用干净。 */
  scene: Scene;
  /** 空数组 = 全部引用命中。 */
  issues: ConversionIssue[];
}

export async function convertScene(
  candidate: SceneCandidate,
  chapter: number, // 1-based，对齐 SceneSourceSchema.chapter
  bible: StoryBible,
  llm: LLMClient,
): Promise<SceneConversionResult>;
```

内部辅助（纯函数，按需导出供测试，全部确定性、零网络）：
- `scopeCast(bible, chapter)` → 本章 cast（provenance 圈定 + 兜底）。
- `buildResolver(entities)` → 归一化 `name|alias → id` 映射。
- `dominantLocation(bible, chapter)` → 本章主导地点 id（未解析地点的回退目标）。
- `assembleScene(...)` → 组装 + source/id 确定性掌权。
- `RawSceneSchema`（中间层 zod）。

## 5. 结构 vs 引用 二分（D6，本设计的中枢）

延续 PR2 把「结构有效」与「引用完整」分离的设计，PR5 把两类失败**分流**：

| 失败类型 | 例子 | 处理 | 去向 |
|---|---|---|---|
| **结构垃圾** | 坏枚举（`time_of_day:"中午"`）、缺 `heading`、多字段、非法 JSON | 中间层 zod / `extractJSON` **抛错** | 向上冒泡，PR6 orchestrator 重试 |
| **引用未命中** | speaker 不在 cast、location 不在地点表 | D3 最佳努力（降级/回退）+ 记 issue + `needs_review` | 返回 `{scene, issues}`，PR6 据 issues 决策重试/保留 |

理由：结构垃圾是「LLM 没按契约说话」，重试可能修好；引用未命中是「语义层面 LLM 提到了 Bible 没有的实体」，
强行重试未必收敛，最佳努力 + 标记 `needs_review` 更稳，符合 §4「超 N 次打 needs_review 保留并继续」。

## 6. 错误处理 / 边界 case

| 情况 | 处理 |
|---|---|
| LLM 返回非法 JSON | `extractJSON` 抛错，带 `scene_<章>_<序>` 上下文冒泡（PR6 接管） |
| LLM 输出坏枚举 / 缺字段 / 多字段 | `RawSceneSchema` 抛错（D6 结构垃圾） |
| speaker 解析不到 | 降级 `action`，保留台词文本，记 `unresolved_character` issue，`needs_review` |
| location 解析不到 | 回退本章主导地点，记 `unresolved_location` issue，`needs_review` |
| 本章 provenance 圈不到任何地点 | cast 退回全 bible；主导地点回退也用全 bible |
| 整本 bible 无任何地点（理论极端） | 抛错（无法满足 `heading.location_id` 必填——这是上游 Curator 的责任，不该静默造假 id） |
| 候选文本极短 / 纯叙述无对白 | 正常——`elements` 可全是 `action`，schema 允许；`synopsis` 仍由 LLM 给 |
| LLM 把别名当 speaker（「宝二爷」） | resolver 用 `aliases` 命中 → 正常解析为 `char_baoyu`（非未命中） |
| 同名跨人物/地点（罕见） | resolver 同表内「先到先得」+ 记录；跨表不混（人物表/地点表各一份 resolver） |

## 7. 测试计划（TDD 先红，fixture，不烧 key）

**纯函数（确定性，先红后绿，零网络）**：
- `scopeCast`：provenance 圈本章实体；本章无实体 → 退回全 bible。
- `buildResolver` + 解析：规范名命中；**别名命中**（「宝二爷」→ `char_baoyu`，核心 demo 弹药）；
  归一化（大小写/首尾空白）命中。
- `dominantLocation`：多地点取出场章数最多者；并列取码点序最小；本章无地点 → 全 bible 兜底。
- `assembleScene`：`scene.id` = `scene_<章>_<序>`；`source` 确定性（chapter + excerpt 头部截断）；
  `needs_review` 仅在有 issue 时为 true。

**编排（内容键控 stub `LLMClient`，复用 PR4 I7 教训——按 user 消息内容路由，避开 system 示例污染）**：
- 干净解析：raw scene 全部名字命中 → `Scene` 引用干净、`issues` 空、`needs_review` 不置。
- 别名解析：speaker 用别名 → 正确解析为 canonical id、`issues` 空。
- 未解析说话人：speaker 不在 cast → 该 dialogue 降级 `action`（台词文本保留）+ `unresolved_character` issue + `needs_review`。
- 未解析地点：location 不在地点表 → 回退本章主导地点 + `unresolved_location` issue + `needs_review`。
- 结构垃圾：stub 返回坏枚举 / 缺字段 → `convertScene` **抛错**（D6）。
- 引用自检：组装出的 `Scene` 对 bible 跑 `checkReferentialIntegrity` 恒为空（防御断言）。

**门控真冒烟（`LLM_SMOKE=1`，复用 PR4 双条件门控，默认/CI skip）**：
- 拿 §8 新样本（回3 黛玉进贾府的一个真实场景）+ 真 Curator 产出的 bible，跑真 DeepSeek `convertScene`，
  断言：`SceneSchema.parse` 通过 + `checkReferentialIntegrity` 为空 + 至少有 1 条 dialogue 元素（证明真在转对白）。

fixture bible 用《红楼梦》样本真实实体构造（贾雨村/林黛玉/荣国府等），确保测到真实别名密度。

## 8. 样本计划（§6 待议①②，PR5 起步预备 commit）

**决策（S）**：demo / 冷烟样本换为《红楼梦》**回3（黛玉进贾府）+ 回6（劉姥姥一進榮國府）+ 回7（送宮花）**，**简体**。

**为何换**（现 `samples/honglou-meng-ch1-3.txt` 的问题，真实读样本逼出）：
- 回1-2 偏叙述/说明文，登场是「石頭/頑石/美玉」等抽象实体，对白稀。
- 回3 恰好**截断在黛玉跨进垂花门那一刻**——賈母相見、王熙鳳出场、寶玉摔玉等**最具戏剧性、对白最密、别名最丰**的群戏全没包进来。
- 对本工具招牌能力（跨章人物一致性 + 带对白的场景转换 + 引用完整性），现样本偏弱。

**执行步骤**（作为 PR5 **起步预备 commit**，先于 converter TDD）：
1. 取 Gutenberg 红楼梦繁體逐字 `.txt`（**`curl` 取逐字原文，不用 WebFetch**——PR3 教训：WebFetch 会摘要，拿不到 verbatim）。
2. OpenCC 繁→简（`opencc` / `opencc-js`，或一次性脚本）。
3. 裁剪每回到**对白最密的核心段**控成本（与现样本同量级，每回 ~50–80 行）。
4. 归一化回目格式（一致的 `第N回 标题`，与 chunker `CHAPTER_HEADING` 对齐）。
5. 落盘新样本（如 `samples/honglou-meng-daiyu.txt`；旧样本去留 implementation 时定）。
6. **同步测试**：现有引用旧样本的 chunker/curator 测试改指新样本；DEVLOG 提到的「繁體 cue 命中」冒烟断言
   保留**一个小繁體 fixture** 续测健壮性（chunker 简繁 cue 都内置，简体样本不破 chunker）。

**不影响 converter 代码**：chunker 内容无关、resolver 吃任意 bible 名字——样本换语言/换回只动样本与 fixture。

## 9. 质量门禁（`PROJECT.md §8.1`）

- 每 PR 必跑：`npm test`（vitest 全绿）+ `npx tsc --noEmit`，贴原始输出。
- TDD：新测试先红再绿。
- 合并前追加 `docs/DEVLOG.md` PR5 一节。
- **PR5 不是大审查批次**——下次大审查在 PR6（§8.1 节奏锚点表）。PR5 只走每-PR 轻量门禁。
- 用户点头才 merge。

## 10. 非目标（YAGNI）

- 不做 Validator / Critic / Orchestrator / SSE 重试编排（PR6）。
- 不做多场景批量/并行编排（本模块单场景；批量是 orchestrator 的事）。
- 不新增 schema 字段——`Scene` 已足够；`needs_review` 复用 PR2 已有可选字段。
- 不做场景候选的语义再切分/合并（Chunker 出候选、PR5 忠实转换；再切分超出边界）。
- 不引入拼音库——人物/地点 id 已由 PR4 Curator 分配，PR5 只解析不生成 id。
- 不持久化、不跨多次转换的 id 稳定（单次转换内确定即可）。
