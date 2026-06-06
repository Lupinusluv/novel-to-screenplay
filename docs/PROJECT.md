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

> **待议决策（defer 到对应 PR，勿遗忘）**：
> - **示例小说改用简体**（便于 demo 展示）。当前 `samples/honglou-meng-ch1-3.txt` 是繁體红楼梦；换简体样本时同步更新 chunker 的繁體 cue 冒烟测试（繁體 cue 支持可保留作健壮性）。—— 到 PR5 / demo 阶段定。
> - **红楼梦不一定取前三回**作 demo；章节选择到对应 PR 再定。
> - **LLM 配置缺口**（已在 PR4 spec 定方案，实现待落地）：环境仅有 `DEEPSEEK_API_KEY`。方案 = `loadLLMConfigFromEnv`
>   显式 `LLM_*` 优先、三者全缺时回退 DeepSeek（baseURL `https://api.deepseek.com`、model `deepseek-chat`）；
>   **部分显式 + DeepSeek key → 报缺失项错、不回退**（spec §10 I8）。单测走 fixture 不烧 key。
>
> **PR4 审查 defer 项（低危，记录不改，按需在后续 PR 处理）**：
> - **分章正则若再现误判 → 上「序号单调」判据**（审查时的备选方案 2）：章回号须续上序列才认作标题，比标点护栏更稳健但要重写收集逻辑、处理楔子/序。当前标点护栏对「`第十回里的故事` 这类无标点短散文」仍可能误判——真出现再升级。
> - `assignIds` 纯数字 romanization 与位置兜底可撞 id（`char_2`/`char_2_2`），唯一性仍保持；LLM 给拼音 hint 几乎不可能纯数字，惰性。
> - `computeProvenance` O(N×C) 全扫描，3 章无感，全本输入下可换倒排索引。
> - char/loc 四 schema + 双胞胎管线重复（spec 已接受对称重复）；如第三个对称实体出现再抽 `EntityBase`/`buildTable()` 泛化。
- [ ] **PR5 Scene Converter** — 单场景→elements，强制引用 Bible id；fixture 测试。
- [ ] **PR6 Validator + Critic + Orchestrator + SSE** — 校验/自评/编排重试循环 + `app/api/convert/route.ts`；端到端跑通 sample。
- [ ] **PR7 前端核心** — 输入(粘贴/上传/示例)+剧本卡片视图+YAML 切换+导出。
- [ ] **PR8 Agent 可视化 + 溯源 + 打磨** — 进度时间线随 SSE 点亮、场景溯源、空/错状态、README + demo 脚本。

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

> 节奏锚点：PR2 ✅、**PR4 ✅（已跑，锚 `dd47ed3` 覆盖 PR3+PR4）**。**下一次大审查节点 = PR6**（覆盖 PR5 + PR6），之后 PR8。是否到节点不由 Claude 临场判断——按本表 PR 序号对照。**PR5 只走 A 档、不跑大审查。**
>
> **PR6 大审查基线（重要，防遗忘）**：PR5 会先行合并，故 PR6 冷审查须把 diff 基线**锚到 PR5 合并之前** = **PR4 合并点 `f41c257`**，即 `git diff f41c257...<pr6-head>`，覆盖 PR5+PR6 两批改动。直接用 `main...` 会漏掉已并入 main 的 PR5。

---

## 9. 环境坑（重要）

- **非 ASCII 用户名路径**：Windows 用户名是「羽扇豆」，`bun build --compile` 会因临时文件路径含非 ASCII 失败。**本项目用 npm + Next.js，不涉及该步**，但若引入 bun 编译要走 ASCII 路径方案（见全局 `~/.claude/CLAUDE.md`）。
- create-next-app 拒绝非空目录：本项目当初生成到 `scaffold-tmp` 子目录再上移（保留原 CLAUDE.md）。

---

## 10. /clear 后如何接续

> **当前状态快照（2026-06-06）**：**PR1–PR4 全部已并入 main**，main 在 **`f41c257`**（Merge PR #6）。
> PR4 StoryBible Curator 完工：`lib/agent/storyBible.ts`（map-reduce + 确定性 id + provenance + 强校验）、
> `LocationSchema.aliases`、`loadLLMConfigFromEnv` DeepSeek 回退；大审查（覆盖 PR3+PR4）已过、低危项 defer 记于 §6。
> 当前 `npm test` = **74 passed | 1 skipped**（门控真冒烟默认 skip），`tsc` 干净。
> **下一个：PR5 Scene Converter**（单场景 → elements，强制引用 Bible id）。**PR5 不是审查批次**（下次大审查在 PR6，§8.1）。

1. 读本文件（`docs/PROJECT.md`，单一事实来源）+ `docs/DEVLOG.md`（开发纪实，供 demo）。
2. **回 main 起 PR5 分支**：`git checkout main && git pull --ff-only`（应看到顶端 `f41c257` Merge PR #6），
   再 `git checkout -b pr5-scene-converter`。
3. **PR5 是创意性 LLM agent，先 brainstorming 设计、再 TDD**（与 PR4 同节奏；架构/规划用 gstack，开发用 superpowers）。
   复用 PR4 已铺好的地基：`curateStoryBible` 产出的 `StoryBible`（`characters`/`locations` 带稳定 id + `provenance` 侧表）
   就是 PR5 的跨章共享记忆——场景转换须**强制引用 Bible id**（见 §3 schema 的引用完整性 `checkReferentialIntegrity`）。
   `provenance[id] → 章号` 可用来按章圈定候选实体，避免把整本 bible 塞进每个场景 prompt。
4. **§6 待议决策到 PR5 该定了**：① 示例小说是否改简体（同步 chunker 繁體 cue 冒烟）；② 红楼梦取哪几回作 demo。
5. 跑齐 §8.1 门禁（`npm test`+`npx tsc --noEmit` 贴原始输出、TDD 先红、更新 DEVLOG、用户点头才 merge）。
   **PR5 不跑大审查**（按 §8.1 节奏锚点表，下次是 PR6，基线锚到 PR4 合并点 `f41c257`）。

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
