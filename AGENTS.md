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

**进度**：PR1（LLM client）/ PR2（Schema+YAML+SCHEMA.md）/ PR3（Chunker+红楼梦样本）✅ **均已合并**，main 在 `083d4b6`。**下一个：PR4 StoryBible Curator**（首个 LLM agent：扫全文产人物/地点表，aliases 合并，稳定 id）。PR 路线图与进度见 `docs/PROJECT.md §6`。

**质量门禁（强制，见 `docs/PROJECT.md §8.1`）**：每 PR 必跑 `npm test`+`npx tsc --noEmit`（贴原始输出）、TDD 先红、更新 `docs/DEVLOG.md`、用户点头才 merge。冷上下文大审查（`/code-review`+`/security-review`）每 2 PR 一次——**PR4 是审查批次**，diff 基线须锚到 `dd47ed3`（覆盖 PR3+PR4，详见 §8.1）。

**PR4 起步须知**：① LLM 配置缺口——环境仅有 `DEEPSEEK_API_KEY`，无 `LLM_BASE_URL`/`LLM_MODEL`，需让配置层支持 DeepSeek（baseURL `https://api.deepseek.com`，model 待定），单测走 fixture 不烧 key；② 待议决策（样本改简体、红楼章节选择）见 `docs/PROJECT.md §6` 下方备注；③ PR4 是创意性 LLM agent，**先 brainstorming 设计再 TDD**。

**接续步骤**：① 读 `docs/PROJECT.md`（单一事实来源）+ `docs/DEVLOG.md`（开发纪实）；② `git checkout main && git pull --ff-only`；③ 找 §6 下一个未完成 PR（当前 PR4）；④ 按 §8/§8.1 开分支、TDD、跑门禁。
