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

**进度**：PR1（LLM client）/ PR2（Schema+YAML+SCHEMA.md）/ PR3（Chunker+红楼梦样本）/ PR4（StoryBible Curator）/ PR5（Scene Converter）/ PR6（Validator + Critic + Orchestrator + SSE）/ PR7（前端核心）/ PR8（溯源弹层 + YAML 回灌编辑 + 空错态打磨）/ PR9（切分鲁棒性·后端 chunker）/ PR10（前端打磨 MVP·视觉升级+多 txt 上传+四体裁示例集）/ **PR11（README + Render 部署 + demo 收尾 + 欠账大审查）** ✅ **全部已并入 main**。**项目功能层面已收尾、且已部署到 Render 线上可访问**（https://novel-to-screenplay-gtoh.onrender.com，端到端实跑验证过）。**现在全栈端到端跑通、可编辑可溯源、吃脏输入、四体裁真示例、多 txt 自然序上传、视觉打磨**：小说 → chunk（**回目鲁棒识别 + 长度兜底 + 近重复检测 + ReDoS 行长闸**）→ StoryBible → 逐场景(convert+critic+自纠重试，**Critic 失败降级 needs_review 不中断**) → 汇编 → `POST /api/convert` SSE → **前端实时时间线 + 卡片(id 解析中文名)/YAML + 溯源高亮原文 + YAML 回灌编辑 + 导出**。main 上 `npm test`=**289 passed | 3 skipped**、`tsc`/`lint` 干净；**线上 Render 端到端实跑验证过**（四体裁示例 + 长流式 `final_result` 收尾不被掐）。**收尾完成**：demo 视频已录并填入 README 顶部（B 站 BV1ySEb6TEuC）。**唯一待办**：评审交付后按需 Suspend Render / 轮换 key。PR 路线图见 `docs/PROJECT.md §6`；实现纪实见 `docs/DEVLOG.md`（**尤其 PR11 节**）。

**质量门禁（强制，见 `docs/PROJECT.md §8.1`）**：每 PR 必跑 `npm test`+`npx tsc --noEmit`（贴原始输出）、TDD 先红、更新 `docs/DEVLOG.md`、用户点头才 merge。冷上下文大审查（`/code-review`+`/security-review`）每 2 PR 一次——**PR4、PR6、PR8 已审过；PR11 已跑欠账大审查**（锚 PR8 合并点 `1162e8d`，覆盖 **PR9+PR10+PR11**，逮到并修 1 个中危 ReDoS：`chunker.ts CHAPTER_HEADING` 加 `MAX_HEADING_LINE` 行长闸）。**PR9 当时只跑 codex 冷读（SCORE 7/10），PR10 用户拍板先合并、大审查并入 PR11——现已补齐。** 注：**doc 状态同步随 PR 一起合并，不单独直接 push main**（branch-per-PR；分类器会拦）。

**接续步骤（已收尾并上线 Render，demo 已填）**：① 读 `docs/PROJECT.md §10`（当前状态快照）+ `docs/DEVLOG.md`（**尤其 PR11 节**）+ `docs/SCHEMA.md` + `docs/DEMO-SCRIPT.md`；② **评审交付后**：按需在 Render Suspend 服务 / 轮换 LLM key（公开链接烧用户自己的 key，余额耗尽 storybible 阶段会 402）；③ 若要加体裁：`samples/` 丢 `.txt` + `lib/samples/manifest.ts` 加一行。

**前端架构事实（PR7 已落地，备查）**：① 纯逻辑全在 `lib/`（node 单测）：`lib/sse/parseSSE.ts`（SSE 帧解析器，坏帧抛 `SSEProtocolError`）/ `lib/client/pipelineState.ts`（纯 reducer，**E1 error 两类二分**：`scenes`+`sceneId` 是场景级 warning 不杀全局，否则 fatal；**E2 场景自然数序**）/ `lib/client/sseClient.ts`（`fetch`+`getReader`+`TextDecoder` 流式，POST 无 EventSource；**E5 中文多字节跨 chunk** + **E3 全失败面收敛成 1 条 error，AbortError 静默**）/ `lib/client/filename.ts`（导出名 sanitize）。② **E10 client 边界纪律**：`lib/sse/*`、`lib/client/*` 只 `import type` from schema/events，严禁 import `lib/agent/*` 运行时/fs/env（`MAX_NOVEL_CHARS` 在 `InputPanel` 复制而非 import）。③ 组件 `app/components/`：`ConverterApp`（唯一持流逻辑，**runId 隔离 E4** + 取消按钮）→ `InputPanel`/`AgentTimeline`/`ScreenplayView`/`SceneCard`/`YamlView`/`ExportButton`；内置示例走 `GET /api/sample`（`app/api/sample/route.ts`，fs 懒读）。④ **只读 + 导出**（编辑/溯源留 PR8）。⑤ 测试栈：`@testing-library/react`+`jsdom`+`@vitejs/plugin-react`，vitest 用内置 `resolve.tsconfigPaths` + 手动 `afterEach(cleanup)`（globals 关，组件测试加 `// @vitest-environment jsdom` docblock）。⑥ **Next 16 写前端前先读 `node_modules/next/dist/docs/`**。⑦ LLM 真跑需 `DEEPSEEK_API_KEY`（已在环境；单测走 fixture）。
