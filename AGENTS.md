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

**进度**：PR1（LLM client）/ PR2（Schema+YAML+SCHEMA.md）/ PR3（Chunker+红楼梦样本）/ PR4（StoryBible Curator：首个 LLM agent，map-reduce 产人物/地点表，aliases 合并，稳定 id + provenance）✅ **均已合并**，main 在 `f41c257`。`npm test` = 74 passed | 1 skipped、`tsc` 干净。**当前：PR5 Scene Converter 进行中**——**设计已完成并评审通过（ENG CLEARED）**，spec `docs/superpowers/specs/2026-06-06-pr5-scene-converter-design.md`（§11 是 gstack 工程评审 + codex 冷读的权威增量），分支 `pr5-scene-converter` 已有 3 个设计 commit（领先 main，**未推 origin、未 merge**），HEAD `bbe2e50`。**下一步 = 按 spec §11「实现任务 T1–T7」开 TDD 写代码（development 用 superpowers）**，尚未写一行实现代码。PR 路线图见 `docs/PROJECT.md §6`。

**质量门禁（强制，见 `docs/PROJECT.md §8.1`）**：每 PR 必跑 `npm test`+`npx tsc --noEmit`（贴原始输出）、TDD 先红、更新 `docs/DEVLOG.md`、用户点头才 merge。冷上下文大审查（`/code-review`+`/security-review`）每 2 PR 一次——**PR4 已审过；下次是 PR6**，基线锚到 PR4 合并点 `f41c257`（覆盖 PR5+PR6，详见 §8.1）。**PR5 只走每-PR 轻量门禁、不跑大审查。**

**PR5 起步须知**：① LLM 配置已就绪——`loadLLMConfigFromEnv` 三者全缺时回退 DeepSeek（baseURL `https://api.deepseek.com`、model `deepseek-chat`），单测走 fixture、真冒烟用 `LLM_SMOKE=1` opt-in；② 样本待议决策**已定**（简体 + 红楼回3/6/7「黛玉进贾府/劉姥姥一進/送宮花」），但**语料重拉执行已拆出 PR5**（评审 E4：避免 scope 陷阱 + OpenCC 依赖风险）——PR5 冷烟复用现有繁體前三回样本，简体回3/6/7 迁移作独立预备步骤、demo（PR7/8）前做；③ PR5 是创意性 LLM agent，设计阶段**只走 gstack（spec + /gstack-plan-eng-review + codex 冷读），不跑 superpowers brainstorming**（见上「项目协作约定」），设计定稿后 TDD；④ PR5 复用 PR4 产出的 `StoryBible`（带稳定 id + `provenance` 章号侧表）作跨章共享记忆，场景转换须强制引用 Bible id。

**接续步骤（PR5 设计已完成，直接接 TDD）**：① 读 `docs/PROJECT.md`（§10 接续步骤）+ `docs/DEVLOG.md` + **PR5 spec `docs/superpowers/specs/2026-06-06-pr5-scene-converter-design.md`（重点读 §11 权威增量 + 末尾 T1–T7 任务）**；② **`git checkout pr5-scene-converter`**（分支已存在、已有 3 个设计 commit，HEAD `bbe2e50`；**不要回 main 重开、不要重跑设计/brainstorming**）；③ 用 superpowers 的 TDD 流程从 **T1** 起逐个实现（先红后绿）；④ 跑 §8.1 每-PR 门禁（`npm test`+`npx tsc --noEmit` 贴原始输出、TDD 先红、更新 DEVLOG、用户点头才 merge）；**PR5 不跑大审查**（下次 PR6，锚 `f41c257`）；⑤ 注意 E4：简体回3/6/7 语料重拉**已拆出 PR5**，PR5 冷烟复用现有繁體前三回样本。
