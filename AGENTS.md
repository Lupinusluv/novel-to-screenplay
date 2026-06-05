<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 项目协作约定

本项目架构和规划相关内容优先使用 gstack skill，避免和 superpowers skill 发生冲突；而具体开发相关优先采用 superpowers skill。

# 项目状态与约定（每个会话先读，/clear 后据此接续）

**这是什么**：AI 小说转剧本工具（≥3 章小说 → agent 流水线 → 结构化可编辑 YAML 影视剧本）。求职面试 vibe coding 作品。**完整设计/进度/接续指引见 `docs/PROJECT.md`（单一事实来源）。**

**技术栈**：Next.js 16 + React 19 + TS + Tailwind 4 全栈；LLM 走 `lib/llm/client.ts`（OpenAI 兼容，可配）；zod + yaml + vitest。

**命令**：`npm test`（vitest）、`npx tsc --noEmit`（类型检查，必跑）、`npm run dev`。

**Git/PR 工作流**：branch-per-PR，`main` 为集成主干。仓库 `github.com/Lupinusluv/novel-to-screenplay`（private）。`gh` 全路径 `"C:\Program Files\GitHub CLI\gh.exe"`（工具 shell PATH 未刷新）。流程见 `docs/PROJECT.md §8`。

**进度**：PR1 ✅ 已合并（LLM client + 测试基建 + 配置）。**下一个：PR2**（Schema + YAML 序列化 + docs/SCHEMA.md）。PR 路线图见 `docs/PROJECT.md §6`，完成后更新其进度勾选。

**接续步骤**：① 读 `docs/PROJECT.md`；② `git checkout main && git pull --ff-only`；③ 找 §6 下一个未完成 PR；④ 按 §8 开分支，TDD 开发。
