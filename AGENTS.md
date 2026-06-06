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

**进度**：PR1（LLM client）/ PR2（Schema+YAML+SCHEMA.md）/ PR3（Chunker+红楼梦样本）/ PR4（StoryBible Curator：首个 LLM agent，map-reduce 产人物/地点表，aliases 合并，稳定 id + provenance）✅ **均已合并**，main 在 `f41c257`。**PR5 Scene Converter：设计 + 评审（ENG CLEARED）+ TDD 实现全部完成、每-PR 门禁通过，待用户点头 merge。** `lib/agent/sceneConverter.ts`（单候选→单 `Scene`，LLM 只说名字、代码权威解析 name→id；结构垃圾抛错 vs 引用未命中走 issues 二分；评审增量 E1–E6/I1–I11 全落地）+ 48 fixture 测 + 1 门控真冒烟。`npm test` = **122 passed | 2 skipped**、`tsc` 干净、`lint` 干净、`LLM_SMOKE=1` 真冒烟实跑通过。分支 `pr5-scene-converter` HEAD `52ceadf`（3 设计 commit + 1 实现 commit，领先 main，**未推 origin、未 merge**）。**下一步 = 用户放行 → push + `pr create` + merge（§8）→ 接 PR6**。spec `docs/superpowers/specs/2026-06-06-pr5-scene-converter-design.md`（§11 权威增量），实现纪实见 `docs/DEVLOG.md` PR5 节。PR 路线图见 `docs/PROJECT.md §6`。

**质量门禁（强制，见 `docs/PROJECT.md §8.1`）**：每 PR 必跑 `npm test`+`npx tsc --noEmit`（贴原始输出）、TDD 先红、更新 `docs/DEVLOG.md`、用户点头才 merge。冷上下文大审查（`/code-review`+`/security-review`）每 2 PR 一次——**PR4 已审过；下次是 PR6**，基线锚到 PR4 合并点 `f41c257`（覆盖 PR5+PR6，详见 §8.1）。**PR5 只走每-PR 轻量门禁、不跑大审查（已完成）。**

**接续步骤（PR5 实现已完成、未 merge）**：① 读 `docs/PROJECT.md §10`（当前状态快照 + 接续步骤）+ `docs/DEVLOG.md` PR5 节 + spec §11；② **`git checkout pr5-scene-converter`**（HEAD `52ceadf`：3 设计 commit + 1 实现 commit；`git log` 确认实现 commit 在——**实现已完成、门禁已过、不要重写/不要重跑设计**）；③ **若用户已放行 merge** → 走 §8 PR 流程：push + `"$GH" pr create --base main` + `pr merge --merge --delete-branch` + 回 main `git pull --ff-only`；④ merge 后 **接 PR6**（Validator+Critic+Orchestrator+SSE）——**PR6 是大审查批次**，diff 基线锚 `f41c257` 覆盖 PR5+PR6（§8.1）。

**PR5 关键事实（备查）**：① LLM 配置就绪——`loadLLMConfigFromEnv` 三者全缺回退 DeepSeek，单测走 fixture、真冒烟 `LLM_SMOKE=1` opt-in（默认 skip）；② **样本**：PR5 冷烟复用现有繁體前三回样本（E4 决定）；简体回3/6/7 语料重拉是 demo（PR7/8）前的**独立预备步骤**——PR5 真冒烟已实证现样本对白稀、是 E4 把语料迁移 defer 出 PR5 的正确性佐证（见 DEVLOG PR5 节）；③ 复用 PR4 `StoryBible`（稳定 id + `provenance` 侧表）作跨章共享记忆，场景转换强制引用 Bible id（`checkReferentialIntegrity` 防御自检）。
