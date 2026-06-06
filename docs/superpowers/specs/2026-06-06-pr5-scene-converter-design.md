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

---

## 11. 评审结论与设计增量（gstack /plan-eng-review + codex outside-voice，2026-06-06）

> 本节是对 §1–§10（v1 设计）的**权威增量**。实现以本节为准；冲突处本节覆盖 v1。
> 来源：plan-eng-review 四段评审（3 架构决策）+ codex 跨模型冷读（27 发现，4 条升为跨模型张力交用户裁决、11 条 fold-in）。

### 已敲定决策（覆盖 v1，brainstorming 的 D1–D6 在此细化）

- **E1（地点回退诚实化 / 取代 §3.4 + §6 的 dominantLocation，codex #7/#8）**：原「回退本章出场最多地点」会**系统性偏向伞状地点**（红楼里恒选「荣国府」），且填入真 id 后 `checkReferentialIntegrity` 通过 → **产出「结构有效的语义谎言」**，比未解析说话人更危险。改为：`dominantLocation` = **本章 scoped 地点中 id 码点序最小者**（中性、确定、不偏伞状；本章无地点→全 bible 同法）；`unresolved_location` issue 的 `resolution` **明标 `placeholder fallback, heading unverified`** + `needs_review`。不抛错（保「最佳努力」边界）。
- **E2（歧义三级确定性梯 / 细化 §2 D1 + §6，codex #2/#4/#20）**：`validateStoryBible` **只查实体内别名重复、不查跨实体同名别名**（实证 storyBible.ts:224–282）→ 别名歧义是**预期输出模式而非「罕见」**（§6「罕见」措辞作废）。歧义选胜出者按梯：**① 规范 name 精确命中 > 仅 alias 命中；② 本章 scoped cast 内候选 > 仅跨章候选；③ 仍平手 → id 码点序最小**。全程确定性；命中 2+ 时记 `ambiguous_reference` issue（带 `candidates: string[]`）+ `needs_review`，但默认猜值大概率正确。
- **E3（D6 加 coerce 预处理 / 细化 §3.3 + §5 + §6，codex #10/#11/#25）**：D6「多字段一律抛错」过刚——可平凡修复的形状噪音（dialogue 多带 `text`、action 误带 `speaker`）丢弃多余字段即可，硬抛白费一次 PR6 重试。**复用 PR4 `coerceMapEntities` 范式**：`RawSceneSchema` strict 校验**前**加一道 `coerceRawScene`——剔去可安全丢弃的多余字段、计数告警；只对**真歧义垃圾**（坏枚举、缺必填 `line`/`speaker`、缺 `heading`、非法 JSON）抛错。`elements` 空数组 → **置 `needs_review`（可疑但不抛错）**，不沿用「结构垃圾」语义。
- **E4（语料重拉拆出 PR5 / 取代 §8，codex #18/#19 + eng-review Step 0）**：**双模型一致**——§8 让 PR5 以「重拉语料 + OpenCC + 改旧测试」开场是 scope 陷阱，OpenCC 依赖是 agent PR 里不必要的风险。**「简体 + 回3/6/7」的内容决定（S）不变，但执行时机挪出 PR5**：PR5 只出 converter，用**本地手构 fixture** 跑单测 + **复用现有繁體前三回样本**跑门控冷烟（仍真数据、零语料搅动、零 OpenCC 依赖）。简体回3/6/7 语料迁移 = **独立预备 commit/PR，置于 demo 阶段（PR7/8）之前**。§8 降级为「未来语料迁移备忘」，不在 PR5 范围。

### 细化既定（brainstorming 已答，评审补精度）

- **E5（降级台词引号包裹 / 细化 §3.4 D2 步骤）**：未解析说话人降级为 `action` 时 `text = 「` + 原 `line` + `」`（中文引号标记「这是说的话」，**不加未核实的说话人名前缀**）。保可读性、不注入未核实信息（接受 codex #12「speaker surface 仅存于 issues、YAML 导出会丢」的取舍——`needs_review` 已标记该场景）。
- **E6（SCENE_BODY_CAP 护栏 + 截断诚实化 / 补 §3.2/§4/§7，codex #15/#16）**：发给 LLM 的场景正文加上限 `SCENE_BODY_CAP`（与 PR4 `MAP_BODY_CAP` 同范式、按场景粒度可略小），超限截断 + 追加截断标记。**截断破坏「一候选一场景」忠实性**（LLM 只见前缀而 `source.excerpt` 仍指整候选）→ 截断时**置 `needs_review` + 记一条 `truncated_scene` 提示**，不静默。

### 并入实现的增量改进（codex fold-in，无需再抉择）

- **I1（`ConversionIssue` 接口补全，#1）**：`kind` 增 `ambiguous_reference`；增可选 `candidates?: string[]`（歧义命中的 id 列表）。issue 内的 id 是**机器面向**（喂 PR6/审计），与「prompt 不给 LLM 看 id」不矛盾（#6 澄清）。
- **I2（`buildResolver` 返回结构升级，#3）**：不再是简单 `surface→id`，而是 `归一化surface → { ids: string[], matchedBy: "name"|"alias", scoped: boolean }[]`，承载 E2 三级梯所需匹配元数据。
- **I3（归一化边界写死，#5）**：resolver 归一化 = `trim` + 全角↔半角标点/空格统一 + 去中文引号 + **剥离末尾说话动词**（`道/说/說/問/笑道/答道` 等）+ 简繁不在此层强转（样本已简体）。**剥离/归一后仍不命中 → 算未解析**（落 `unresolved_character`，安全网兜底）。不做激进语义归并（`凤姐儿`↔`凤姐` 这类靠 PR4 aliases 承载，不在 resolver 臆测）。
- **I4（scene 级引用自检 helper，#9）**：`checkReferentialIntegrity` 只吃 `Screenplay`；PR5 加内部 helper（构造含占位 `title`/`logline` 的临时 `Screenplay` 或直接对单 `Scene`+`bible` 校验），防御性断言组装结果引用干净。
- **I5（`needs_review` 注释更新，#14）**：`screenplay.ts` 的 `needs_review` 注释补「或由 Scene Converter 在未解析/歧义/截断时置位」，消除与「仅 Critic/Orchestrator 设置」的契约矛盾。
- **I6（全库解析 = 有效引用，#21）**：明确 scoping 是**聚焦提示非硬约束**；LLM 引用了 scoped cast 外但全 bible 内的合法别名 → 代码解析命中即**有效**，非违规、非 issue。
- **I7（冷烟断言收紧，#22）**：门控真冒烟从「≥1 dialogue」改为**断言命中已知 speaker id + 已知 location id**（拿稳定小片段，避免「模型臆造一句对白」蒙混）。
- **I8（错误语义细分，#27）**：区分「JSON 解析失败」（`extractJSON` 抛）与「JSON 形状错」（`RawSceneSchema` 抛）两类错误上下文，附 `scene_<章>_<序>`，供 PR6 拼更准的重试提示。
- **I9（措辞软化，#26）**：spec 内凡 LLM 输出相关的「可复现」改「降方差」；确定性代码路径（id 解析、组装、scene id）仍称「可复现」。
- **I10（scene id 来源澄清，#23/#24）**：`scene_<章>_<候选序>` 的唯一性是**单次转换内**保证；跨章/跨小说去重是 orchestrator（PR6）职责，本模块不担保——写进注释，不假装全局可复现。
- **I11（empty-elements 决策落地，#10/#25）**：见 E3——空 `elements` 置 `needs_review`；`RawSceneSchema.elements` 不加 `.min(1)`（与最终 schema 一致），由 coerce 后业务逻辑判空。

### 测试 GAP（并入 §7，每条须有测）

E1 地点 placeholder 回退（断言选最小 id scoped 地点 + `resolution` 标 placeholder + `needs_review`）/ E2 歧义三级梯（规范名胜别名、scoped 胜跨章、平手取码点序、记 `ambiguous_reference`+`candidates`）/ E3 coerce 剔多余字段后 strict 通过 + 真垃圾仍抛 + 空 elements→`needs_review` / E5 降级 `action.text` 带「」断言 / E6 `SCENE_BODY_CAP` 截断 + `truncated_scene`+`needs_review` / I3 归一化命中（全角半角、末尾「道」剥离）/ I6 跨章地点经全库兜底解析为有效引用（prompt 只圈本章、LLM 引他章地点→命中、无 issue）/ I7 冷烟断言已知 id。

### NOT in scope（本次评审显式 defer）

- 简体回3/6/7 语料重拉 + OpenCC 迁移（E4）——独立预备步骤，demo 阶段前做。
- `buildResolver` 跨场景 hoist 复用（PR6 编排循环时 O(场景×实体)，单场景 API 无感）——PR6 优化。
- 激进中文别名语义归并（`凤姐儿`↔`凤姐`、`宝玉道`→`宝玉` 之外的）——靠 PR4 aliases 承载，不在 resolver 臆测。
- 跨章/跨小说 scene id 全局去重（I10）——orchestrator/PR6。
- Validator/Critic/Orchestrator/SSE（PR6）；多场景批量（PR6）。

### What already exists（复用，未重建）

`lib/llm/client.ts`（chatJSON/extractJSON/retry，注入 fetch）、`lib/schema/screenplay.ts`（`Scene`/`Element`/`SceneHeading` 输出契约 + `checkReferentialIntegrity` 校验范式 + `IntExt`/`TimeOfDay` 枚举复用）、`lib/agent/storyBible.ts`（`StoryBible`+`provenance` 输入 + **`coerceMapEntities` 是 E3 coerce 的范式蓝本**）、`lib/agent/chunker.ts`（`SceneCandidate` 输入）、`lib/schema/fixtures.ts`（fixture 范式）、现有繁體前三回样本（E4 冷烟复用）。

### Failure modes（新代码路径 × 是否有测/有错误处理/是否静默）

| 失败 | 有测 | 有错误处理 | 用户可见 |
|---|---|---|---|
| 说话人未解析 | 是(§7) | 降级 action+「」+issue | 是(needs_review) |
| 地点未解析 | 是(E1) | placeholder 回退+醒目 issue | 是(needs_review，已修「静默谎言」) |
| 别名歧义 | 是(E2) | 三级梯猜值+ambiguous issue | 是(needs_review) |
| LLM 形状噪音(多字段) | 是(E3) | coerce 剔除 | dev 计数告警 |
| LLM 真垃圾(坏枚举/缺必填) | 是(§7) | 抛错带 scene 上下文 | 是(冒泡 PR6) |
| 场景超 SCENE_BODY_CAP | 是(E6) | 截断+truncated_scene | 是(needs_review) |
| 空 elements | 是(I11) | needs_review | 是 |

无「无测 且 无错误处理 且 静默」的关键 gap——E1 已把唯一的静默谎言堵掉。

### 并行化策略

单模块（`lib/agent/sceneConverter.ts` + 一处 `screenplay.ts` 注释编辑 I5）——**顺序实现，无并行机会**。

### 实现任务（TDD 顺序）

1. **T1（P1）** `ConversionIssue` 接口（I1）+ `RawSceneSchema` + `coerceRawScene`（E3）+ `screenplay.ts` needs_review 注释（I5）；coerce/strict 先红后绿。
2. **T2（P1）** resolver：`buildResolver`（I2）+ 归一化（I3）+ E2 三级梯解析 + 别名/歧义/未解析分支（先红）。
3. **T3（P1）** `scopeCast`（provenance 圈定 + 全库兜底）+ `dominantLocation`（E1 最小 id scoped）。
4. **T4（P1）** `assembleScene`：scene id（I10）+ source/excerpt + `SCENE_BODY_CAP`/截断（E6）+ needs_review 汇总 + I4 引用自检。
5. **T5（P1）** `convertScene` 编排：内容键控 stub（PR4 I7）覆盖 §7 全分支 + 评审 GAP。
6. **T6（P2）** 门控真冒烟（I7，复用繁體样本，`LLM_SMOKE=1` 默认 skip）。
7. 跑 `npm test` + `npx tsc --noEmit` 贴原始输出；更新 DEVLOG/PROJECT；**PR5 不跑大审查**（下次 PR6，锚 `f41c257`）。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (optional) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open→resolved | 3 架构 issue（地点回退/降级呈现/场景 cap）+ 3 fold-in，全决议 |
| Outside Voice | codex `exec` | Independent 2nd opinion | 1 | issues_found | 27 发现：4 升跨模型张力(E1–E4)交用户裁决、11 fold-in(I1–I11)采纳、余为细化 |
| Design Review | `/plan-design-review` | UI/UX | 0 | — | n/a（后端模块） |
| DX Review | `/plan-devex-review` | Dev experience | 0 | — | n/a |

- **CROSS-MODEL:** codex 独立 surfaced 4 条 eng-review 未尽的张力——E1「地点回退是结构有效的谎言」(最高价值，仿 PR4 codex 逮 location-aliases)、E2「歧义梯比码点序更准 + 别名歧义是预期非罕见」、E3「D6 过刚、应仿 PR4 coerce」、E4「语料重拉是 scope 陷阱」(与 eng-review Step 0 同向，双模型一致)。全部经 AskUserQuestion 交用户裁决采纳。
- **UNRESOLVED:** 0 —— 7 个 AskUserQuestion 决策（D1–D7 of this review）全部作答；11 fold-in 接受。
- **VERDICT:** ENG CLEARED —— 架构锁定、测试计划完整、failure modes 无静默 gap，ready to implement（TDD）。PR5 非大审查批次（下次 /code-review+/security-review 在 PR6，锚 `f41c257`）。
