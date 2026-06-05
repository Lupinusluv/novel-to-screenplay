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
- [ ] **PR3 Chunker + 示例小说** — ⏭️ 下一个。`lib/agent/chunker.ts` 分章/分场景 + `samples/` ≥3 章中文示例。
- [ ] **PR4 StoryBible Curator** — 跨章人物/地点/时间线抽取，aliases 合并，稳定 id；fixture 测试。
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

### 8.1 质量门禁（每个 PR 合并前**强制**，不可凭判断跳过）

防致幻/记忆漂移的硬约束。这些是**接续会话每次都要重读并执行的事实来源**，不依赖 Claude 当下的自觉判断：

1. **外部判官**：实现完成后必跑 `npm test`（vitest 全绿）+ `npx tsc --noEmit`（类型无误），并在对话中**贴原始输出**。无输出的「通过」断言一律不算数。
2. **TDD 证据**：新测试必须先展示**先红**（证明测试非空、真在测目标），再实现到绿。
3. **冷上下文对抗复核**：`pr create` **之前**，派 `/code-review`（代码正确性/复用/简化）+ `/security-review`（安全面）各跑一次——二者用**独立上下文冷读 diff**，结论交用户。
4. **人为放行**：以上结论摆给用户，**用户点头才 merge**。Claude 触发审查，用户拍板放行。

> 适用范围：每个 PR 无差别执行（哪怕「只是个 schema」也跑 security-review——是否有安全面不由 Claude 临场判断）。

---

## 9. 环境坑（重要）

- **非 ASCII 用户名路径**：Windows 用户名是「羽扇豆」，`bun build --compile` 会因临时文件路径含非 ASCII 失败。**本项目用 npm + Next.js，不涉及该步**，但若引入 bun 编译要走 ASCII 路径方案（见全局 `~/.claude/CLAUDE.md`）。
- create-next-app 拒绝非空目录：本项目当初生成到 `scaffold-tmp` 子目录再上移（保留原 CLAUDE.md）。

---

## 10. /clear 后如何接续

1. 读本文件（`docs/PROJECT.md`）+ 必要时读 `~/.claude/plans/agent-vibe-coding-...md`。
2. `git checkout main && git pull --ff-only` 同步。
3. 看「§6 PR 路线图」找到下一个未完成 PR（当前为 **PR2**）。
4. 按「§8 工作流」开分支，按「具体开发优先 superpowers skill（TDD）」推进。
5. 完成后更新本文件 §6 的进度勾选，并随 PR 一起提交。

## 11. Demo 视频脚本（20%，最后录）

1. 30s 痛点：小说改剧本门槛高、跨章人物易乱。
2. 选内置 3 章示例 → 点转换 → **重点录 agent 时间线**：分章→抽人物圣经→逐场转换→校验自纠。
3. 右侧剧本卡片流式生成 → 切 YAML 源码视图（展示 id 引用与 elements 流）。
4. 编辑一句对白 → 导出 .yaml。
5. 点场景溯源 → 跳回原文段落（讲信任闭环）。
6. 30s 小结：Schema 设计原因 + agent 四能力（规划/记忆/工具/自纠）。

## 非目标（YAGNI）

不做：用户账号/数据库、PDF/Fountain 导出（schema 已预留）、多语言、实时协同编辑。
