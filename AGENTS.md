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

**进度**：PR1（LLM client）/ PR2（Schema+YAML+SCHEMA.md）/ PR3（Chunker+红楼梦样本）/ PR4（StoryBible Curator）/ PR5（Scene Converter）/ **PR6（Validator + Critic + Orchestrator + SSE：后端流水线收尾闭环）** ✅ **全部已并入 main**，main 在 **`69ff533`**（Merge PR #8）。**PR7（前端核心）✅ 实现完成、门禁全过、PR #9 已开、待用户拍板 merge**——分支 **`pr7-frontend`**，最新 commit **`3a19e32`**。**现在全栈端到端跑通**：小说 → chunk → StoryBible → 逐场景(convert+critic+自纠重试) → 汇编 → `POST /api/convert` SSE → **前端实时时间线 + 剧本卡片/YAML + 导出**。`pr7-frontend` 上 `npm test`=**209 passed | 3 skipped**、`tsc`/`lint` 干净、**E11 真浏览器实跑过**（Chrome dev server + playwright MCP，时间线逐步点亮 + 卡片流式 + 导出，真 DeepSeek ≈30s）。PR 路线图见 `docs/PROJECT.md §6`；实现纪实见 `docs/DEVLOG.md` PR7 节。

**质量门禁（强制，见 `docs/PROJECT.md §8.1`）**：每 PR 必跑 `npm test`+`npx tsc --noEmit`（贴原始输出）、TDD 先红、更新 `docs/DEVLOG.md`、用户点头才 merge。冷上下文大审查（`/code-review`+`/security-review`）每 2 PR 一次——**PR4、PR6 已审过；下次是 PR8**，diff 基线锚到 PR6 合并点 `69ff533`（即 `git diff 69ff533...<pr8-head>`，覆盖 PR7+PR8）。**PR7 已走完每-PR 轻量门禁、未跑大审查（按约定）。** 注：**doc 状态同步不直接 push main**（branch-per-PR；分类器会拦），作为下个 PR 分支的首个 commit 落。

**接续步骤（PR7 已实现、PR #9 待 merge）**：① 读 `docs/PROJECT.md §10`（当前状态快照 + 接续步骤）+ `docs/DEVLOG.md`（尤其 PR7 节）+ `docs/SCHEMA.md`；② **`git checkout pr7-frontend`**——**别重做任何已完成的事**（PR1–PR6 后端在 main，PR7 前端已 commit 在本分支：`app/components/*`、`lib/sse/*`、`lib/client/*`、`app/api/sample/route.ts`、替换后的 `app/page.tsx`）；③ **第一件事 = 决定是否 merge PR #9**（门禁已过、已开 PR）：用户放行 → `"$GH" pr merge 9 --merge --delete-branch` → `git checkout main && git pull --ff-only`；④ **merge 后**把「PR7 已合并」状态同步作为下个分支 `pr8-xxx` 首个 commit 落（**不直 push main**）；⑤ **再开 PR8**：gstack 设计（不叠 superpowers brainstorming）→ superpowers TDD 实现（溯源弹层/跳回原文、编辑能力、空错态打磨、README+demo）；⑥ **PR8 是大审查节点**，`pr create` 前跑 `/code-review`+`/security-review` 冷读 `69ff533...<pr8-head>`。

**前端架构事实（PR7 已落地，备查）**：① 纯逻辑全在 `lib/`（node 单测）：`lib/sse/parseSSE.ts`（SSE 帧解析器，坏帧抛 `SSEProtocolError`）/ `lib/client/pipelineState.ts`（纯 reducer，**E1 error 两类二分**：`scenes`+`sceneId` 是场景级 warning 不杀全局，否则 fatal；**E2 场景自然数序**）/ `lib/client/sseClient.ts`（`fetch`+`getReader`+`TextDecoder` 流式，POST 无 EventSource；**E5 中文多字节跨 chunk** + **E3 全失败面收敛成 1 条 error，AbortError 静默**）/ `lib/client/filename.ts`（导出名 sanitize）。② **E10 client 边界纪律**：`lib/sse/*`、`lib/client/*` 只 `import type` from schema/events，严禁 import `lib/agent/*` 运行时/fs/env（`MAX_NOVEL_CHARS` 在 `InputPanel` 复制而非 import）。③ 组件 `app/components/`：`ConverterApp`（唯一持流逻辑，**runId 隔离 E4** + 取消按钮）→ `InputPanel`/`AgentTimeline`/`ScreenplayView`/`SceneCard`/`YamlView`/`ExportButton`；内置示例走 `GET /api/sample`（`app/api/sample/route.ts`，fs 懒读）。④ **只读 + 导出**（编辑/溯源留 PR8）。⑤ 测试栈：`@testing-library/react`+`jsdom`+`@vitejs/plugin-react`，vitest 用内置 `resolve.tsconfigPaths` + 手动 `afterEach(cleanup)`（globals 关，组件测试加 `// @vitest-environment jsdom` docblock）。⑥ **Next 16 写前端前先读 `node_modules/next/dist/docs/`**。⑦ LLM 真跑需 `DEEPSEEK_API_KEY`（已在环境；单测走 fixture）。
