# 小说转剧本 · 项目说明 / 接续指引（PROJECT.md）

> 本文件是项目的**单一事实来源**与**跨会话接续指引**。新会话（尤其是 `/clear` 之后）请先读本文件，再继续开发。
> 完整初始计划另存于：`C:\Users\羽扇豆\.claude\plans\agent-vibe-coding-40-40-pr-commit-3-20-twinkly-hinton.md`

---

## 1. 这是什么 / 为什么

面向 **agent 方向求职面试**的 vibe coding 作品。主办方要的是「既懂技术、又懂产品/业务价值闭环的产品架构师」。三选题中选了**选题三：AI 小说转剧本工具**。

**产品一句话**：作者粘贴/上传 **≥3 章**小说 → agent 流水线自动产出**结构化、可编辑、可溯源**的影视剧本初稿（YAML），并附 Schema 设计文档。

**为什么选它**（也是评分主轴）：
- 技术风险最低（纯文本、无实时音频/延迟，质量可控）；
- 唯一明确要求**自定义 YAML Schema 并书面论证设计原因** → 产品架构师核心加分项；
- 「3 章以上」隐含**跨章一致性** → 正好需要 agent 的记忆/规划/自校验，完整展示 agentic 架构；
- 天然可拆多个高质量 PR → 契合「工程质量 + PR 数量 + commit 分布」。

**评审权重**：① 完整度与创新 40% ② 开发过程与质量（架构/代码/PR/commit 分布）40% ③ demo 表达 20%。

---

## 2. 已确认的关键决策

| 维度 | 决定 |
|---|---|
| 技术栈 | **Next.js 16 + React 19 + TypeScript + Tailwind 4** 全栈单仓（App Router；API Route 用 SSE 流式推 agent 进度） |
| LLM 接入 | **OpenAI 兼容抽象**（`lib/llm/client.ts`），baseUrl/key/model 全可配、运行时可切 |
| demo 模型 | **DeepSeek-V4-flash**（OpenAI 兼容；按此调 prompt，但代码不绑定） |
| 剧本类型 | **影视剧本**（场景/内外景/日夜/动作/对白/表演提示/转场） |
| 依赖 | `zod`（schema）、`yaml`（序列化）、`vitest`（测试） |

---

## 3. 架构总览

```
qiniuyun/
├─ app/
│  ├─ page.tsx                 # 主界面：左输入 / 右剧本 / Agent 进度时间线
│  ├─ api/convert/route.ts     # SSE 路由：驱动 pipeline，流式推送事件
│  └─ components/              # 输入区、剧本卡片视图、YAML 视图、进度时间线、溯源弹层
├─ lib/
│  ├─ llm/client.ts            # ✅ OpenAI 兼容 client（超时/重试/稳健 JSON 抽取）
│  ├─ schema/
│  │  ├─ screenplay.ts         # zod schema + TS 类型（单一事实来源）
│  │  └─ yaml.ts               # screenplay <-> YAML 序列化/反序列化
│  └─ agent/
│     ├─ chunker.ts            # 分章 + 分场景（确定性）
│     ├─ storyBible.ts         # 跨章抽取人物/地点/时间线（共享记忆）
│     ├─ sceneConverter.ts     # 单场景 -> 剧本元素流（引用 Bible 的 id）
│     ├─ validator.ts          # 确定性校验：zod + 引用完整性
│     ├─ critic.ts             # LLM 自我批判：一致性/漏对白/角色矛盾
│     └─ orchestrator.ts       # 串联各 stage + 自纠重试循环 + 发射 SSE 事件
├─ samples/                    # 内置 ≥3 章示例小说
├─ docs/SCHEMA.md              # YAML Schema 设计文档（含设计原因论证）
└─ docs/PROJECT.md             # 本文件
```

**数据流**：小说文本 → `chunker`（章/场景）→ `storyBible`（全局人物/地点）→ 逐场景 `sceneConverter`（引用 bible id）→ `validator`+`critic`（不过则带反馈重试，最多 N 次）→ 汇编为 `Screenplay` → `yaml.ts` 序列化。全过程 `orchestrator` 通过 SSE 推 `stage_start/stage_progress/partial_result/stage_done/error` 事件。

---

## 4. 应用内 Agent 角色分工（职责表）

把 pipeline 设计成一支"剧组"：3 个 LLM 角色 + 2 个确定性工具 + 1 个编排者。每个角色**职责单一、输入/输出契约明确、可独立测试**。这套分工本身就是作品要展示的 agent 架构。

| 角色 | 类型 | 职责 | 输入 | 输出 | 边界（不做什么） |
|---|---|---|---|---|---|
| **Orchestrator（导演）** | 编排(非 LLM) | 规划顺序；维护共享状态；驱动自纠重试；发射 SSE 事件 | 全文 + 配置 | `Screenplay` + 事件流 | 不做具体业务，只调度 |
| **Chunker（场记）** | 工具(确定性) | 按标题/分隔启发式切章与场景候选 | raw text | `chapters[]/sceneCandidates[]` | 不理解语义，不调 LLM |
| **StoryBible Curator（设定集）** | LLM | 扫全文产出统一人物表(aliases 合并)、地点表、时间线 = **跨章共享记忆拥有者** | 全部章节 | `characters[]/locations[]`（稳定 id） | 不生成场景剧本 |
| **Scene Converter（场景编剧）** | LLM | 单场景叙述→剧本元素流，**强制引用 Bible 的 id** | 单场景 + Bible | 单个 `Scene` | 不新增/改人物地点；不跨场景 |
| **Validator（格式审校）** | 工具(确定性) | zod 校验 + **引用完整性**(character_id/location_id 必须存在) | `Scene/Screenplay` | 校验报告(pass/fail+错误) | 不做语义判断 |
| **Critic（责编）** | LLM | 语义自评：人物矛盾/称谓不一/漏对白/是否还原原文 | `Scene`+原文+Bible | 问题清单+修订建议 | 不直接改写（回灌 Converter 重试） |

**self-correction 闭环（由 Orchestrator 编排）**：
```
Chunker → StoryBible Curator(写入共享记忆)
      → 每个场景：
           Scene Converter ─▶ Validator(确定性) ─fail+错误─▶ 重试 Converter
                                  │pass
                                  ▼
                               Critic(语义) ─有问题+建议─▶ 重试 Converter
                                  │ok / 超 N 次则打 needs_review 保留并继续
                                  ▼
                            汇编进 Screenplay
```
- **共享记忆**：Story Bible 是只读快照，被所有 Scene Converter 引用 → 跨章一致性。
- **重试预算**：每场景 Validator/Critic 各最多 N 次（默认 2）；超限不阻塞，打 `needs_review` 标记继续。

---

## 5. YAML Schema 草案（影视剧本）

`lib/schema/screenplay.ts` 用 zod 定义，`docs/SCHEMA.md` 论证。顶层结构：

```yaml
title: 剧名
logline: 一句话梗概
characters:                 # 人物表 = Story Bible（跨场景共享）
  - id: char_lin            # 稳定 id，被场景引用
    name: 林深
    aliases: [小林, 林队长]  # 同角色多称呼 -> 跨章一致性关键
    description: 三十岁刑警
    arc: 从怀疑到信任
locations:
  - id: loc_cafe
    name: 街角咖啡馆
scenes:
  - id: scene_1
    heading: { int_ext: INT, location_id: loc_cafe, time_of_day: DAY }  # 枚举
    synopsis: 场景一句话概要
    source: { chapter: 1, excerpt: "1-3段" }   # 溯源 -> 可信、可回查
    elements:               # 有序异构列表：忠实表达剧本线性时间流
      - { type: action, text: "林深推门而入。" }
      - { type: dialogue, character_id: char_lin, parenthetical: "(压低声音)", line: "你来了。" }
      - { type: transition, text: "CUT TO:" }
```

**设计原因（写进 SCHEMA.md）**：
- **id 引用而非内联字符串**：改一处全局生效；agent 跨章记忆落点；可机器校验引用完整性。
- **elements 有序异构列表**：剧本本质是线性时间流，固定字段无法表达"动作—对白—动作"交错。
- **source 溯源**：对抗 LLM 幻觉、建立作者信任，闭合"可编辑、可打磨"价值。
- **枚举（INT/EXT、DAY/NIGHT）**：对齐行业标准，可机器校验、可被渲染器消费。
- **纯数据、无表现层**：同一 YAML 可被多种渲染器消费（卡片、Fountain/PDF 导出、再加工）。

---

## 6. PR 路线图与进度

每个 PR = 一分支，自带测试，单一职责。

- [x] **PR1 脚手架 + LLM client + 配置** — ✅ 已合并(#1)。Next.js 脚手架种子 + `lib/llm/client.ts`(OpenAI 兼容、超时/重试/extractJSON) + vitest(11 测试) + `.env.example`。
- [x] **PR2 Schema + 文档** — ✅ 完成。`lib/schema/screenplay.ts`(zod，strict + 判别联合 + 引用完整性)+`lib/schema/yaml.ts`(round-trip，关 anchor) + `docs/SCHEMA.md`(7 项设计论证)；15 测试(schema 9 + yaml 6)。
- [x] **PR3 Chunker + 示例小说** — ✅ 完成。`lib/agent/chunker.ts`(确定性分章/两遍分场景：分隔行+大空行+转场提示词) + `samples/honglou-meng-ch1-3.txt`(公有领域《红楼梦》前三回真实文本)；13 测试(含真实样本冒烟 + 锚定正则拒绝正文「第四回中…」回归)。
- [x] **PR4 StoryBible Curator** — ✅ **已并入 main（#6，merge commit `f41c257`）**。
  `lib/agent/storyBible.ts`：map-reduce + 确定性 id 后处理（`assignIds`/`sanitizeSlug`）、人物**与地点**别名合并、
  `provenance` 侧表（R6）、中间层 zod（I1）+ 强校验 `validateStoryBible`（I2）；`LocationSchema.aliases`（R5）、
  `loadLLMConfigFromEnv` DeepSeek 回退（I8）。**74 passed | 1 skipped**（含 1 门控真 LLM 冒烟，默认 skip）；`tsc` 干净。
  设计依据见 `docs/superpowers/specs/2026-06-06-pr4-storybible-curator-design.md §10`（R1–R6 + I1–I8）。
  实现纪实与真数据逼出的修复见 `docs/DEVLOG.md` PR4 实现纪实节。
  （**门控决策**：真冒烟用 `LLM_SMOKE=1` 显式 opt-in + key 双条件，默认/本机/CI 均 skip，合 §8.1。）
  （**大审查已过**：`/code-review`+`/security-review` 冷读 `dd47ed3..HEAD`。安全零发现；正确性 1 中危已修——
  分章正则强制空格分隔符会漏「标题紧贴」章回，改为「分隔符可选 + 标题禁含句读」的标点护栏，TDD 先红后绿，
  原 `第四回中…` 假标题回归仍绿。低危发现 defer，见下方「PR4 审查 defer 项」。详见 DEVLOG「PR4 大审查」节。）

> **样本决策（已定，2026-06-06 PR5 设计阶段）**：
> - **改用简体 + 取红楼回3/6/7**（黛玉进贾府 / 劉姥姥一進榮國府 / 送宮花）——群戏、对白密、别名丰、地点清晰，鳳姐/寶玉/黛玉跨三回反复出场作跨章合并弹药。当前 `samples/honglou-meng-ch1-3.txt` 是繁體前三回（截断在黛玉进府前、对白稀，偏弱）。
> - **执行已拆出 PR5**（PR5 spec §11 E4：双模型一致，避免 scope 陷阱 + OpenCC 依赖风险）：语料重拉（curl 取 Gutenberg 逐字 → OpenCC 转简 → 裁剪 → 归一化回目 → 同步 chunker 繁體 cue 冒烟测试，保留小繁體 fixture 续测健壮性）作**独立预备步骤**，置于 demo（PR7/8）前。PR5 冷烟复用现有繁體前三回样本。
> - **LLM 配置缺口**（已在 PR4 spec 定方案，实现待落地）：环境仅有 `DEEPSEEK_API_KEY`。方案 = `loadLLMConfigFromEnv`
>   显式 `LLM_*` 优先、三者全缺时回退 DeepSeek（baseURL `https://api.deepseek.com`、model `deepseek-chat`）；
>   **部分显式 + DeepSeek key → 报缺失项错、不回退**（spec §10 I8）。单测走 fixture 不烧 key。
>
> **PR4 审查 defer 项（低危，记录不改，按需在后续 PR 处理）**：
> - **分章正则若再现误判 → 上「序号单调」判据**（审查时的备选方案 2）：章回号须续上序列才认作标题，比标点护栏更稳健但要重写收集逻辑、处理楔子/序。当前标点护栏对「`第十回里的故事` 这类无标点短散文」仍可能误判——真出现再升级。
> - `assignIds` 纯数字 romanization 与位置兜底可撞 id（`char_2`/`char_2_2`），唯一性仍保持；LLM 给拼音 hint 几乎不可能纯数字，惰性。
> - `computeProvenance` O(N×C) 全扫描，3 章无感，全本输入下可换倒排索引。
> - char/loc 四 schema + 双胞胎管线重复（spec 已接受对称重复）；如第三个对称实体出现再抽 `EntityBase`/`buildTable()` 泛化。
- [x] **PR5 Scene Converter** — ✅ **已并入 main（#7，merge commit `42454b7`）**。
  `lib/agent/sceneConverter.ts`：单候选→单 `Scene`，LLM 只说名字、代码权威解析 name→id（D1/D2）；结构垃圾抛错 vs 引用未命中走 issues 二分（D6）。
  评审增量全部落地：E1 地点诚实回退（最小 id scoped、明标 `heading unverified`，堵掉「结构有效的语义谎言」）、E2 歧义三级梯（name>alias>scoped>码点序 + `ambiguous_reference`+candidates）、E3 coerce 剔噪、E5 降级台词「」包裹、E6 `SCENE_BODY_CAP` 截断诚实化、I6 全库解析=有效引用。
  **122 passed | 2 skipped**（含 PR5 门控真冒烟，默认 skip；`LLM_SMOKE=1` 实跑 1 passed ≈20s）；`tsc` 干净；`lint` 干净。
  设计 spec + §11 权威增量见 `docs/superpowers/specs/2026-06-06-pr5-scene-converter-design.md`；TDD 实现纪实（含真模型冒烟逼出的样本叙事纠偏、实证 E4 defer 正确）见 `docs/DEVLOG.md` PR5 节。
- [x] **PR6 Validator + Critic + Orchestrator + SSE** — ✅ **已并入 main（#8，merge commit `69ff533`）**。
  四组件 `lib/agent/validator.ts`（整部门禁 D3）/ `critic.ts`（第二个 LLM agent，语义自评）/ `orchestrator.ts`（`runPipeline` 双层自纠不动点 + 并行 + SSE 事件，+ `pipelineToSSEStream`）+ `events.ts`/`sse.ts`（事件契约 + typed SSE 编码）+ `app/api/convert/route.ts`（Next16 SSE 路由）+ `sceneConverter.ts` 加可选 `revision` 参数（D1）。
  codex 冷读 6/10→收紧，§11 权威增量 E1–E14 全落地（双层不动点重试 / throw 纳入预算 / 不动点+环检测 / 并行不打乱章节序 / final_result typed 事件 / abort + Next runtime）。
  **大审查已过**（`/code-review`+`/security-review` 冷读 `f41c257..69ff533` 覆盖 PR5+PR6）：code-review 5 条（1 真 correctness「语义臂吞占位场景」+ 4 健壮性/LOW），security 0 条；#1–#4 已 TDD 修掉，#5 评估后留。
  **162 passed | 3 skipped**（含 PR6 门控真冒烟，默认 skip）；`tsc` 干净；`lint` 干净；`LLM_SMOKE=1` 真端到端冒烟 1 passed（≈43s，9 场景全流程）。
  设计 spec 见 `docs/superpowers/specs/2026-06-06-pr6-validator-critic-orchestrator-design.md`；实现 + 大审查纪实见 `docs/DEVLOG.md` PR6 节。
- [x] **PR7 前端核心** — ✅ **已并入 main（#9，merge commit `5d726af`）**（分支 `pr7-frontend`，已删）。
  纯逻辑全抽到 `lib/`（node 单测）：`lib/sse/parseSSE.ts`（有状态 SSE 帧解析器，坏帧抛 typed `SSEProtocolError`）/ `lib/client/pipelineState.ts`（纯 reducer，E1 error 两类二分 + E2 场景自然数序）/ `lib/client/sseClient.ts`（`fetch`+`getReader`+`TextDecoder` 流式，E5 中文多字节跨 chunk + E3 全失败面收敛 + AbortError 静默）/ `lib/client/filename.ts`（导出名 sanitize E13）。
  组件 `app/components/`：`ConverterApp`（runId 隔离 E4 + 取消）/ `InputPanel` / `AgentTimeline`（4 stage 随 SSE 点亮）/ `ScreenplayView`（卡片↔YAML 切换）/ `SceneCard` / `YamlView` / `ExportButton`；`app/api/sample/route.ts`（GET 懒读样本 D3）；`app/page.tsx` 替换脚手架。
  测试栈：`@testing-library/react`+`jsdom`+`@vitejs/plugin-react`，vitest 用内置 `resolve.tsconfigPaths`（替掉 `vite-tsconfig-paths`）+ 手动 `afterEach(cleanup)`（globals 关）。
  设计走 gstack（spec `docs/superpowers/specs/2026-06-06-pr7-frontend-design.md`，codex 冷读 13 条 E1–E13 全落地）。**只读 + 导出**（编辑/溯源弹层/空错态打磨留 PR8）。
  **209 passed | 3 skipped**（+47，既有 162 不回归）；`tsc` 干净；`lint` 干净。**E11 真浏览器实跑**（Chrome dev server + playwright MCP）：选示例→转换，Network 确认 `GET /api/sample 200`+`POST /api/convert 200`(SSE)，时间线逐步点亮（场记✓→设定集✓→场景编剧 9/9→导演✓）、9 卡片流式出现、切 YAML（自然数序）、导出就位，真 DeepSeek ≈30s。**PR7 只走 A 档、不跑大审查。** 实现纪实见 `docs/DEVLOG.md` PR7 节。
- [x] **PR8 最后阶段打磨（溯源 + 编辑 + 空错态）** — ✅ **已并入 main（#10，merge commit `1162e8d`）**（分支 `pr8-traceability-polish`，已删）。
  ① 场景溯源弹层 `SourceModal`（`lib/client/locateExcerpt.ts` 三级回退定位 → `<mark>` 高亮原文，纯 React 文本节点禁 innerHTML，focus trap/Esc/aria）；② **YAML 回灌编辑** `lib/client/applyEdit.ts`（`fromYAML`+zod+id 唯一/≥1 场景/长度护栏 → `edited` overlay 驱动卡片+导出，断引用警示、错态保好态）；③ 空/错态打磨（空态引导卡、流式骨架、`busy` 防重复、错态「重试」跑失败快照、needs_review 展开）；④ A 档反馈快修（进度条做完收起、卡片 id→中文名+枚举译中）。
  设计走 gstack（spec `docs/superpowers/specs/2026-06-07-pr8-traceability-edit-polish-design.md`，codex 冷读 20 条 E1–E20 全吸收）。**大审查已过**（`/code-review` 冷读 `69ff533...HEAD` 覆盖 PR7+PR8，4 finder 高 recall；安全面干净；修 6 条：重试用错文本/溯源 memo/Esc stopPropagation/YamlView re-seed/displayYaml memo/warning Map）。
  **256 passed | 3 skipped**（+47 over PR7 的 209）；`tsc`/`lint` 干净；**真浏览器 E2E 实跑过**（溯源高亮真红楼原文 → 改 YAML 应用 → 卡片/导出同步 → 错态保好态 → Esc 还焦，导出 blob 实测含编辑后内容）。实现 + E2E + 大审查纪实见 `docs/DEVLOG.md` PR8 节。
- [x] **PR9 切分鲁棒性（后端 chunker）** — ✅ **已并入 main（#11）**（分支 `pr9-chunker-robustness`，已删）。
  纯 `lib/agent` 增量（+ 3 处 `orchestrator.ts`）：① **回目识别鲁棒化** `CHAPTER_HEADING` 重写——可选 `《》`/`【】` 前缀 + `第N卷/章/回/节/部/篇` + 组合 `第N卷·第N章` + 英译 `Chapter/Ch.N`，保留 PR4 标点护栏（根治「《红楼梦》第三回」整篇当 1 章、`chapter` 全 1）；② **长度兜底（硬保证）** `SCENE_SOFT_TARGET=1500` + `splitToTarget`（无损 段→句→硬切 greedy 装箱），每候选 ≤ 软目标 ≪ `SCENE_BODY_CAP`，截断退化为永不触发的 backstop（根治现代散文整篇超大场景被截）；③ **近重复检测** 3-gram Jaccard（`≥100` 字 + `≥40` trigram 双门槛防误杀/防退化周期串），相邻合并保更长者、非相邻 `SceneCandidate.nearDuplicateOf` 标记 → orchestrator `flagNearDuplicate` 转 `needs_review`+人读注记不自动删；④ 位置忠实不重排（doc 写明，`source.chapter` 维持位置序）；⑤ 三体裁脏 fixtures（`lib/agent/__fixtures__/`：红楼带前缀+多版本 / 现代散文超长 / 网文短章+英译）。
  设计走 gstack `/gstack-spec` + **codex 冷读 SCORE 7/10**（F1–F6 全收紧，含**弃用**会错杀选集/卷重置/番外的危险「章号递增 sanity」）。**用户拍板轻量档：只跑 codex 冷读，大审查并入 PR10。**
  **实跑修复**：用户跑真实文件 `人生何处不青山.txt`（无章回散文）暴露**早存的 Critic 脆性**——chunker 正确切成 9 真实场景后，DeepSeek 偶发返回缺 `suggestion` 的 critique，`critiqueScene` 按设计抛错但 orchestrator 未包裹 → 异常杀掉整条 run。修：`processCandidate` 两处 critique 调用包 try/catch，Critic 抛错降级为 `needs_review` + 继续（不动 critic.ts 契约）。**真浏览器 E2E 实跑过**（playwright + 真 DeepSeek ≈105s：9 场景全出、章号对、无截断、导出就位）。
  **275 passed | 3 skipped**（+19，既有 256 零回归）；`tsc`/`lint` 干净。spec 见 `docs/superpowers/specs/2026-06-07-pr9-chunker-robustness-design.md`；实现 + 实跑修复纪实见 `docs/DEVLOG.md` PR9 节。
- [x] **PR10 前端打磨 MVP** — ✅ **已并入 main**（分支 `pr10-frontend-polish`）。用户时间压力下收成 MVP：① **视觉升级**（渐变标题/徽章/示例卡片墙/indigo 主色/hover+focus 态，去简陋感）② **多 `.txt` 上传**（`lib/client/concatFiles.ts` 自然序拼接，`第2章<第10章`）③ **多体裁示例集框架**（`lib/samples/manifest.ts` + `GET /api/sample`→manifest、`?id=`→正文，id 查表解析无路径穿越）+ **三大体裁真跑通**（古典章回=红楼 / 现代网文=原创《回响纪元》/ 散文=原创《老站台》，均真 DeepSeek + playwright 端到端验证）+ `docs/DEMO-SCRIPT.md` 演讲稿。**285 passed | 3 skipped**（+10，零回归）、`tsc` 干净。**用户拍板：先合并、PR10 大审查移到转 public 前（PR11）一起跑。** 设计阶段未走完 gstack spec（时间压力下中途叫停，转 superpowers TDD 直接实现）。**Defer**：YAML 块间空行可读性；意识流/鲁迅短篇/武侠等其余体裁语料。实现纪实见 `docs/DEVLOG.md` PR10 节。
- [ ] **PR11 README + demo 收尾 + 大审查** — README（架构图/跑法/Schema 设计论证索引/agent 四能力）+ 录屏 demo（脚本见 `docs/DEMO-SCRIPT.md`/§11）。**并入此前 defer 的 PR10 大审查**：转 public 前跑 `/code-review`+`/security-review` 冷读 `git diff 1162e8d...<head>`（覆盖 **PR9+PR10+PR11**，含 chunker/示例 route 解析未信任输入）。**最后做**。

---

## 7. 开发命令

```bash
npm run dev            # 启动 dev server（http://localhost:3000）
npm test               # vitest run（CI 用）
npm run test:watch     # vitest 监听
npx tsc --noEmit       # 类型检查（vitest 用 esbuild 不做类型检查，需 tsc 兜底）
npm run lint           # eslint
```

LLM 集成测试需配置 `.env.local`（参考 `.env.example`：`LLM_BASE_URL/LLM_API_KEY/LLM_MODEL`）。单测用 fixture，不依赖真实 API。

---

## 8. Git / PR 工作流（branch-per-PR）

- 仓库：`https://github.com/Lupinusluv/novel-to-screenplay`（**private**，6.5–6.7 防抄袭，之后转 public）。
- 账号：`Lupinusluv`。`main` 为集成主干。
- **`gh` 全路径**：`"C:\Program Files\GitHub CLI\gh.exe"`（winget 装的，工具内 shell 的 PATH 未刷新，调用时用全路径或全局 PATH 终端）。

每个 PR 流程：
```bash
GH="/c/Program Files/GitHub CLI/gh.exe"
git checkout -b prN-xxx main          # 基于最新 main 开分支
# ...TDD 开发，commit...
git push -u origin prN-xxx
"$GH" pr create --base main --head prN-xxx --title "..." --body "..."
"$GH" pr merge prN-xxx --merge --delete-branch
git checkout main && git pull --ff-only
```
commit message 结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

### 8.1 质量门禁（防致幻/记忆漂移的硬约束）

这些是**接续会话每次都要重读并执行的事实来源**，不依赖 Claude 当下的自觉判断。分两档节奏：

**A. 每个 PR 必跑（轻量，不托节奏）**
1. **外部判官**：实现完成后必跑 `npm test`（vitest 全绿）+ `npx tsc --noEmit`（类型无误），并在对话中**贴原始输出**。无输出的「通过」断言一律不算数。
2. **TDD 证据**：新测试必须先展示**先红**（证明测试非空、真在测目标），再实现到绿。
3. **开发纪实**：合并前在 `docs/DEVLOG.md` 追加本 PR 一节（亮点 / 踩坑大 bug / 痛点权衡 / demo 可讲的一句话），服务后期 demo「有话可说」。只记真事。
4. **人为放行**：结论摆给用户，**用户点头才 merge**。

**B. 每累计 2 个 PR 跑一次（重量级冷上下文大审查）**
5. **冷上下文对抗复核**：在第 2、4、6…个 PR 的 `pr create` 之前，派 `/code-review`（正确性/复用/简化）+ `/security-review`（安全面）各跑一次，用**独立上下文冷读这两个 PR 的合并差异**，结论交用户。中间的 PR（第 1、3、5…）只走 A 档，不跑大审查，避免托节奏。

> 节奏锚点：PR2 ✅、**PR4 ✅（锚 `dd47ed3` 覆盖 PR3+PR4）**、**PR6 ✅（锚 `f41c257` 覆盖 PR5+PR6）**、**PR8 ✅（锚 `69ff533` 覆盖 PR7+PR8）**。**PR9 走轻量档（codex 冷读 7/10）。PR10 用户拍板「先合并、大审查留到转 public 前」→ 大审查移到 PR11**（覆盖 **PR9 + PR10 + PR11**，基线锚仍 **PR8 合并点 `1162e8d`**，即 `git diff 1162e8d...<head>`，含 PR9/PR10 解析未信任输入那部分）。是否到节点不由 Claude 临场判断——按本表 PR 序号对照。**PR7 只走 A 档；PR9 走 A 档 + codex 冷读；PR10 走 A 档（大审查欠账记在 PR11）。**

---

## 9. 环境坑（重要）

- **非 ASCII 用户名路径**：Windows 用户名是「羽扇豆」，`bun build --compile` 会因临时文件路径含非 ASCII 失败。**本项目用 npm + Next.js，不涉及该步**，但若引入 bun 编译要走 ASCII 路径方案（见全局 `~/.claude/CLAUDE.md`）。
- create-next-app 拒绝非空目录：本项目当初生成到 `scaffold-tmp` 子目录再上移（保留原 CLAUDE.md）。

---

## 10. /clear 后如何接续

> **当前状态快照（2026-06-07）**：**PR1–PR10 全部已并入 main**。PR10（前端打磨 MVP）加了多体裁示例选择器（古典章回/现代网文/散文，三类真跑通）+ 多 `.txt` 自然序上传 + 视觉升级；演讲稿在 `docs/DEMO-SCRIPT.md`。**PR11（README + demo 收尾 + 欠账的大审查）是下一个**——基于新 main 开 `pr11-readme-demo`。**欠账提醒**：PR10 大审查（`/code-review`+`/security-review` 冷读 `1162e8d...head` 覆盖 PR9+PR10+PR11）用户拍板移到转 public 前的 PR11 一起跑，别忘了。
> **现在全栈端到端跑通、可编辑可溯源、且能吃脏输入**：小说 → chunk（**回目鲁棒识别 + 长度兜底 + 近重复检测**）→ StoryBible → 逐场景(convert+critic+自纠重试，**Critic 失败降级 needs_review 不中断整条 run**) → 汇编 → `POST /api/convert` SSE → **前端实时时间线 + 卡片(id 已解析中文名)/YAML + 溯源高亮原文 + YAML 回灌编辑 + 导出**。
> main 上 `npm test` = **275 passed | 3 skipped**（PR9 累计 +19；既有零回归），`tsc` 干净，`lint` 干净；PR9 期间 **真浏览器 E2E 实跑过**（用户真实文件 `人生何处不青山.txt` 12.3k 字无章回散文 → 9 场景全出、章号正确、无截断、导出就位，真 DeepSeek ≈105s）。
> **PR9 收尾要点**：① 回目/长度/近重复三块切分鲁棒性已落地（详见 §6 PR9 行 + DEVLOG PR9 节）；② 实跑逼出并修掉了**下游 Critic 的健壮性盲点**（Critic 抛错原会杀掉整条 run，已改为降级 needs_review）；③ 这篇文本 needs_review 偏多是「文本+模型」特性，用户拍板不再调 Critic 宽容度（留作可选优化）。
> **下次大审查节点 = PR10**（锚 `1162e8d`，覆盖 PR9+PR10，含 PR9 解析未信任输入那部分）——PR9 用户拍板只跑了 codex 冷读，大审查并入 PR10。

**接续步骤（PR11 待开工，PR1–PR10 已合并在 main）**：
1. 读本文件（§6 路线图看 PR11 行 / §3 架构 / §4 角色分工 / §11 demo 脚本）+ `docs/DEVLOG.md`（**PR10 节 + PR9 节**）+ `docs/SCHEMA.md` + `docs/DEMO-SCRIPT.md`（演讲稿）。
2. **`git checkout main && git pull --ff-only`，再 `git checkout -b pr11-readme-demo main`**——**别重做任何已完成的事**：PR1–PR10 全在 main。
3. **PR11 内容**：README（架构图/跑法/Schema 设计论证索引/agent 四能力）+ demo 录屏收尾（链接放 README 显眼处，用户自录）。docs 为主、低风险。
4. **PR11 跑欠账的大审查**：`/code-review`+`/security-review` 冷读 `git diff 1162e8d...<pr11-head>`（覆盖 **PR9+PR10+PR11**，含 chunker/示例 route 解析未信任输入），结论交用户、修完再合。这是转 public 前的最后一道关。
5. **用户点头才 merge**。
6. **前后端契约（备查，PR11 基本不动代码）**：`POST /api/convert` body `{novel, options?}` → SSE typed 帧（`lib/agent/events.ts`）；前端消费链 = `sseClient.runConversion` → `pipelineReducer` → `ConverterApp`。示例走 `GET /api/sample`（无 id 返 manifest、`?id=` 返正文；清单在 `lib/samples/manifest.ts`，加体裁=加一行+丢一个 `samples/*.txt`）。chunker 鲁棒（`lib/agent/chunker.ts`）、Critic 失败已降级不崩。Next 16 写前端前读 `node_modules/next/dist/docs/`。
8. **YAML id 是设计而非 bug**（用户问过）：`scenes[].*_id` 是指向顶部 `characters:`/`locations:` 表的稳定引用，支撑跨章人物合并 + 引用完整性校验；卡片解析成中文名给人读、YAML 留 id 给机器。不要改成内嵌中文名。

**架构/规划用 gstack、具体开发用 superpowers**（AGENTS.md 约定）。gstack 子技能现已全部注册可用
（`/gstack-plan-eng-review`、`/gstack-spec`、`/gstack-autoplan`…，带 `gstack-` 前缀），codex 已装并鉴权可做 outside-voice。
若发现 gstack 子技能又不触发，见全局 `~/.claude/CLAUDE.md` 的「setup 静默跳过技能注册」修复办法。

## 11. Demo 视频脚本（20%，最后录）

1. 30s 痛点：小说改剧本门槛高、跨章人物易乱。
2. 选内置 3 章示例 → 点转换 → **重点录 agent 时间线**：分章→抽人物圣经→逐场转换→校验自纠。
3. 右侧剧本卡片流式生成 → 切 YAML 源码视图（展示 id 引用与 elements 流）。
4. 编辑一句对白 → 导出 .yaml。
5. 点场景溯源 → 跳回原文段落（讲信任闭环）。
6. 30s 小结：Schema 设计原因 + agent 四能力（规划/记忆/工具/自纠）。

## 非目标（YAGNI）

不做：用户账号/数据库、PDF/Fountain 导出（schema 已预留）、多语言、实时协同编辑。
