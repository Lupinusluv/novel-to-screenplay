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

**进度**：PR1（LLM client）/ PR2（Schema+YAML+SCHEMA.md）/ PR3（Chunker+红楼梦样本）/ PR4（StoryBible Curator：首个 LLM agent，map-reduce 产人物/地点表，aliases 合并，稳定 id + provenance）/ **PR5（Scene Converter：单候选→单 `Scene`，LLM 只说名字、代码权威解析 name→id，评审增量 E1–E6/I1–I11 全落地）** ✅ **均已合并**，main 在 **`42454b7`**（Merge PR #7）。**PR6 Validator + Critic + Orchestrator + SSE：设计（gstack-spec + codex 冷读 §11 E1–E14）+ TDD 实现全部完成、每-PR 门禁通过。分支 `pr6-validator-critic-orchestrator`（基于 main `42454b7`，未推 origin）。下一步 = 大审查批次（`/code-review`+`/security-review` 冷读 `git diff f41c257...HEAD` 覆盖 PR5+PR6）→ 用户点头 → push+PR+merge。** 四组件 `validator.ts`/`critic.ts`/`orchestrator.ts`（+ `events.ts`/`sse.ts`）+ `app/api/convert/route.ts` + `sceneConverter.ts` 加 revision 参数（D1）。`npm test`=**157 passed | 3 skipped**、`tsc` 干净、`lint` 干净、`LLM_SMOKE=1` 真端到端冒烟通过（≈48s）。** PR 路线图见 `docs/PROJECT.md §6`，PR5 实现纪实见 `docs/DEVLOG.md` PR5 节、spec `docs/superpowers/specs/2026-06-06-pr5-scene-converter-design.md`（§11 权威增量）。

**质量门禁（强制，见 `docs/PROJECT.md §8.1`）**：每 PR 必跑 `npm test`+`npx tsc --noEmit`（贴原始输出）、TDD 先红、更新 `docs/DEVLOG.md`、用户点头才 merge。冷上下文大审查（`/code-review`+`/security-review`）每 2 PR 一次——**PR4 已审过；本次 PR6 就是审查批次**，diff 基线锚到 PR4 合并点 `f41c257`（即 `git diff f41c257...<pr6-head>`，覆盖 PR5+PR6 两批改动；直接用 `main...` 会漏掉已并入 main 的 PR5）。大审查在 PR6 的 `pr create` 之前跑。

**接续步骤（PR6 设计进行中）**：① 读 `docs/PROJECT.md §10`（当前状态快照 + 接续步骤）+ `docs/DEVLOG.md`（PR4/PR5 纪实，了解地基）；② **`git checkout pr6-validator-critic-orchestrator`**（基于 main `42454b7`）；③ 继续 PR6 设计（gstack spec / 工程评审 / codex 冷读），spec 落 `docs/superpowers/specs/`；④ 设计定稿 → TDD 实现 `validator.ts` / `critic.ts` / `orchestrator.ts` + `app/api/convert/route.ts`（SSE）；⑤ **PR6 是大审查批次**：`pr create` 前跑 `/code-review`+`/security-review`，diff 基线锚 `f41c257`（`git diff f41c257...HEAD`，覆盖 PR5+PR6）；⑥ 门禁过 + 用户点头 → 走 §8 PR 流程 merge。

**PR6 地基事实（备查）**：① 数据流见 §4 self-correction 闭环——Orchestrator 编排 Chunker→StoryBible→逐场景(SceneConverter→Validator→Critic 重试) 闭环，重试预算每场景各默认 2 次、超限打 `needs_review` 不阻塞；② 复用已合并组件：`chunker.ts`（分章/分场景候选）、`storyBible.ts`（稳定 id + provenance）、`sceneConverter.ts`（单候选→Scene，已含 issues 二分 + `checkReferentialIntegrity`）；③ `validator.ts` 确定性 = zod + 引用完整性，`critic.ts` 是第二个纯 LLM agent（语义自评，回灌 Converter 重试），二者目录均在 `lib/agent/`；④ SSE 事件契约 `stage_start/stage_progress/partial_result/stage_done/error`（§3）；⑤ LLM 配置就绪——`loadLLMConfigFromEnv` 三者全缺回退 DeepSeek，单测走 fixture、真冒烟 `LLM_SMOKE=1` opt-in（默认 skip）。
