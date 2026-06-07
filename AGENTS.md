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

**进度**：PR1（LLM client）/ PR2（Schema+YAML+SCHEMA.md）/ PR3（Chunker+红楼梦样本）/ PR4（StoryBible Curator）/ PR5（Scene Converter）/ PR6（Validator + Critic + Orchestrator + SSE）/ PR7（前端核心）/ PR8（溯源弹层 + YAML 回灌编辑 + 空错态打磨）/ **PR9（切分鲁棒性·后端 chunker）** ✅ **全部已并入 main**（PR9 = Merge PR #11）。**现在全栈端到端跑通且可编辑可溯源、且能吃脏输入**：小说 → chunk（**回目鲁棒识别 + 长度兜底 + 近重复检测**）→ StoryBible → 逐场景(convert+critic+自纠重试，**Critic 失败降级 needs_review 不中断**) → 汇编 → `POST /api/convert` SSE → **前端实时时间线 + 卡片(id 解析中文名)/YAML + 溯源高亮原文 + YAML 回灌编辑 + 导出**。main 上 `npm test`=**275 passed | 3 skipped**、`tsc`/`lint` 干净；PR9 期间 **真浏览器 E2E 实跑过**（用户真实文件 `人生何处不青山.txt` 12.3k 字无章回散文 → 9 场景全出、章号正确、无截断、导出就位，真 DeepSeek ≈105s）。**PR10（前端打磨·B 档）是下一个**——基于新 main 开 `pr10-frontend-polish`。PR 路线图见 `docs/PROJECT.md §6`；实现纪实见 `docs/DEVLOG.md`。

**质量门禁（强制，见 `docs/PROJECT.md §8.1`）**：每 PR 必跑 `npm test`+`npx tsc --noEmit`（贴原始输出）、TDD 先红、更新 `docs/DEVLOG.md`、用户点头才 merge。冷上下文大审查（`/code-review`+`/security-review`）每 2 PR 一次——**PR4、PR6、PR8 已审过**。**PR9 用户拍板走轻量档：只跑 codex 冷读复审（spec SCORE 7/10），大审查并入 PR10**。**下次大审查节点 = PR10，锚 PR8 合并点 `1162e8d`，覆盖 PR9+PR10**（`git diff 1162e8d...<pr10-head>`）。注：**doc 状态同步随 PR 一起合并，不单独直接 push main**（branch-per-PR；分类器会拦）。

**接续步骤（PR10 待开工，PR1–PR9 已合并在 main = Merge PR #11）**：① 读 `docs/PROJECT.md §10`（当前状态快照 + 接续步骤）+ `docs/DEVLOG.md`（**尤其 PR9 节 + 节末「用户实跑反馈·Critic 崩溃修复」**）+ `docs/SCHEMA.md`；② **`git checkout main && git pull` 然后 `git checkout -b pr10-frontend-polish main`**——**别重做任何已完成的事**（PR1–PR9 全在 main）；③ **PR10 设计先行**：走 gstack（`/gstack-spec` + codex 冷读，不叠 superpowers brainstorming），范围见 §6 PR10（视觉升级去简陋感 / 多 .txt 上传按文件名自然序拼接 / YAML 块间空行可读性 / **可选：B/C 档 dogfooding 反馈**）；④ **superpowers TDD 实现**（纯前端）；⑤ **PR10 是大审查节点**：`pr create` 前跑 `/code-review`+`/security-review` 冷读 `git diff 1162e8d...<pr10-head>`（覆盖 PR9+PR10，含 PR9 解析未信任输入那部分），结论交用户；⑥ 用户点头才 merge。后续 PR11（README+demo 收尾）。

**前端架构事实（PR7 已落地，备查）**：① 纯逻辑全在 `lib/`（node 单测）：`lib/sse/parseSSE.ts`（SSE 帧解析器，坏帧抛 `SSEProtocolError`）/ `lib/client/pipelineState.ts`（纯 reducer，**E1 error 两类二分**：`scenes`+`sceneId` 是场景级 warning 不杀全局，否则 fatal；**E2 场景自然数序**）/ `lib/client/sseClient.ts`（`fetch`+`getReader`+`TextDecoder` 流式，POST 无 EventSource；**E5 中文多字节跨 chunk** + **E3 全失败面收敛成 1 条 error，AbortError 静默**）/ `lib/client/filename.ts`（导出名 sanitize）。② **E10 client 边界纪律**：`lib/sse/*`、`lib/client/*` 只 `import type` from schema/events，严禁 import `lib/agent/*` 运行时/fs/env（`MAX_NOVEL_CHARS` 在 `InputPanel` 复制而非 import）。③ 组件 `app/components/`：`ConverterApp`（唯一持流逻辑，**runId 隔离 E4** + 取消按钮）→ `InputPanel`/`AgentTimeline`/`ScreenplayView`/`SceneCard`/`YamlView`/`ExportButton`；内置示例走 `GET /api/sample`（`app/api/sample/route.ts`，fs 懒读）。④ **只读 + 导出**（编辑/溯源留 PR8）。⑤ 测试栈：`@testing-library/react`+`jsdom`+`@vitejs/plugin-react`，vitest 用内置 `resolve.tsconfigPaths` + 手动 `afterEach(cleanup)`（globals 关，组件测试加 `// @vitest-environment jsdom` docblock）。⑥ **Next 16 写前端前先读 `node_modules/next/dist/docs/`**。⑦ LLM 真跑需 `DEEPSEEK_API_KEY`（已在环境；单测走 fixture）。
