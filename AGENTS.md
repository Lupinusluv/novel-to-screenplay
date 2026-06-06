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

**进度**：PR1（LLM client）/ PR2（Schema+YAML+SCHEMA.md）/ PR3（Chunker+红楼梦样本）/ PR4（StoryBible Curator：首个 LLM agent，map-reduce 产人物/地点表，aliases 合并，稳定 id + provenance）✅ **均已合并**，main 在 `f41c257`。`npm test` = 74 passed | 1 skipped、`tsc` 干净。**下一个：PR5 Scene Converter**（单场景 → elements，强制引用 Bible id）。PR 路线图与进度见 `docs/PROJECT.md §6`。

**质量门禁（强制，见 `docs/PROJECT.md §8.1`）**：每 PR 必跑 `npm test`+`npx tsc --noEmit`（贴原始输出）、TDD 先红、更新 `docs/DEVLOG.md`、用户点头才 merge。冷上下文大审查（`/code-review`+`/security-review`）每 2 PR 一次——**PR4 已审过；下次是 PR6**，基线锚到 PR4 合并点 `f41c257`（覆盖 PR5+PR6，详见 §8.1）。**PR5 只走每-PR 轻量门禁、不跑大审查。**

**PR5 起步须知**：① LLM 配置已就绪——`loadLLMConfigFromEnv` 三者全缺时回退 DeepSeek（baseURL `https://api.deepseek.com`、model `deepseek-chat`），单测走 fixture、真冒烟用 `LLM_SMOKE=1` opt-in；② 待议决策（样本是否改简体、红楼取哪几回作 demo）到 PR5/demo 阶段该定，见 `docs/PROJECT.md §6` 下方备注；③ PR5 是创意性 LLM agent，设计阶段**只走 gstack（spec + /gstack-plan-eng-review + codex 冷读），不跑 superpowers brainstorming**（见上「项目协作约定」），设计定稿后 TDD；④ PR5 复用 PR4 产出的 `StoryBible`（带稳定 id + `provenance` 章号侧表）作跨章共享记忆，场景转换须强制引用 Bible id。

**接续步骤**：① 读 `docs/PROJECT.md`（单一事实来源，§10 接续步骤）+ `docs/DEVLOG.md`（开发纪实）；② `git checkout main && git pull --ff-only`（顶端应为 `f41c257` Merge PR #6）；③ 找 §6 下一个未完成 PR（当前 PR5）；④ 按 §8/§8.1 开分支、设计走 gstack（不跑 superpowers brainstorming）、TDD、跑门禁。
