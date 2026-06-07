# 开发纪实（DEVLOG.md）

> **用途**：记录真实的开发场景——遇到的 bug、踩的坑、发现的痛点、每个 PR 的架构亮点与设计权衡。
> 服务于 demo 表达（评审权重 20%）：让我们对「为什么这么做、过程中真实发生了什么」**有话可说、言之有据**。
> **维护约定**：每个 PR 合并前追加一节（见 `PROJECT.md §8.1`）。只记真事，不编戏剧性。

---

## 贯穿全程的方法论亮点（最值得在 demo 里讲）

### 把「信任」工程化进 AI 辅助开发流程
作品本身是 agent 工具，开发方式也用 AI 协作——于是冒出一个真实顾虑：**单会话执行流如何对抗 LLM 致幻与记忆漂移？** 我们没有用「相信我」搪塞，而是把它当架构问题解，落成 `PROJECT.md §8.1` 的**质量门禁**：

- **外部判官**：正确性脱离「我觉得对」，交给 `npm test` + `tsc --noEmit`，且必须贴原始输出——无证据的「通过」不算数。
- **冷上下文对抗复核**：派**不共享对话上下文**的子 agent 冷读 diff（`/code-review` + `/security-review`），专戳「我自己写的所以看不见」的盲点。
- **事实锚点**：`PROJECT.md` 是单一事实来源，接续靠重读而非记忆。
- **人为放行**：最终门禁是人。

> **可讲的一句话**：「我们把对 AI 的不信任，变成了流程里的外部判官 + 冷上下文复核 + 人工放行三道闸，而不是口头保证。」后来这套闸**真的逮到了一个我自己看不见的 bug**（见 PR2）。

### 不信训练记忆，信运行时事实
`AGENTS.md` 一句「This is NOT the Next.js you know」点醒：依赖（zod 4、Next 16）可能与训练数据有出入。于是凡涉及版本敏感 API，**先用一次性脚本探真实行为再写代码**，而非凭记忆。这条在 PR2 直接避免了对 zod v4 API 的臆测。

---

## PR1 · 测试基建 + OpenAI 兼容 LLM client + 配置 ✅

**亮点**
- LLM 接入做成 **provider 无关抽象**（`lib/llm/client.ts`）：baseUrl/key/model 全可配、运行时可切；用内置 `fetch` 零 SDK 依赖；`fetchImpl` 可注入便于测试。
- 稳健性内建：超时 + 指数退避重试（只对 408/429/5xx 等瞬时错误）、`extractJSON` 能从 markdown 围栏/散文里**鲁棒抽取 JSON**（对抗 LLM 不老实输出纯 JSON）。

**踩坑 / 环境痛点**
- **非 ASCII 用户名路径坑**：Windows 用户名是中文「羽扇豆」，`bun build --compile` 会因临时文件路径含非 ASCII 而 `ENOENT`。本项目用 npm + Next.js 绕开了该步，但已在全局 `CLAUDE.md` 留下「bun 走纯 ASCII 路径」的通用解法。
- `create-next-app` 拒绝非空目录：脚手架先生成到 `scaffold-tmp` 子目录再上移，保住原有 `CLAUDE.md`。

**可讲的一句话**：「第一行业务代码之前，先把 LLM 抽象成可替换、可注入、可测试的接口——demo 用 DeepSeek，但代码一行不绑定它。」

---

## PR2 · 剧本 YAML Schema + 序列化 + 设计文档 ✅

**亮点（架构设计能力的集中展示）**
- **Schema 即单一事实来源**：`lib/schema/screenplay.ts`（zod）一处定义，类型、序列化、文档、后续所有 agent 契约全部派生。
- 七项设计决策都能**说出原因**（见 `SCHEMA.md`），核心三条：
  - **id 引用而非内联** → 跨章一致性（同角色多称呼用 `aliases` 归并到一个稳定 id），可机器校验引用完整性，是 agent 跨章记忆的落点。
  - **`elements` 有序异构列表（判别联合）** → 忠实表达剧本的线性时间流，固定字段表达不了「动作—对白—动作」交错。
  - **`source` 溯源** → 对抗幻觉、建立作者信任，闭合「可信→可编辑→可打磨」。
- **结构校验与引用完整性刻意分离**：zod 管结构，`checkReferentialIntegrity` 单独管跨实体引用并返回**带定位**的问题列表（`elements[2].character_id`），正是为了喂给后续自纠闭环回灌重试——一个笼统的 ZodError 给不了这个粒度。

**真实的大 bug（冷上下文复核逮到的，自己没看见）**
- 我在 `yaml.ts` 写了 `blockQuote: "literal"`，注释自信地说「保持块状集合风格」。**两个独立冷审查 agent 各自收敛到同一结论**：`blockQuote` 控制的是**多行标量字符串**的引用风格，**根本不是** map/序列的 block-vs-flow（那是 `collectionStyle`）——注释名实不符，且带来我没意识到的副作用。
  - **根因**：把库的两个不相关选项的语义记混了，典型的「凭记忆写、看自己代码有滤镜」。
  - **修复**：删掉它（块状本就是默认），并顺势让 `toYAML` 先过 `parseScreenplay` 归一化，使 round-trip 成为**真恒等**、与 `fromYAML` 校验对称。
  - **价值证明**：这正是 §8.1 冷上下文闸的意义——**它逮到了一个外部判官（测试全绿）放过、而我本人看不见的缺陷**。测试绿 ≠ 设计对。

**安全：用实测代替假设**
- `fromYAML` 解析不可信 YAML 是唯一攻击面。没有想当然，而是**实测** `yaml` 库对两类经典威胁的默认行为：**原型污染**（`__proto__` 不污染 `Object.prototype`）与 **YAML 炸弹**（库内置 alias 计数上限，直接抛「resource exhaustion attack」）——均默认防御，`strictObject` 再补一道拦截未知键。
- 留了前瞻 note：`fromYAML` 接 API 路由时补输入体积上限（PR6 落地）。

**痛点 / 权衡**
- **TDD 与「整体性 schema」的张力**：`checkReferentialIntegrity` 为让 happy-path 测试通过必须整体实现，导致它的负路径测试写出来就立即绿、无法「先红」。诚实处理：明确标注这几条是「契约护栏」，而真正全新的 yaml 模块严格 red-first。
- **导出面之争**：冷审查建议「子 schema 导出过多、YAGNI」，**有据驳回**——`CharacterSchema`/`SceneSchema` 等正是路线图上 PR4-6 各 agent 的输入/输出契约，不是投机表面。（记录这个分歧本身也体现：复核建议要经技术判断，不盲从。）

**流程演进**
- 大审查（冷上下文 code+security review）**每 PR 一次太托节奏**，按需求改为**每 2 个 PR 一次**（PR2/4/6/8），轻量门禁（test+tsc+TDD+人工放行）仍每 PR 必跑。下一次大审查锚点 PR4。

**可讲的一句话**：「我们的冷上下文复核闸，逮到了一个测试全绿、我自己却看不见的真实 bug——这就是为什么‘绿’不等于‘对’，也是为什么这道闸值得存在。」

---

## PR3 · Chunker（确定性分章/分场景）+ 真实示例小说 ✅

**亮点**
- **Chunker 不调 LLM**：读懂中文**章回体排版结构**就能零成本切分——`第N章`/`第N回` 切章、`话说`/`却说`/`次日` 等转场提示词 + 显式分隔行 + ≥2 空行大间隔切场景候选。这条「确定性工具不该花 LLM 的钱去做语义」正是 §4 职责表给 Chunker 划的边界。
- **两遍切分**：① 线级硬边界（分隔行 / 大空行）② 段内转场提示词。提示词只在句末标点/换行/段首后触发，避开「再说一遍」式误切——但仍承认会有误切，所以输出叫 **sceneCandidates（候选）**，交给后续 LLM 精修，而非假装一步到位。
- **真实语料而非编造**：示例小说用**公有领域**《红楼梦》前三回真实文本（Project Gutenberg），零版权风险，且宝玉/黛玉/凤姐的多称呼天然为 PR4「跨章 alias 合并」备好演示弹药。

**真实开发场景 / 踩坑**
- **工具选型纠偏**：本想用 `WebFetch` 取原文，发现它用小模型「转述」网页、**拿不到逐字原文**；改用 `curl` 取 Gutenberg 逐字 `.txt`（2.66MB）。教训：要 verbatim 就别用会摘要的工具。
- **环境坑**：`python3` 在本机是 Windows Store 占位符（exit 49），且 git-bash 的 `/tmp` 对 Windows 版 node/python 不可见 → 改为「下载进项目目录 + 用 node 处理」，路径一致才稳。
- **真实语料逼出的边界 case（最有料）**：红楼梦正文里有一句以 `第四回中既將薛家母子…` **开头**的叙述——朴素的「行首第N回」判定会把它**误当成章节标题**，凭空多切一章。我们的**锚定正则**（marker 之后必须是「空白+标题」或行尾）因其后紧跟「中」无空白而正确拒绝，并钉进**回归测试**。**合成 fixture 永远想不到这个，是真实数据替我们做了测试设计。**
- **版本/排版不一致**：该版回1/回2 标题内联、回3/回4 是裸标题 + 横线装饰行 → 把样本**归一化**成一致回目格式再落盘。
- **dogfooding 当场抓到两个 gap（跑给人看时暴露）**：把 Chunker 跑在真实样本上预览，发现**每章只切出 1 个场景候选**。连查两层根因：① 我的转场提示词表是**简体**（`却说/话说`），样本是**繁體**（`卻說/話說`），字不同没命中 → 补全繁體变体；② 修完仍不切，因为真实排版在 `\n` 与 `卻說` 之间有**全角缩进空格**（`　　卻說`），而我的边界正则要求 cue 紧贴标点 → 放宽为「边界 + 可选空白（含全角）+ cue」。两条都补了回归测试。**两个 gap 都是合成 fixture 测不出、只有真实语料 + 真实预览才会暴露的。**

**痛点 / 权衡**
- 样本为**繁體**、且每回截到 ~45 行（控制体积与后续 LLM 成本）；若 PR5 LLM 阶段吃力，可低成本换白话/扩容——**Chunker 内容无关，换样本不动代码**。
- 确定性提示词切分必有误差，刻意定位为「候选」而非终稿，把语义精修留给 LLM 层——这是 agent 流水线「确定性工具 + LLM 精修」分工的体现。

**可讲的一句话**：「分章器一行 LLM 都不调——它吃透中文章回体的排版语义(第N回、话说/却说)就把章与场景候选切出来；而真实《红楼梦》语料当场逼出一个合成数据想不到的边界 case（正文里以‘第四回中…’开头的句子），被我们的锚定正则挡下、钉进回归测试。真实语料替我们做了测试设计。」

---

## PR4 · StoryBible Curator —— 设计与评审（实现前，2026-06-06）🔨

> 本节记录 PR4 **写第一行实现代码之前**的真实过程：设计、工具链踩坑、双层评审。代码待 TDD 落地（spec §10 T1–T4）。

**设计（先 brainstorming 后评审）**
- 选 **map-reduce + 确定性 id 后处理**：逐章 LLM 抽取（map）→ 单次 LLM 合并别名（reduce）→ 确定性代码分配稳定 id → zod 校验。
- 四个 brainstorming 决策：分章抽取+LLM二次合并 / 确定性代码分配 id / **LLM 给 romanization 提示、代码是 id 权威**（规避拼音库多音字坑）/ 输出只产 schema 已有字段。
- 设计落 `docs/superpowers/specs/2026-06-06-pr4-storybible-curator-design.md`。

**工具链真实踩坑：gstack 子技能「静默没注册」**
- AGENTS.md 约定「架构/规划优先 gstack」，但 gstack 的规划子技能（`/plan-eng-review` 等）**从不触发**，一路只走了 superpowers。
- 逐层挖根因：① Claude Code 技能发现只扫一层，gstack 几十个子技能嵌在 `gstack/` 目录内、只有伞状 `gstack` 被注册，伞状 description 是「headless browser QA」——对「架构/规划」**没有语义触发面**；② 真因是 `./setup`（`set -e`）**先 bun 构建**，撞中文用户名非 ASCII temp 坑 abort，**没走到把子技能摊平成顶层技能的注册步**就退出，且**无报错**——一次失败同时造成「子技能没注册 + Chromium 没下载」。
- 修复：带 `BUN_CMD`+ASCII `TMPDIR` 重跑 `./setup --host claude --prefix`，构建过关、注册步执行，**52 个 `gstack-*` 技能当场注册、技能表实时刷新**。办法已写进全局 `~/.claude/CLAUDE.md`。
- **教训**：`set -e` 脚本里「构建在前、注册在后」，构建静默失败会连带吞掉后续步骤；表象（技能不触发）离根因（bun 非 ASCII）很远，靠读 setup 源码逐行定位，而非猜。

**双层评审：本地 plan-eng-review + codex 跨模型冷读**
- gstack `/plan-eng-review` 四段评审，本地抓到 4 issue（id 兜底不可复现、reduce 是真正的扩展天花板、concurrency 参数过早抽象、prompt 效力无法用 fixture 验证）。
- 末尾 `codex exec`（read-only 沙箱）独立冷读，**逮到 3 个本地评审和设计都漏的盲点**：① `LocationSchema` 没有 `aliases`——地点别名合并后「荣府」无处存、PR5 解析不到（真·管线断裂）；② 缺 map/reduce 的**中间层 zod schema**（`chatJSON` 只解析不校验）；③ 章节溯源不该全扔——PR5 要靠它按章圈定候选实体，否则得把整本 bible 塞进每个场景 prompt。
- 结论：6 决策（R1–R6）+ 8 增量（I1–I8）落进 spec §10，作为实现权威依据。

**可讲的一句话**：「我把对单会话的不信任做成了两道**真·外部判官**：gstack 的结构化工程评审 + codex 的跨模型冷读。后者当场逮到三个我和设计都没看见的盲点——其中一个（地点没有别名字段）是会在 PR5 才爆的管线断裂。这再次坐实：绿 ≠ 对，自己看自己的设计有滤镜。」

### PR4 实现纪实（TDD T1–T4，2026-06-06）

**架构落地（map-reduce + 确定性 id 后处理）**
- `lib/agent/storyBible.ts`：map（逐章 LLM，`Promise.all` 并行）→ reduce（单次 LLM 合并别名）→ `assignIds`（确定性 slug + 去重 + 稳定排序兜底）→ schema-clean 实体 + `provenance` 侧表 → `validateStoryBible` 防御兜底。
- **id 三权分立**落到代码：LLM 只给 `romanization` 提示，代码 `sanitizeSlug` 是唯一 id 权威。真 DeepSeek 跑出来的 id 干净可读（`char_lin_dai_yu`/`loc_rong_guo_fu`），印证了「LLM 提示 + 代码权威」这条决策。
- **纯函数全部独立可测**：`assignIds`/`coerceMapEntities`/`computeProvenance`/`sanitizeSlug` 不碰 LLM，先把确定性逻辑 red-green 钉死，再用内容键控 stub 测编排——网络与逻辑彻底分离。

**真实大 bug / 踩坑（最有料的两条）**
- **真 LLM 逼出的管线裂缝（正是门控冒烟的意义）**：fixture 全绿、tsc 干净后，跑 `LLM_SMOKE=1` 真打 DeepSeek，**当场炸出**——map 阶段真模型会给【地点】也输出 `aliases`，而我按 v1 设计把 `MapLocationSchema` 建成「地点无别名」的 `strictObject`，严格拒绝直接抛错。这是 fixture 永远想不到、只有真模型才暴露的：`aliases` 是 R5 之后的**合法字段**而非脏数据，于是给 map 地点补上 `aliases`（与人物对称）、provenance 同步纳入。**绿 ≠ 对，又一次由真数据证明。**
- **并发测试 stub 的内容键控陷阱（I7 的真实代价）**：map 改 `Promise.all` 后，stub 必须按内容而非调用顺序路由（I7）。初版按「全部消息内容」匹配章节 token，结果 `MAP_SYSTEM` 里写的示例「（如「宝玉/宝二爷」）」命中了**每一个** map 调用——第 3 章被误路由到第 2 章的 fixture，provenance 串味成 `[1,2,3]`。靠 debug 打印定位后，改成**只匹配 user 消息（章节正文）**修复。教训：内容键控的「内容」要精确到消息角色，prompt 里的示例文本是隐形污染源。

**一个被真数据纠正的叙事**
- PR3 DEVLOG 曾设想「宝玉/黛玉/凤姐多称呼是 PR4 alias 合并的演示弹药」。真跑发现：**截断版前三回里寶玉本人尚未登场**（模型抽到的是石頭/頑石/美玉——通灵宝玉的前身），demo 弹药其实是 **賈雨村（雨村/賈化/太爺/本府知府 四别名合并）、林黛玉、榮國府/榮府（地点别名，R5 实证）**。冒烟测试目标据此纠偏。提醒：叙事要跟着真数据走，别照搬旧假设。

**一个工程判断（门控机制 vs 锁定 spec）**
- spec R4 写「冒烟仅凭检测到 `DEEPSEEK_API_KEY` 就跑」，目标却是「合 §8.1：npm test 默认不烧 key」。但本机 env **常驻** `DEEPSEEK_API_KEY`，纯按 key 门控会让每次 `npm test` 都真打 DeepSeek——与 §8.1 自相矛盾（R4 作者没料到 key 常驻）。把分歧摆给用户，决定改为 **`LLM_SMOKE=1` 显式 opt-in + key 双条件**：默认（含本机）一律 skip，CI 无 key 也 skip，合 §8.1 硬约束、仅轻微偏离 R4 字面而忠于其本意。**锁定的 spec 也可能内部不一致，照搬字面不如忠于意图——但偏离要交用户拍板。**

**门禁证据**
- TDD：T1–T4 每个新函数/分支先红后绿（schema 拒识、配置回退、id 兜底、合并、provenance、错误冒泡均先看失败）。
- `npm test`：**74 passed | 1 skipped**（含审查补的章回正则测试；冒烟默认 skip）；`npx tsc --noEmit` 干净；`LLM_SMOKE=1` 真冒烟 **1 passed（15.9s，真打 DeepSeek）**。
- 大审查（`/code-review`+`/security-review`，diff 锚 `dd47ed3` 覆盖 PR3+PR4）在 `pr create` 前跑——见下节。

**可讲的一句话**：「fixture 全绿、类型干净之后，我特意花一次真 DeepSeek 调用跑门控冒烟——它当场炸出一个 fixture 永远测不到的管线裂缝（真模型给地点也输出别名，被我的严格 schema 拒掉）。这就是为什么我坚持留一道**真模型**的闸：合成数据能证明逻辑对，但只有真数据能证明**契约对**。」

### PR4 大审查（`/code-review` + `/security-review`，冷读 `dd47ed3..HEAD`）

§8.1 规定每 2 PR 一次冷上下文大审查，PR4 是审查批次、基线锚 `dd47ed3`（覆盖 PR3 分章器 + PR4 curator）。用两个**新生 agent 冷读**（不是我凭记忆审自己刚写的代码——那有滤镜），加 `/security-review` 子任务流。

- **安全面：零发现。** 纯数据变换库，无 SQL/命令/反序列化/路径/鉴权 sink；唯一可疑向量（`provenance` 用实体 id 当对象键）被 `char_`/`loc_` 前缀 + `sanitizeSlug` 白名单（`[a-z0-9_]`）堵死，`__proto__`/`constructor` 不可达，无原型污染。
- **正确性：1 个中危 + 若干低危。** 中危是 PR3 遗留、本批次首次审到——`CHAPTER_HEADING` 正则**强制**标题前有空白分隔符，导致 `第一回甄士隱…`（标题紧贴、无空格）**整行不匹配** → 该回未被识别、并入上一回。样本用全角空格才侥幸通过。但该「护栏」**正是 PR3 用来挡正文假标题 `第四回中…，此回暂不写。` 的机制**（见上方回归测试），不能直接拆。
- **修法（用户拍板：先标点护栏，后续如再现误判再上序号单调）**：正则把分隔符改为可选，但把标题字符集限制为**不含句子标点**（`。！？，、；：…` + ASCII）——真章回标题从不含句读，散文续句必含。一条规则同时满足两个约束：`第一回甄士隱…　賈雨村…`（仅全角空格）通过，`第四回中…，此回暂不写。`（含 `，。`）被拒。TDD 先红（无分隔符标题只切出 1 章）后绿，原 `第四回中…` 回归测试保持绿。
- **低危（记录不改，理由附 PROJECT 待办）**：`assignIds` 纯数字 romanization 与位置兜底撞 id（唯一性仍保持，LLM 给拼音几乎不可能）；`computeProvenance` O(N×C) 全本扩展性（3 章无感）；char/loc 四 schema + 双胞胎管线重复（spec 已接受对称重复）；`provenance` 跨表 spread 被前缀设为不可达。

**可讲的一句话**：「大审查最有价值的一刀不在我刚写的 PR4，而在搭着一起审的 PR3：冷读 agent 指出分章正则强制空格分隔符，会漏掉‘标题紧贴’的章回标题。但那道空格要求又正是挡正文假标题的护栏——直接拆会破回归。真正的修法是换个判据（标题不含句读 vs 散文必含句读），一条规则同时满足‘收得进真标题、挡得住假标题’。审查的价值是逼你把‘侥幸通过’变成‘想清楚为什么通过’。」

---

## PR5 · Scene Converter（单场景→剧本元素流，强制引用 Bible id）✅

> 设计与评审过程见上方 spec（`docs/superpowers/specs/2026-06-06-pr5-scene-converter-design.md`，§11 是 gstack 工程评审 + codex 冷读的权威增量 E1–E6/I1–I11）。本节记录 **TDD 实现纪实**（T1–T6 先红后绿）。

**架构落地（scope → LLM 转换 → 解析 → 组装 → 校验）**
- `lib/agent/sceneConverter.ts`：单候选 → 单 `Scene`。LLM **只说名字**，确定性代码独揽 id 解析、`source` 溯源、`scene.id`（D1/D2「LLM 提示、代码权威」一路贯彻到第二个 agent）。
- **结构 vs 引用 二分**（D6）落到两条互不污染的失败路径：结构垃圾（坏枚举/缺必填/非法 JSON）**抛错带 `scene_<章>_<序>` 上下文**冒泡给 PR6 重试；引用未命中（说话人/地点不在 bible）走**最佳努力 + 带定位 `ConversionIssue` + `needs_review`**，场景永远 schema 有效且对 bible 引用干净。
- **纯函数全部独立可测、零网络**：`normalizeSurface`/`buildResolver`/`resolveSurface`/`scopeCast`/`dominantLocation`/`assembleScene`/`coerceRawScene` 先 red-green 钉死确定性逻辑，再用**内容键控 stub**（复用 PR4 I7：system prompt 不放人物示例，只按 user 消息路由）测 `convertScene` 编排。48 个 fixture 测试覆盖 §7 全分支 + 评审 GAP（E1–E6/I3/I6）。

**评审增量如何变成代码（最能讲的设计点）**
- **E1 地点回退「诚实化」**：codex 冷读逮到 v1 的「回退本章出场最多地点」会**系统性偏向伞状地点**（红楼里恒选「荣国府」），填入真 id 后还能骗过 `checkReferentialIntegrity` → **产出「结构有效的语义谎言」**，比未解析说话人更危险。改为 `dominantLocation` = **本章 scoped 地点中 id 码点序最小者**（中性、确定、不偏伞状），且 issue 明标 `placeholder fallback, heading unverified` + `needs_review`。专门写了一条测试断言它选**小 id 的次要地点而非高频的伞状地点**——把「不偏伞状」钉成回归。
- **E2 歧义三级确定性梯**：`validateStoryBible` 只查实体内别名重复、**不查跨实体同名别名** → 别名歧义是**预期输出而非罕见**。解析按梯：① 规范 name 命中 > 仅 alias 命中；② 本章 scoped 候选 > 仅跨章；③ 平手取 id 码点序最小。全程确定性，命中 2+ 记 `ambiguous_reference` issue（带 `candidates` id 列表）+ `needs_review`，但默认猜值大概率对。
- **E3 coerce 预处理**：D6「多字段一律抛错」过刚——可平凡修复的形状噪音（dialogue 多带 `text`、action 误带 `speaker`）丢弃即可。仿 PR4 `coerceMapEntities`，strict 校验前按元素 `type` 白名单剔多余字段、计数告警；只对真垃圾抛错。
- **E5 降级台词引号包裹**：未解析说话人降级为 `action` 时 `text = 「` + 原台词 + `」`——保「这是说的话」的可读性，**不把未核实的说话人名注入旁白**。
- **I6 跨章解析 = 有效引用**：prompt 只圈本章 cast（聚焦 + 省 token），但 resolver 跑**全 bible**——LLM 引了本章 cast 外、全 bible 内的合法地点（如 6 回里提 3 回的「碧纱橱」）**解析命中即有效、非 issue**。一条测试专测这条「聚焦是提示非硬约束」。

**真模型逼出的「叙事纠偏」（门控冒烟的意义，又一次）**
- fixture 全绿、tsc 干净后跑 `LLM_SMOKE=1` 真打 DeepSeek（≈5 次调用：curator map/reduce + 1 次 convert）。冒烟**当场纠正了我对样本的一个假设**：我按「黛玉进荣国府=群戏对白」写了「命中已知 speaker id」的断言，结果真模型把那段**忠实转成了 7 条全 `action` 的纯叙述**——因为截断版前三回里，黛玉是**正穿过神京街市走向府门**，台词密的相见戏（賈母/熙鳳/摔玉）根本不在样本里。模型还把 `heading.location` 选成了**包裹动作的「神京」**（都中），而非更细的「榮國府」——这是**完全正确**的转换（`issues=[]`、引用全干净），是我的断言太窄。
- 据此把 I7 冒烟锚点改成**真正稳定且有意义**的：断言 heading 地点**干净解析到一个已知 curated id（无 `unresolved_location`、非 placeholder 兜底）** + 场景文本忠实包含原文实体（`黛玉`/`榮國府`，防「合法但臆造」）。**这恰好实证了 spec §8/E4 的判断**：现有截断繁體样本对白稀、是工具招牌能力（带对白的场景转换）的弱样本——所以 E4 才把「简体回3/6/7 语料重拉」拆成 demo 前的独立预备步骤，PR5 只复用它跑契约冒烟。**真数据替我证明了 defer 这个 scope 的决定是对的。**

**门禁证据**
- TDD：T1–T6 每个新函数/分支先红后绿（schema 拒识、coerce 剔字段、resolver 三级梯、地点诚实回退、降级引号、编排全分支、错误冒泡均先看失败）。
- `npm test`：**122 passed | 2 skipped**（PR4 + PR5 两个门控真冒烟默认 skip）；`npx tsc --noEmit` 干净（exit 0）；`npm run lint` 干净；`LLM_SMOKE=1` 真冒烟 **1 passed（≈20s，真打 DeepSeek）**。
- **PR5 不单独跑大审查**（§8.1 节奏：合入 PR6 批次一起审，基线锚 PR4 合并点 `f41c257`，覆盖 PR5+PR6）。
- **合并落点**：用户放行后走 §8 流程，PR **#7** `--merge` 入 main，merge commit **`42454b7`**，分支已删（本地+远程）。合并前重跑门禁复核绿（`tsc` exit 0、`npm test` 122 passed | 2 skipped）。

**可讲的一句话**：「最危险的 bug 是‘结构有效的语义谎言’——codex 冷读逮到我原本的地点回退会永远填‘荣国府’，还能骗过引用完整性校验，比一个明显的未解析更难发现。修法不是抛错（那会破坏‘最佳努力’边界），而是回退到**中性的最小 id 地点 + 醒目标 `heading unverified` + needs_review**：让谎言**显形**而不是消失。然后真模型冒烟又反过来教育了我——它把‘黛玉进府’忠实转成纯叙述、把地点选成‘神京’，证明我连样本里有没有对白都记错了，也实证了我们提前把语料迁移 defer 出 PR5 是对的。」

## PR6 · Validator + Critic + Orchestrator + SSE —— 收尾闭环（2026-06-06）✅

> 设计见 spec `docs/superpowers/specs/2026-06-06-pr6-validator-critic-orchestrator-design.md`（§11 是 codex 跨模型冷读的权威增量 E1–E14）。本节记录 TDD 实现纪实。设计阶段走 gstack-spec 五段 + codex 冷读；用户选「直接进 TDD」（跳过 plan-eng-review）。

**这是什么**：把前 5 个 PR 的零件串成端到端管线。新增四组件（+ 一个共享事件契约 + SSE 编码器）：
- `lib/agent/events.ts`：`Stage` + `PipelineEvent` 联合（含末帧 `final_result`、`error`）。**单独成文件**而非塞进 orchestrator（spec §9 原写在 orchestrator）——这样纯函数 `eventToSSE` 不必 import orchestrator（会拖进全部 agent），避免循环、编码器可独立测。
- `lib/agent/sse.ts`：`eventToSSE` 纯函数，typed event 通道 `event: <type>\ndata: <json>\n\n`（E9）。
- `lib/agent/validator.ts`：`validateScreenplay`（整部门禁：结构 + 引用 + 跨章 id 去重 + needs_review 普查，D3/E11）+ `validateScene`（防御性富报告，E12）。
- `lib/agent/critic.ts`：第二个纯 LLM agent，语义自评（人物矛盾/称谓不一/漏对白/偏离原文），只报问题 + 建议、不改写；`ok = 无 major`，minor 不触发重试。沿用 PR4 I7（system 无实体示例，stub 纯按 user 消息路由）+ 形状 coerce/throw 二分。
- `lib/agent/orchestrator.ts`：`runPipeline` + `pipelineToSSEStream`；`sceneConverter.ts` 加可选 `revision` 参数（D1）。
- `app/api/convert/route.ts`：Next 16 SSE 路由，极薄（实现前读了 `node_modules/next/dist/docs/` 的 route-handlers + streaming，确认 `new ReadableStream({start})` + `new Response(stream, headers)`、`runtime="nodejs"` + `dynamic="force-dynamic"`）。

**codex 冷读如何改了架构（最能讲的）**：草案的重试循环是「确定性臂跑完→语义臂跑完」两段。codex 冷读（6/10，17 条）逮到致命的一条：**Critic 改写一个场景后，没人再跑确定性复检**——Critic 可能把场景改出新的未解析引用，却直接收尾。修法（E1）把循环改成**双层不动点**：每次 convert（含语义改写）后都先「确定性修复到不动点」，Critic 只看已 settle 的场景。又补了：① convertScene 的 **throw 纳入重试预算**（坏 JSON/坏 shape 重试，耗尽插占位 needs_review 场景 + 发 error 事件，不让一个坏场景毁掉整部，E2）；② temp=0 下**同样 critique 复现同样坏场景**→ 不动点哈希早停（E3）；③ 两臂 critique 不同仍可能 A→B→A **振荡** → 跨臂 `seen` 哈希环检测（E5）；④ **并行不打乱章节序**（按全局序归位再汇编，E5b）；⑤ 末帧改 typed `final_result` 事件（E10）；⑥ abort 链路 + Next runtime 锁定（E7/E8）。还修了我自己引入的 `validateScreenplay` 签名不一致（E11）。

**TDD 证据（先红后绿，逐组件）**：
- 每个组件都先写测试看失败（module 不存在 / 行为缺失），再最小实现到绿。
- `sse`（4）→ `validator`（8，T1–T5）→ `sceneConverter` D1（+4，T6/T7：**关键回归 T7 断言不传 revision 时 prompt 与 PR5 逐消息一致**，48 个 PR5 测全绿不受影响）→ `critic`（6，T8–T10）→ `orchestrator`（13，T12–T22 + 2 条 `pipelineToSSEStream` 流测）→ smoke（1，门控）。
- 自纠循环的两个「早停」用调用计数钉死区分：**T13 预算耗尽**（每场景 distinct → 1+budget=3 次 convert）vs **T19 不动点早停**（identical → 2 次就停）；**T14 语义重试**（distinct → critique 多次）vs **T20 环检测**（identical → critique 只 1 次就停）。

**门禁证据**：
- `npx tsc --noEmit` 干净（exit 0）；`npm run lint` 干净（0 warning）；`npm test` = **157 passed | 3 skipped**（PR4/PR5/PR6 三个门控真冒烟默认 skip）。
- **`LLM_SMOKE=1` 真端到端冒烟 1 passed（≈48s，真打 DeepSeek）**：繁體前三回样本跑通 chunk→curate→9 场景 convert+critic+retry→assemble→SSE→YAML，`validateScreenplay` 门禁干净（结构/引用/重复 id 全空）、scenes 顺序正确、`stage_progress` 计到 total、`final_result` 的 YAML 可 `fromYAML` 往返。**PR5 那次冒烟逼出的「样本对白稀」叙事在这里复现且无害**——smoke 只断契约不断对白数（同一教训）。

**与 spec 的偏差（记录）**：① 事件类型独立成 `events.ts`（见上，避免循环）；② `validateScene` 作为**独立可测工具**导出、未塞进 orchestrator 循环——因为 `convertScene` 自身的 `sceneReferentialCheck` 已对 dangling 引用 throw（被 orchestrator 的 E2 路径接住），再跑一遍 validateScene 是无法触发的死分支，TDD 下不写无测试的分支。`validateScreenplay` 则在 T12 作为整部门禁被实测。

**可讲的一句话**：「外部模型冷读救了这个 PR 的命门——我把自纠循环写成‘先修引用、再修语义’两段，看着合理，但 codex 一眼看穿：Critic 改完场景没人再查引用，等于语义臂能把我刚修好的引用又改坏。修法是把它变成‘每次改写后都重新收敛到确定性不动点’的双层循环，再加不动点早停和环检测，这样 temperature=0 的重试既不会白跑、也不会无限振荡。然后真端到端冒烟 48 秒跑通九个场景的转换+审稿+重试，证明四个 agent 真的协同工作，不只是单测里的桩。」

### PR6 大审查（`/code-review` + `/security-review`，冷读 `f41c257..HEAD` 覆盖 PR5+PR6）

> §8.1 节奏批次（PR4 后第二个节点）。基线**必须锚 PR4 合并点 `f41c257`**（PR5 已并入 main，用 `main...` 会漏掉 PR5）。

- **`/code-review`（high）**：5 条——1 真 correctness + 1 健壮性/成本 + 3 LOW。
- **`/security-review`**：0 条（严格门槛下无 HIGH/MED；输入无上限 / 信任客户端 options 这类属 DoS/资源，按 security 排除规则归到 code-review；prompt 注入、env 可信、路径-only SSRF 均排除）。

**逮到的真 bug（最值得讲）#1**：自纠循环的**语义臂会吞下占位场景**。确定性臂产出一个干净场景 S（进了 Critic），Critic 报 major，语义重试时这次 convert 反复吐坏 JSON → `convergeDeterministic` 返回 errored 占位 P；原代码 `scene = re.scene` **没查 `re.errored`**，于是把好场景 S 替换成占位 P（内容丢失），且**不发 error 事件**——**Critic 把好场景改成了垃圾，还悄无声息**。这正是冷上下文审查的价值：单测全绿，但测试编码的是我自己的假设，没覆盖「语义改写本身失败」这条路径。

**四条全部 TDD 修掉（先红后绿）**：
- **#1（MED 正确性）**：语义臂 `if (re.errored) break`——失败的修订不替换、保留当前最佳场景（仍打 needs_review）。新增红测：初始干净、所有 revision 调用抛错 → 断言最终场景是干净 S（非占位）+ needs_review + 无 spurious error 事件。
- **#2（MED 健壮性/成本）**：`MAX_RETRY_BUDGET=5` clamp 客户端 retryBudget、`MAX_NOVEL_CHARS=200_000` 上限（runPipeline 抛 + route 返 413 双层防御）。红测：retryBudget=100000 → 实际 convert 次数 = 2×(1+5)；超长 novel → reject 且零 LLM 调用。（注：concurrency 早被 `runPool` 的 `min(c, items.length)` 自然封顶，无需额外 clamp。）
- **#3（LOW）**：curate 后若 `bible.locations` 为空 → 早发 error 事件 + 抛清晰错误，而非等占位场景的 `dominantLocation` 在 pool worker 里抛、整run 崩。红测：map/reduce 返回零地点 → reject /location/i + 有 error 事件 + 零场景转换。
- **#4（LOW）**：fatal 错误时 `pipelineToSSEStream` 用 `sawError` 标志去重——runPipeline 已发过 stage 专属 error 就不再补发 assemble error。红测：curate 抛 → SSE 流里 `event: error` 恰好 1 帧（原为 2）。
- **#5（LOW，未改）**：abort 后 pool 里在飞的 worker 会跑完——影响极小（下一轮 `throwIfAborted` 即停），留着不动。

**修后门禁复跑**：`tsc` exit 0；`lint` 0 warning；`npm test` = **162 passed | 3 skipped**（+5 审查修复测）；`LLM_SMOKE=1` 真端到端冒烟**再次 1 passed（≈43s）**，确认四个修复未伤 happy path。

**可讲的一句话**：「冷上下文大审查在 merge 前逮到一个我所有单测都没覆盖的 bug——自纠循环里，如果 Critic 让我重写场景、而这次重写恰好失败，旧代码会把本来好好的场景替换成失败占位，等于 Critic 把作品改坏了还不吭声。我之所以漏掉，是因为我写的测试都在验证‘我以为会发生的事’，而审查是带着‘还有什么会出错’的冷眼睛读同一段代码。修法五行，但这正是‘每 2 个 PR 一次独立冷读’这条流程纪律存在的理由。」

**合并落点**：用户放行后走 §8 流程，PR **#8** `--merge` 入 main，merge commit **`69ff533`**，分支已删（本地+远程）。至此 **PR1–PR6 全部并入 main，后端 agent 流水线端到端跑通**（小说 → `POST /api/convert` SSE → YAML 剧本）。下一步 = PR7 前端核心（把后端可视化）。

> **流程小坑（记一笔）**：本想 merge 后把「PR6 已合并」状态同步**直接 push 到 main**，被 auto-mode 分类器正确拦下（branch-per-PR：doc 也不该直推默认分支）。改回既有套路——状态同步作为**下个 PR 分支（`pr7-frontend`）的首个 commit**落（与 PR5→PR6 时一致）。期间误用 `git reset --hard` 丢了一次未提交的 doc 编辑、重做了一遍。教训：post-merge 的状态同步走分支，别直推 main。

## PR7 · 前端核心：输入 + 实时 agent 时间线 + 剧本卡片/YAML + 导出（2026-06-06）✅

> 设计走 gstack（`/gstack-spec` 五段 + codex 冷读，spec 落 `docs/superpowers/specs/2026-06-06-pr7-frontend-design.md`，**不叠 superpowers brainstorming**，AGENTS.md 约定）；实现交 superpowers TDD。**PR7 只走每-PR 轻量门禁，不跑大审查**（下次 PR8，锚 `69ff533`）。

**做了什么**：把 PR1–PR6 端到端跑通的后端**第一次可视化**。`app/page.tsx` 从 create-next-app 脚手架换成消费 `POST /api/convert` SSE 的完整前端——输入区（粘贴/上传 .txt/内置示例）→ 点「转换」→ **agent 流水线时间线随 SSE 实时点亮**（demo 主轴）→ 剧本卡片流式出现 + YAML 源码切换 + 导出 `.yaml`。

**架构分层（关键 taste call：纯逻辑全抽到 `lib/`，node 环境单测）**：
- `lib/sse/parseSSE.ts`：有状态 SSE 帧解析器（喂**已解码字符串**、按 `\n\n` 切帧、半帧留 buffer），坏 JSON/空 data 抛 typed `SSEProtocolError`（E6）。
- `lib/client/pipelineState.ts`：纯 reducer，6 类事件 → UI 状态（4 stage + 场景累积 + 权威覆盖）。
- `lib/client/sseClient.ts`：`fetch`+`getReader`+`TextDecoder` 流式客户端（POST 无 `EventSource`），把所有失败面收敛成 1 条 error 事件。
- `lib/client/filename.ts`：导出文件名 sanitize（Windows 非法字符，E13）。
- React 组件（`app/components/`）：`ConverterApp`（唯一持流逻辑）/ `InputPanel` / `AgentTimeline` / `ScreenplayView` / `SceneCard` / `YamlView` / `ExportButton`；`app/api/sample/route.ts` GET 懒读样本（D3）。

**codex 冷读（gpt-5.5，SCORE 7/10）逮到 13 条盲点，全采纳**——最能讲的几条：
- **E1 — `error` 帧分两类**：`scenes` 阶段带 `sceneId` 的是**场景级 warning**（后端 placeholder 后继续），不可置全局 error；只有 fatal（无 sceneId / 非 scenes 阶段 / 流断没收到 `final_result`）才 `status="error"`。reducer 据此二分，`final_result` 一律权威覆盖为 `done`。
- **E2 — 场景排序用自然数序，禁字典序**：id 形如 `scene_${ch}_${i}`，字典序会把 `scene_1_10` 排到 `scene_1_2` 前。reducer 按数字分量比较。
- **E4 — 并发 `runId` 隔离**：用户连点转换/选示例再转，旧 stream 的 late event 会污染新 reducer。`ConverterApp` 每次开转换 `++runId` + 新 `AbortController` + 先 abort 旧的；`onEvent` 丢弃非当前 runId 的事件。复用为「取消」按钮（demo 安全阀）。
- **E5 — UTF-8 多字节中文跨字节边界必测**：`TextDecoder("utf-8")` 的 `decode(value,{stream:true})` 缓冲半个字、流末 `decode()` flush；否则中文/YAML 文本损坏。
- **E10 — client 边界纪律**：`lib/sse/*`、`lib/client/*` 只 `import type` from `schema`/`events`，严禁 import `lib/agent/*` 运行时或 fs/env（否则服务端代码进客户端 bundle）。`InputPanel` 的 `MAX_NOVEL_CHARS` 因此**复制**而非 import orchestrator。

**TDD 证据（先红后绿，逐单元）**：纯逻辑 `parseSSE`（7）→ `pipelineState`（10）→ `sseClient`（9，含 E5 多字节拆 chunk、E3 全失败面收敛、AbortError 静默、流断未见 final 合成 error）→ `filename`（5）；测试栈接入后组件 `SceneCard`（2）/`AgentTimeline`（2，断言 active + "3 / 9"）/`ExportButton`（1，spy `createObjectURL`+下载名 sanitize）/`InputPanel`（4）/`ScreenplayView`（3，卡片↔YAML 切换）/`ConverterApp`（2，**runId 隔离 + 取消回 idle**）；sample 路由（1，真读盘）+ page（1，无脚手架文案）。每个都先看 RED（module 不存在 / 行为缺失）再最小实现到绿。

**测试栈接入（D4，踩坑记一笔）**：装 `@testing-library/react`+`/dom`+`/jest-dom`+`jsdom`+`@vitejs/plugin-react`，vitest 配 `plugins:[react()]`、组件测试用 `// @vitest-environment jsdom` docblock（lib 单测仍 node，互不干扰）。两个真坑：① spec 原列的 `vite-tsconfig-paths` 被本版 Vite 警告「已内置」——改用 `resolve.tsconfigPaths:true` 并卸载插件，保持输出零 warning；② testing-library 自动 cleanup 只在 `globals:true` 时自注册，而本仓约定 globals 关（既有 lib 测试显式 import）——于是在 `vitest.setup.ts` 手动 `afterEach(cleanup)`（node 测试里无挂载，no-op）。

**门禁证据**：`npx tsc --noEmit` 干净（exit 0）；`npm run lint` 干净（0 warning，修了一处 unused const）；`npm test` = **209 passed | 3 skipped**（+47 前端测，既有 162 不回归）。
- **真浏览器实跑（E11，demo 主轴硬约束）**：Chrome dev server（playwright MCP 驱动）选内置示例（繁體前三回，4546 字）→ 转换 → Network 确认 `GET /api/sample 200` + `POST /api/convert 200`（SSE）；时间线**逐步点亮**（场记✓→设定集✓→场景编剧 8/9→9/9→导演✓，非一次性刷出）、9 张场景卡片**流式出现**、切 YAML 看到权威源码（场景自然数序 `scene_1_1…scene_3_4`）、导出按钮就位。真 DeepSeek 端到端 ≈30s 跑通。

**可讲的一句话**：「前端最容易写成‘点按钮、等 40 秒、啪一下出结果’——那等于把流式后端白做了。所以 PR7 的主轴是 agent 时间线随 SSE 实时点亮，让评审**看见**四个 agent 在干活。技术上被一个事实逼着走对路：`POST` 不能用原生 `EventSource`，只能 `fetch`+手动 reader+`TextDecoder` 按 `\n\n` 切帧——而 codex 冷读一眼点出两个我不会自己想到的坑：中文多字节会在字节边界被拆成两个 chunk（不 `stream:true` 就乱码），以及后端的 scene 级 error 其实是‘这一场没救了但整部继续’的 warning、不能拿来杀掉整个转换。这两条都写进了单测，最后用真浏览器的 Network 面板确认 chunk 是真的逐步到达、UI 是真的逐步更新，而不是单测里的桩。」

## PR8 · 最后阶段打磨：场景溯源 + YAML 回灌编辑 + 空/错态（2026-06-07）✅

> 设计走 gstack（`/gstack-spec` + codex 冷读，spec 落 `docs/superpowers/specs/2026-06-07-pr8-traceability-edit-polish-design.md`，**不叠 superpowers brainstorming**）；实现交 superpowers TDD。**PR8 是大审查节点**——`pr create` 前跑 `/code-review`+`/security-review` 冷读 `git diff 69ff533...<head>`（覆盖 PR7+PR8）。范围中途由用户砍轻：demo 录屏 + README 拆到 PR9。

**做了什么**：把 PR7 的「只读」前端补成产品一句话的完整闭环——「结构化、**可编辑**、**可溯源**」。三件事：① 每张场景卡加「溯源」弹层，把场景钉回小说原文并高亮（反幻觉信任闭环）；② YAML 源码视图改为**可回灌编辑**——改 YAML → 应用 → zod 校验通过则驱动卡片视图 + 导出一起更新；③ 空/错/待复核态全枚举 + 统一视觉（含 `busy` 防重复提交、错态「重试」、needs_review 徽章展开看原因）。

**架构延续 PR7 分层（纯逻辑进 `lib/client`，node 单测；组件薄）**：
- `lib/client/locateExcerpt.ts`（命门，纯函数）：excerpt → 原文 UTF-16 偏移，**三级回退**——精确 `indexOf`（去末尾省略号）→ 首段锚点（chunker 丢单空行后整段会失配，但首段始终是原文连续子串）→ 空白归一化搜索（`normalizeWithMap` 把 CRLF/全角空格/tab/丢空行折叠成单空格，带 offset-map 映回原文偏移）。
- `lib/client/applyEdit.ts`（YAML 回灌的解析+校验，**E10 窄例外**：唯一 import `lib/schema` 运行时——schema 是前后端共用的 pure/无 fs 模块，非 `lib/agent`）：包 `fromYAML`+`checkReferentialIntegrity`，补 zod 不覆盖的不变量（id 唯一、≥1 场景、长度护栏），结构/语法错 → `{ok:false,error}`（旧态不破坏），断引用 → `{ok:true,refWarnings}`（应用但警示）。
- 组件：`SourceModal`（溯源弹层，a11y 完整）/ `SceneCard`（加溯源按钮 + needs_review 展开）/ `YamlView`（重写为可编辑）/ `ScreenplayView`（透传 novel/warnings/canEdit/onApply + 流式骨架）/ `ConverterApp`（`edited` overlay + `sourceNovel` 快照 + `busy` + 重试 + 空态引导卡）。

**关键 taste call —— `edited` overlay 不进 reducer**：`pipelineState` 是 SSE 流的纯投影（E4 runId 可重放靠它）；用户编辑是流之外的另一来源，塞进 reducer 会污染可重放性。改在 `ConverterApp` 层用 `edited?: Screenplay` overlay 合流，派生 `displayScreenplay/displayScenes/displayYaml` 驱动所有视图 + 导出，start/cancel/重试 一律先清 `edited`。**`sourceNovel` 快照**同理：溯源高亮用「本轮转换时的原文」而非实时输入框（否则转换后又改输入框，溯源会去搜被改过的文本）。

**codex 冷读（read-only, medium，初版 SCORE 6.5/10）逮到 20 条（E1–E20），全 triage 写回 spec §12**——最能讲的几条：
- **E2 快照**：`novel` 是实时可编辑态 → `startConversion` 时 `setSourceNovel(novel)` 冻结给下游。
- **E7 XSS**：原文高亮**禁** `dangerouslySetInnerHTML`（小说是用户粘贴文本，innerHTML 注入即 XSS）——改用 React 文本节点 `{before}<mark>{hit}</mark>{after}` + `whitespace-pre-wrap`，天然转义（写了断言测试）。
- **E3 锚点不越界**：首段锚点命中后 `end = start + anchor.length`，**不**延到整段 excerpt 长度（否则盖到不相关后文）。
- **E12 重复 id**：schema 不去重 → 重复 id 会砸 React key/引用/导出；`applyEdit` 加唯一性校验 → `ok:false`。
- **E1/E6 已知限制（明示保留）**：`locateExcerpt` 整本搜索取首个命中，不按章裁剪——前端无章偏移，按章需复刻 chunker（违 E10）；120 字叙事 head 够独特、碰撞罕见，弹层 excerpt 文本始终正确，仅高亮位置可能偏。

**TDD 证据（先红后绿，逐单元）**：纯逻辑 `locateExcerpt`（11，含精确/锚点/归一化/CJK UTF-16 偏移/代理对/多次出现取首/未命中兜底 + `normalizeWithMap` 直测）→ `applyEdit`（8，合法/语法错/zod 路径可读/重复 id/空场景/断引用/空串/超长）；组件 `SourceModal`（7，开合/高亮 `<mark>`/未命中兜底/XSS 不注入/Esc/遮罩 vs 面板 mousedown/aria）/ `SceneCard`（+2，溯源开弹层、徽章展开 message）/ `YamlView`（6，只读态/应用成功 onApply/语法错不调 onApply/断引用警告/重置）/ `ScreenplayView`（+4，novel 透传/warning 关联/编辑回灌 onApply/流式骨架）/ `ConverterApp`（+5，busy 禁用/重试/编辑回灌反映 header/新一轮作废 overlay/sourceNovel 快照survives 输入改动）。每个先看 RED 再最小实现到绿。

**门禁证据**：`npx tsc --noEmit` 干净（exit 0）；`npm run lint` 干净（0 warning——E19「场景被替换关弹层」原用 `useEffect`+`setState` 被 `react-hooks/set-state-in-effect` 拦下，改为「弹层 open-state keyed by 场景身份」的派生渲染，更优且无副作用）；`npm test` = **252 passed | 3 skipped**（+43 新测，既有 209 不回归）。
- **真浏览器实跑（demo 闭环硬约束，2026-06-07 playwright MCP 实跑过）**：Chrome dev server 选内置示例（红楼前三回，4402 字）→ 转换（真 DeepSeek，busy 禁用「转换」+「取消」就位 + 流式骨架 → 时间线 4 阶段点亮 + 9/9 + 9 张卡片，done 后「转换」复位）→ 点首卡「溯源」→ 弹层显示「第 1 章 · 溯源」+ excerpt + **原文 `<mark>` 高亮真实红楼原文**「此開卷第一回也．作者自云…」→ Esc 关闭**且焦点还给溯源按钮**（a11y）→ 切 YAML 改 title 为「红楼梦剧本【已编辑】」点「应用」→ **header/卡片同步刷新**、无错 → 再改成非法（空 title）点「应用」→ **内联「校验错误：title: Too small…」且 header 保持上一份好状态**（onApply 未触发）→「重置」回灌到 display YAML、错误清除 → **导出 blob 实测含编辑后 title**。控制台唯一 error 是实跑时为抓 blob 注入的假 URL（测试探针，非应用 bug）。闭环全通。

### PR8 大审查（`/code-review`，冷读 `git diff 69ff533...HEAD` 覆盖 PR7+PR8，2026-06-07）

高 recall 模式：4 个独立 finder agent（逐行 / 删行回归 / 安全·a11y / cleanup·性能）冷读 → 去重 verify。**安全面干净**：无 `dangerouslySetInnerHTML`/innerHTML（高亮纯 React 文本节点，XSS 测试断言过）；原型污染被 zod `strictObject` 挡；billion-laughs 被 yaml 默认 `maxAliasCount=100` 挡；`MAX_YAML_CHARS` 护栏在 `parse` 之前；E10 边界不破（`lib/client`→`lib/agent` 仅 type-only，`applyEdit` 仅运行时依赖 pure 的 `lib/schema`）。修了 6 条：

1. **【中·真 bug】「重试」用错文本**：原 `重试` 调 `startConversion`（读实时输入框），失败后清空输入框 → 守卫 `text.trim()===0` 静默 no-op；且即便不清空也是重试「当前框」而非「失败的那份」。改：抽 `runFor(text)`，`startConversion`=`runFor(novel)`、`retryConversion`=`runFor(sourceNovel)`（重试失败快照）。加测试：失败后清空输入框，重试仍发起且跑的是原文快照。
2. **【中·性能】溯源整本重扫未 memo**：`locateExcerpt` 回退路径对整本（≤200k）跑 `normalizeWithMap`，且在 `SourceModal` render body 每次重算。改：`useMemo([novel, excerpt])`。
3. **【中·a11y】Esc `stopPropagation` + 多弹层**：document 级 Esc 监听 `stopPropagation` 会吞掉其它全局 Esc 处理器。改：去掉 `stopPropagation`（只 `onClose`）。
4. **【中·脆性】YamlView draft 不随 yaml prop 带外变更重 seed**：原只挂载时 seed 一次，靠 run 间 unmount 兜底。改：render 期「yaml 变了就重 seed draft + 清 error」（React 认可的 render 期调状态，**不**碰 warnings——自身 `应用` 也会改 yaml 但需保留刚设的引用警告）。加测试：mounted 状态下换 yaml prop → 编辑器重 seed。
5. **【低·性能】`displayYaml=toYAML(edited)` 每 render 重算**：改 `useMemo([edited, state.yaml])`。
6. **【低·性能】`warningFor` 每场景线性 find**：改 `useMemo` 建 `Map<sceneId,message>`，查 O(1)。

**记为已知/取舍保留**（recall 模式列出但不修）：locateExcerpt step-3 末尾并入尾随空白（已文档化「仅位置偏、数据不错」）；`excerptOf` 在 120 cap 处理论上劈代理对（PR5 旧码、极罕见）；needle 那趟 `normalizeWithMap` 建小 map 丢弃（excerpt ≤120 字，开销可忽略）；chunker 与 locateExcerpt 各自的空白折叠概念重复（E10 边界禁共享，定义有意不同）。

修完门禁：`npm test` = **253 passed | 3 skipped**（+1 resync 测）｜`tsc` exit 0｜`lint` 0 warning。

### PR8 用户实跑反馈·A 档快修（2026-06-07，用户亲自跑 dev server 后）

用户实跑提了 6 条；按「纯前端 + 工作量」分档，**A 档（小、纯前端、属 PR8 打磨职责）补进本 PR**，B/C 档（多文件上传 / 视觉升级 / YAML 空行 / 现代散文切分调上限）开后续 PR。本次落地两条：
1. **进度条做完不收**（AgentTimeline）：`showProgress` 原只看有无 total、没看阶段状态 → 完成后「逐场景转换 N/N」仍挂着，像卡住。改为仅 `status==="active"` 时显示，done/error 即收起。加测试断言 done 后不残留「逐场景转换 / 1 / 1」。
2. **卡片显示原始 id 难读**（SceneCard ← ScreenplayView）：slug 原样显示 `loc_rongguo`、对白显示 `char_daiyu`。改：`ScreenplayView` 从 screenplay 建 `id→name` Map（useMemo）传下，`SceneCard` 解析成中文名（荣国府 / 林黛玉），`INT/EXT`→内景/外景、`DAY/NIGHT/…`→日/夜/拂晓/黄昏/连续/稍后；无名（流式中/断引用）回退原 id。加测试：给 Map 显名、不给回退 id。

> 答疑（非代码）：左下角小 N = Next.js 框架开发工具悬浮钮，仅 dev 模式有，生产不出现，非本项目功能。YAML key 维持英文（行业剧本格式 + zod/round-trip 基石），不全改中文。
> 已知/排后续：#4 现代散文无章回体切分线索 → 整篇成 1 个超大场景候选超 `SCENE_BODY_CAP=4000` → 诚实截断 + needs_review（设计如此，非 bug）；正解是后端 chunker 增「按空行/长度切场景」+ 调上限，属 C 档单独后端 PR。

门禁：`npm test` = **256 passed | 3 skipped**（+3 测）｜`tsc` exit 0｜`lint` 0 warning。
