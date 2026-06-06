<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 项目协作约定

**架构 / 规划 / 设计只走 gstack 一套流程**（`/gstack-spec`、`/gstack-plan-eng-review`、`/gstack-autoplan` 等 + codex 跨模型冷读），**不再叠跑 superpowers 的 brainstorming**——两套一起跑太重、且职责重叠。具体开发 / 实现（TDD、写代码、调试）才用 superpowers。

> 约定变更记录（2026-06-06，用户拍板）：此前 PR4 走的是「superpowers brainstorming → gstack /plan-eng-review + codex」两段式；自 PR5 起**砍掉 superpowers brainstorming 这一段**，设计阶段直接进 gstack（spec / 工程评审 / codex 冷读），轻量化。PR5 本会话的 brainstorming 已跑完、不回头补，仅自下个设计起照此执行。

# 项目状态与约定（每个会话先读，/clear 后据此接续）

**这是什么**：AI 小说转剧本工具（≥3 章小说 → agent 流水线 → 结构化可编辑 YAML 影视剧本）。求职面试 vibe coding 作品。**完整设计/进度/接续指引见 `docs/PROJECT.md`（单一事实来源）。**

**技术栈**：Next.js 16 + React 19 + TS + Tailwind 4 全栈；LLM 走 `lib/llm/client.ts`（OpenAI 兼容，可配）；zod + yaml + vitest。

**命令**：`npm test`（vitest）、`npx tsc --noEmit`（类型检查，必跑）、`npm run dev`。

**Git/PR 工作流**：branch-per-PR，`main` 为集成主干。仓库 `github.com/Lupinusluv/novel-to-screenplay`（private）。`gh` 全路径 `"C:\Program Files\GitHub CLI\gh.exe"`（工具 shell PATH 未刷新）。流程见 `docs/PROJECT.md §8`。

**进度**：PR1（LLM client）/ PR2（Schema+YAML+SCHEMA.md）/ PR3（Chunker+红楼梦样本）/ PR4（StoryBible Curator）/ PR5（Scene Converter）/ **PR6（Validator + Critic + Orchestrator + SSE：后端 agent 流水线收尾闭环）** ✅ **全部已并入 main**，main 在 **`69ff533`**（Merge PR #8）。**后端端到端跑通**：小说 → chunk → StoryBible → 逐场景(convert+critic+自纠重试) → 汇编 Screenplay → `POST /api/convert` SSE 流式 + YAML。PR4/PR6 两次大审查均过。`npm test`=**162 passed | 3 skipped**、`tsc`/`lint` 干净、`LLM_SMOKE=1` 真端到端冒烟通过（≈43s）。**当前在做 PR7（前端核心）**：分支 **`pr7-frontend`**（基于 main `69ff533`，目前只有一个「PR6 已合并」状态同步 commit），下一步设计前端、消费 `POST /api/convert` 的 SSE 事件契约（`lib/agent/events.ts`）。PR 路线图见 `docs/PROJECT.md §6`；各 PR 实现纪实见 `docs/DEVLOG.md`。

**质量门禁（强制，见 `docs/PROJECT.md §8.1`）**：每 PR 必跑 `npm test`+`npx tsc --noEmit`（贴原始输出）、TDD 先红、更新 `docs/DEVLOG.md`、用户点头才 merge。冷上下文大审查（`/code-review`+`/security-review`）每 2 PR 一次——**PR4、PR6 已审过；下次是 PR8**，diff 基线锚到 PR6 合并点 `69ff533`（即 `git diff 69ff533...<pr8-head>`，覆盖 PR7+PR8）。**PR7 只走每-PR 轻量门禁、不跑大审查。** 注：**doc 状态同步不直接 push main**（branch-per-PR；分类器会拦），作为下个 PR 分支的首个 commit 落（如本 `pr7-frontend` 的「PR6 已合并」同步）。

**接续步骤（PR1–PR6 已合并，当前在 PR7 前端）**：① 读 `docs/PROJECT.md §10`（当前状态快照 + 接续步骤）+ `docs/DEVLOG.md`（全程纪实，尤其 PR6 节）+ `docs/SCHEMA.md`；② **`git checkout pr7-frontend`**（基于 main `69ff533`，已有「PR6 已合并」状态同步 commit——**别重做 PR1–PR6，后端已就绪**）；③ **设计 PR7**：走 gstack（`/gstack-spec` 五段 + codex 冷读），spec 落 `docs/superpowers/specs/`，**不叠 superpowers brainstorming**；④ 设计定稿 → superpowers TDD 实现前端；⑤ PR7 走每-PR 轻量门禁（test+tsc+TDD 先红+DEVLOG+用户点头），**不跑大审查**（下次 PR8，锚 `69ff533`）；⑥ 门禁过 + 用户点头 → §8 PR 流程 merge。

**PR7 地基事实（备查）**：① **后端已就绪、PR7 只做前端**——`POST /api/convert`（`app/api/convert/route.ts`）接 `{novel, options?}`，SSE 流式发 `PipelineEvent`（类型见 `lib/agent/events.ts`：`stage_start/stage_progress/partial_result/stage_done/final_result/error`，typed 通道 `event: <type>\ndata: <json>`）；末帧 `final_result` 带完整 `Screenplay` + YAML 文本。② 前端要做：输入区（粘贴/上传/内置示例 `samples/honglou-meng-ch1-3.txt`）+ 剧本卡片视图 + YAML 切换 + 导出 + **agent 进度时间线随 SSE 点亮**（demo 主轴，§4 角色分工可视化）。③ schema 类型从 `lib/schema/screenplay.ts` 导入；YAML 用 `lib/schema/yaml.ts`。④ `app/page.tsx` 当前是脚手架默认页，PR7 替换。⑤ **Next 16 写前端前先读 `node_modules/next/dist/docs/`**（本版 API 与训练记忆可能不同，见文件顶部红字）。⑥ LLM 真跑需 `DEEPSEEK_API_KEY`（已在环境；`loadLLMConfigFromEnv` 三者全缺回退 DeepSeek，单测走 fixture）。
