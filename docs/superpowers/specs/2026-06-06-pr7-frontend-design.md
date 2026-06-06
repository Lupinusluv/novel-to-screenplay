# PR7 前端核心设计 spec — 输入 / 实时 agent 时间线 / 剧本卡片 + YAML / 导出

> gstack `/gstack-spec` 五段产物。设计阶段走 gstack(不叠 superpowers brainstorming，AGENTS.md 约定）。
> 实现阶段交 superpowers TDD。状态：**草案待 codex 冷读 + 用户确认**（§11 待填权威增量）。
> 基线：main `69ff533`（PR6 合并点），分支 `pr7-frontend`。门禁：每-PR 轻量档（test+tsc+TDD 先红+DEVLOG+用户点头），**不跑大审查**（下次 PR8 锚 `69ff533`）。

---

## 0. 锁定的设计决策（本会话拍板）

| # | 决策 | 选定 | 理由 |
|---|---|---|---|
| **D1** | PR7 是否含实时 agent 进度时间线 | **含（完整纵切）** | 没有实时反馈的 PR7 既是糟糕 UX（点转换后空白等 ~40s），又让流式后端失去意义；AGENTS.md（高优先级、为 PR7 更新）明确把时间线折进 PR7 作 demo 主轴。PR8 只剩打磨。 |
| **D2** | 剧本是否可编辑 | **只读 + 导出** | 卡片只读、YAML 只读切换、导出 `.yaml`（用 `final_result` 原样产物）。编辑（卡片内联或 YAML 文本框回灌）留作 PR8/后续，避免挤占 PR7 工期与测试面。 |
| **D3** | 内置示例如何送达浏览器 | **新增 GET 路由处理器** | `samples/` 不在 `public/` 下，前端无法直接 fetch。加 `app/api/sample/route.ts`（fs 读，懒加载），样本单一来源、不进首屏 bundle、不重复，与现有 `app/api/convert` 路由风格一致。 |
| **D4** | 前端 TDD「先红」测什么 | **加组件测试栈** | 装 `@testing-library/react` + `@testing-library/jest-dom` + `jsdom` + `@vitejs/plugin-react`，扩 vitest 配置；纯逻辑（SSE 解析 + 状态 reducer）仍抽出在 node 环境单测，组件渲染另在 jsdom 环境测。覆盖面更全、面试工程信号更强。 |

---

## 1. Context（为什么）

**谁**：求职面试评审；以及操作内置示例的「作者」用户。Solo 演示作品。

**现状**：`app/page.tsx` 仍是 create-next-app 脚手架默认页（`F:\...\app\page.tsx:1-65`，Next/Vercel logo + 模板链接）。后端 agent 流水线 PR1–PR6 全部合并、端到端跑通：`POST /api/convert`（`app/api/convert/route.ts`）接 `{novel, options?}`，以 SSE typed 帧流式推送 `PipelineEvent`，末帧 `final_result` 带完整 `Screenplay` + YAML 文本。**但没有任何前端消费它**——demo 的唯一缺口。

**应为**：用户粘贴/上传/选内置示例 → 点转换 → **实时看 agent 流水线干活（时间线点亮）** → 得到结构化剧本（卡片视图 + YAML 源码切换）→ 导出 `.yaml`。

**为什么现在**：后端全绿，前端是 demo 表达（评审 20%）与完整度（40%）的唯一缺口。

**完成判据**（可观测）：
1. 选内置示例 → 点转换 → 能跑出完整剧本（真 LLM 下 `DEEPSEEK_API_KEY` 已在环境）。
2. SSE 的 6 类事件被正确解析（含跨 chunk 半帧、乱序 `partial_result`）。
3. 时间线随事件点亮 4 个 stage + `scenes` 阶段的 done/total 进度。
4. 卡片视图流式出现场景；可切 YAML 源码视图；可导出 `.yaml`。
5. `npm test`（含新增前端测试）全绿、`npx tsc --noEmit` 干净、`npm run lint` 干净。

---

## 2. 已核实的后端契约（grounded，写代码前的事实地基）

### 2.1 SSE 事件契约（`lib/agent/events.ts:10-24`）

```ts
type Stage = "chunk" | "storybible" | "scenes" | "assemble";

type PipelineEvent =
  | { type: "stage_start"; stage: Stage; total?: number }
  | { type: "stage_progress"; stage: Stage; done: number; total: number; sceneId?: string }
  | { type: "partial_result"; scene: Scene }          // per-scene, 完成顺序（可乱序）
  | { type: "stage_done"; stage: Stage }
  | { type: "final_result"; screenplay: Screenplay; yaml: string }  // 末帧，权威
  | { type: "error"; stage: Stage; sceneId?: string; message: string };
```

### 2.2 帧编码（`lib/agent/sse.ts:11-13`）

```ts
function eventToSSE(event: PipelineEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
```

- 每帧 = `event: <type>\n` + `data: <一行 JSON>\n` + `\n`（空行终止）。
- `data:` 是完整事件对象（含 `type`），`event:` 行冗余但存在。
- 多行 message 被 `JSON.stringify` 转义留在单行 `data:` 上（`sse.test.ts:17-29` 已验证）。

### 2.3 路由行为（`app/api/convert/route.ts`）

- `POST /api/convert`，body `{novel: string, options?: OrchestratorOptions}`。
- 前置错误（**在流之前**，是 `Response.json` 不是 SSE 帧）：
  - **400** body 非 JSON，或 `novel` 非非空字符串。
  - **413** `novel.length > MAX_NOVEL_CHARS`（200000，`orchestrator.ts:71`）。
  - **500** LLM 配置错（`loadLLMConfigFromEnv` 抛错）。
- 成功 → `Content-Type: text/event-stream`，`req.signal` 转发（客户端断开即取消）。
- **`POST` 不能用原生 `EventSource`（只支持 GET）** → 必须 `fetch` + `res.body.getReader()` + `TextDecoder` 手动按 `\n\n` 切帧。这是被迫的技术事实。

### 2.4 数据模型（`lib/schema/screenplay.ts`）

`Screenplay = { title, logline, characters[], locations[], scenes[] }`；
`Scene = { id, heading{int_ext, location_id, time_of_day}, synopsis, source{chapter, excerpt}, elements[], needs_review? }`；
`Element = action{text} | dialogue{character_id, parenthetical?, line} | transition{text}`（判别联合，`type` 字段）。
导出用 `final_result.yaml`（后端已产出，无需前端再序列化）。

### 2.5 时间线的角色映射（§4「剧组」→ 4 个可观测 stage）

SSE 只暴露 4 stage；Validator/Critic/Converter 的自纠循环发生在 `scenes` 阶段**内部**，前端只能从 `stage_progress{done,total}` + `partial_result` 观测逐场景进度。映射：

| SSE stage | 时间线展示（§4 剧组角色） | 可观测信号 |
|---|---|---|
| `chunk` | 场记（Chunker）分章 / 切场景 | stage_start → stage_done |
| `storybible` | 设定集（StoryBible Curator）抽人物/地点圣经 | stage_start → stage_done |
| `scenes` | 场景编剧 + 格式审校 + 责编（Converter/Validator/Critic 自纠环） | stage_start{total} → 多个 stage_progress{done,total,sceneId} + partial_result → stage_done |
| `assemble` | 导演（Orchestrator）汇编 | stage_start → stage_done |

---

## 3. Proposed Change（做什么）

### 3.1 布局（§3 三区：左输入 / 右剧本 / agent 时间线）

- **顶部**：标题 +「AI 小说转剧本」一句话副标。
- **空闲态（转换前）**：居中 **输入面板**。
- **运行/完成态**：两栏——
  - 左栏（sticky）：**Agent 进度时间线**（demo 主轴，重点可视）。
  - 右栏：**剧本视图**（卡片 / YAML 标签切换 + 导出按钮）。
- 移动端：单列堆叠（时间线在上、剧本在下）。

> 布局是 taste call，实现时可微调；以上为基线。

### 3.2 客户端纯逻辑（抽出在 `lib/`，node 环境单测——TDD 先红主战场）

**A. SSE 帧解析器 `lib/sse/parseSSE.ts`**（纯、有状态缓冲；只 `import type`，不碰 DOM/fs）：
```ts
class SSEProtocolError extends Error {}              // E6：typed 协议错
class SSEFrameParser {
  // feed(text: string): PipelineEvent[]  —— 喂【已解码的字符串】，吐已完整的事件
  // 内部 buffer 累积，循环切出以 \n\n 结尾的帧；半帧留 buffer 等下个 chunk
  // 每帧取 data: 行 → JSON.parse → 作为 PipelineEvent 返回（type 来自 data 自身）
  // 坏 JSON / 空 data / 缺 data 行 → throw SSEProtocolError（E6，不静默跳过）
}
```
容错点（单测覆盖）：① 一个 JSON 被拆在两个 chunk（经典 bug）；② 一个 chunk 含多帧；③ CRLF vs LF；④ 末尾无终止符的残帧不误吐；⑤ 坏 JSON / 空 data → 抛 `SSEProtocolError`（E6）。
> 字节边界由 §3.2C 的 `TextDecoder` 负责（parser 只见字符串）；多字节中文拆 chunk 的测试落在 sseClient（E5）。

**B. 事件→UI 状态 reducer `lib/client/pipelineState.ts`**（纯函数）：
```ts
type StageView = { status: "pending" | "active" | "done" | "error"; done?: number; total?: number };
interface PipelineState {
  status: "idle" | "running" | "done" | "error";
  stages: Record<Stage, StageView>;          // 4 stage 初始 pending
  scenes: Scene[];                            // partial_result 累积（按 id 去重）
  screenplay?: Screenplay;                    // final_result 权威覆盖
  yaml?: string;
  error?: { stage: Stage; sceneId?: string; message: string };
}
function pipelineReducer(state, event: PipelineEvent): PipelineState;
```
规则（单测覆盖）：
- `stage_start`→active(+total)；`stage_progress`→更新 done/total。
- `partial_result`→按 `scene.id` upsert（**乱序到达**也稳定）。**显示按到达顺序或自然数序**（id 形如 `scene_1_10`/`scene_1_2`，禁字典序——E2）；最终以 `final_result.screenplay.scenes` 为权威。
- `stage_done`→done。
- `final_result`→`screenplay`+`yaml`，`scenes` 以 `screenplay.scenes` 权威覆盖，`status="done"`（即使此前有 scene 级 error）。
- `error`（**E1 两类**）：① stage===`scenes` 且带 `sceneId` = **scene 级 warning**，只记到对应场景/横幅、**不杀全局**（后端会继续）；② 其余（无 `sceneId`，或 `chunk`/`storybible`/`assemble` 阶段，或流断未见 `final_result`）= **fatal**，`status="error"` + 该 stage 标 error。

**C. fetch 流式客户端 `lib/client/sseClient.ts`**（只 `import type`，不碰 fs/env）：
```ts
// runConversion(novel, options, { onEvent, signal }): Promise<void>
// POST /api/convert
// 失败面统一收敛成一条 error 事件回调（E3）：非 2xx 读 {error}、fetch reject、
//   res.body===null、reader.read() 抛错、SSEProtocolError、流断未见 final_result。
//   唯独 AbortError（用户取消）→ 静默结束、回 idle，不报失败。
// 解码：const dec = new TextDecoder("utf-8")；reader 读 Uint8Array →
//   dec.decode(value, {stream:true}) 喂 parser；循环结束 dec.decode() flush 残字节（E5）。
// 每个事件 onEvent()。
```
**E4 并发隔离**：`ConverterApp` 每次开转换生成 `runId` + 新 `AbortController`，**开新任务先 abort 旧的**；`onEvent` 只接受当前 `runId` 的事件，旧 stream 的 late event 丢弃。运行态暴露「取消」按钮调 abort（demo 安全阀）。

> 纯逻辑放 `lib/` 下 → 现有 `vitest.config.ts` 的 `include: lib/**/*.test.ts` 直接覆盖，零配置改动即可 TDD 先红。

### 3.3 React 组件（`app/components/`，`"use client"`）

| 组件 | 职责 | 关键点 |
|---|---|---|
| `app/page.tsx` | 服务端薄壳，渲染 `<ConverterApp/>` | 替换脚手架默认页 |
| `app/components/ConverterApp.tsx` | 客户端编排：持 `PipelineState`、调 `runConversion`、`useReducer(pipelineReducer)` | 唯一持流逻辑处 |
| `app/components/InputPanel.tsx` | 粘贴 textarea / 上传 .txt（FileReader 客户端读）/「用内置示例」（fetch `GET /api/sample`）/「转换」按钮 | 空文本禁用转换；显示字数 + 200000 上限提示 |
| `app/components/AgentTimeline.tsx` | 4 stage 列表随 state 点亮；`scenes` 阶段显示 done/total 进度条 | 映射 §4 剧组角色名 |
| `app/components/ScreenplayView.tsx` | 标签容器：卡片视图 / YAML 源码 + 导出按钮 | title/logline/characters/locations 来自 `screenplay` |
| `app/components/SceneCard.tsx` | 单场景：heading(INT/EXT·地点·日夜) + synopsis + elements 有序流 + `source.chapter` + `needs_review` 角标 | 只读；溯源弹层留 PR8 |
| `app/components/YamlView.tsx` | 只读 `<pre>` 渲染 `yaml` | 只读（D2） |
| `app/components/ExportButton.tsx` | 把 `yaml` 作 Blob 下载为 `<title>.yaml` | `URL.createObjectURL`；文件名取 `screenplay.title \|\| "screenplay"` |

### 3.4 内置示例路由 `app/api/sample/route.ts`（D3）

```ts
export const runtime = "nodejs";        // fs 需要
export const dynamic = "force-dynamic"; // 请求时读盘，不预渲染
export async function GET(): Promise<Response> {
  // path.join(process.cwd(), "samples", "honglou-meng-ch1-3.txt")（E12，别用相对路径）
  // 读成功 → new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" }})
  // 读失败 → Response.json({ error }, { status: 500 })（样本失败别静默砸首屏）
}
```

### 3.5 测试栈接入（D4）

- 新增 devDeps：`@testing-library/react`、`@testing-library/dom`（E8 显式）、`@testing-library/jest-dom`、`jsdom`、`@vitejs/plugin-react`、`vite-tsconfig-paths`（E7，解析 `tsconfig` 的 `@/*` 别名）。
- `vitest.config.ts`：`plugins: [react(), tsconfigPaths()]`；默认 `environment: "node"` 不变；组件测试文件顶部 docblock `// @vitest-environment jsdom` 切 jsdom（lib 单测仍 node，互不干扰）；`include` 扩到 `app/**/*.test.tsx`；`setupFiles: ["./vitest.setup.ts"]`。
- `vitest.setup.ts`：`import "@testing-library/jest-dom/vitest"`（E8，vitest 入口非裸 `/jest-dom`）。
- **E9**：实现前看一眼现有 `lib/**/*.test.ts` 的 `globals` 习惯——若未开 globals，组件/单测显式 `import { describe, it, expect, vi } from "vitest"`，并确保 TS 识别 jest-dom matcher。

---

## 4. Acceptance Criteria（可测，pass/fail）

1. `SSEFrameParser.feed` 对「一个 `final_result` 帧被切成两个 chunk」能正确重组为 1 个事件；对「一个 chunk 含 3 帧」吐出 3 个事件；残帧不误吐；坏 JSON/空 data 抛 `SSEProtocolError`（E6）。
2. `sseClient` 对「UTF-8 多字节中文在字节边界被拆成两个 `Uint8Array`」用 `TextDecoder(stream:true)` 正确重组、流末 flush 无残字节（E5）。
3. `pipelineReducer` 对乱序到达的 `partial_result`（`scene_1_10` 先于 `scene_1_2`）按 id upsert，最终 `scenes` 无重复、按**自然数序**有序（禁字典序，E2）。
4. `pipelineReducer` 收 `final_result` 后 `status==="done"`、`screenplay`/`yaml` 就位，`scenes` 等于 `screenplay.scenes`（即使此前有 scene 级 error）。
5. `pipelineReducer` 收 **scene 级 error**（`scenes`+`sceneId`）不杀全局（status 仍 running/done）；收 **fatal error** 才 `status==="error"` + 该 stage 标 error（E1）。
6. `runConversion` 把 413/400/500、fetch reject、`body===null`、reader 抛错、`SSEProtocolError`、流断未见 final 都收敛成 1 条 `error` 事件；**`AbortError`（取消）静默回 idle、不报失败**（E3）。
7. `ConverterApp`：连续两次转换时旧 run 被 abort，旧 stream 的 late event 不污染新状态（`runId` 隔离，E4）。
8. `<InputPanel>`：空 textarea 时「转换」禁用；输入非空后启用；点「用内置示例」后 textarea 填入 fetch 到的文本（mock fetch）。
9. `<AgentTimeline>`：给定 `scenes` 阶段 active、done=3/total=9 的 state，渲染出该 stage active 态 + "3/9"。
10. `<SceneCard>`：渲染 dialogue 的 `character_id`/`line`、action 的 `text`、`needs_review` 为真时出现角标。
11. `<ExportButton>`：点击触发一次下载（`URL.createObjectURL` 被调用）；文件名 sanitize Windows 非法字符 `/ \ : * ? " < > |` + 首尾空白，以 `.yaml` 结尾（E13）。
12. 运行态有「取消」按钮，点击 abort 当前 run、回 idle（demo 安全阀）。
13. `app/page.tsx` 不再含脚手架文案（无 `next.svg`/"edit the page.tsx"）。
14. `npm test` 全绿（新增前端测试 + 既有 162 passed 不回归）、`npx tsc --noEmit` 干净、`npm run lint` 干净。
15. **实跑（E11，demo 主轴）**：Chrome dev server 选示例→转换，Network 面板确认 SSE chunk 逐步到达 + 时间线 UI 逐步点亮（非一次性刷出）；卡片流式出现、可切 YAML、可导出。

---

## 5. Testing Plan

| 层 | 测什么 | 环境 | 约计 |
|---|---|---|---|
| Unit | `SSEFrameParser`（跨 chunk/多帧/CRLF/残帧/坏 JSON 抛 typed 错） | node | +6 |
| Unit | `sseClient`（多字节中文跨字节边界 + flush；非 2xx/reject/null/reader 错→error；AbortError 静默；runId 隔离） | node | +5 |
| Unit | `pipelineReducer`（6 类事件 + 自然数序乱序 + final 权威 + scene/fatal error 二分） | node | +8 |
| Unit | 文件名 sanitize（Windows 非法字符） | node | +2 |
| Component | InputPanel / AgentTimeline / SceneCard / ScreenplayView 切换 / ExportButton / 取消按钮 | jsdom | +7 |
| 实跑 | **Chrome dev server**（E11）：Network 确认 SSE chunk 逐步到达 + 时间线逐步点亮；选示例→转换→卡片→YAML→导出（`LLM_SMOKE` 真跑或 mock 路由）；playwright MCP 可半自动 | 浏览器 | 手动/半自动 |

---

## 6. Out of Scope（PR7 不做，划清边界）

- **编辑能力**（卡片内联编辑 / YAML 文本框回灌校验）→ PR8 或后续（D2）。
- **场景溯源弹层 / 跳回原文**交互 → PR8（§6 路线图）。PR7 卡片仅**只读**显示 `source.chapter` + `excerpt`。
- **空/错状态的视觉打磨**（精致空态插画、重试 UX）→ PR8。PR7 只做**功能性**错误兜底（非 2xx 提示 + error 帧入时间线/横幅）。
- README + demo 录制脚本 → PR8。
- 用户账号 / 数据库 / PDF/Fountain 导出 / 多语言 / 实时协同 → 项目级 YAGNI 非目标。
- 内置示例语料的繁→简重拉与回 3/6/7 替换：当前样本仍是繁體前三回；**这是内容问题，非 PR7 前端 scope**（PROJECT.md §6 样本决策，按需另处理；本 PR 用现有样本）。

## 7. Files Reference

| 文件 | 变更 |
|---|---|
| `app/page.tsx` | 替换脚手架默认页为服务端薄壳 → `<ConverterApp/>` |
| `app/components/ConverterApp.tsx` | 新增：客户端编排（useReducer + runConversion） |
| `app/components/InputPanel.tsx` | 新增：粘贴/上传/示例/转换 |
| `app/components/AgentTimeline.tsx` | 新增：4 stage 时间线 + scenes 进度 |
| `app/components/ScreenplayView.tsx` | 新增：卡片/YAML 标签 + 导出 |
| `app/components/SceneCard.tsx` | 新增：单场景只读卡片 |
| `app/components/YamlView.tsx` | 新增：只读 YAML `<pre>` |
| `app/components/ExportButton.tsx` | 新增：Blob 下载 .yaml |
| `app/api/sample/route.ts` | 新增：GET 读 samples 文件 |
| `lib/sse/parseSSE.ts` (+`.test.ts`) | 新增：SSE 帧解析器（纯） |
| `lib/client/pipelineState.ts` (+`.test.ts`) | 新增：事件→UI 状态 reducer（纯） |
| `lib/client/sseClient.ts` (+`.test.ts`) | 新增：fetch 流式客户端 |
| `app/components/*.test.tsx` | 新增：组件渲染测试（jsdom） |
| `vitest.config.ts` | 加 `react()`+`tsconfigPaths()` 插件 + `app/**/*.test.tsx` include + setupFiles |
| `vitest.setup.ts` | 新增：`import "@testing-library/jest-dom/vitest"` |
| `package.json` | +6 devDeps：`@testing-library/react`·`@testing-library/dom`·`@testing-library/jest-dom`·`jsdom`·`@vitejs/plugin-react`·`vite-tsconfig-paths` |

## 8. Effort Estimate（CC 尺度）

纯逻辑（parser+reducer+client）+ 单测 ~15min；测试栈接入 ~5min；组件 + 组件测试 ~15min；sample 路由 ~3min；page 接线 + 样式 ~10min；实跑联调 ~10min。合计 ~1 个工作会话。

## 9. Rollback Plan

纯增量（新文件 + 替换脚手架 page + 改 vitest 配置/加 devDeps）。回滚 = 还原 `app/page.tsx`、删 `app/components/*`、`lib/sse`、`lib/client`、撤 `vitest.config.ts`/`package.json` 改动。不触碰后端 `lib/agent/*`、`app/api/convert`、schema——零后端风险。

## 10. 实现前置（Next 16 红字约定）

- 写前端前先读 `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`、`15-route-handlers.md`（后者已读：GET 导出 + Web `Response`，标准）。
- `"use client"` 只标真正的 client boundary（交互组件 + ConverterApp）；page.tsx 保持服务端壳。**E10 纪律**：`lib/sse/*`、`lib/client/*` 只 `import type` from `schema`/`events`，严禁 import `lib/agent/*` 运行时或 fs/env，否则服务端代码被拖进客户端 bundle。
- 流式只能 `fetch`+`getReader`（POST 无 EventSource）。

## 11. 权威增量（codex 冷读 gpt-5.5，SCORE 7/10 → 收紧）

codex 冷读 read-only 沙箱核对了 spec + `events.ts`/`sse.ts`/`route.ts`/`screenplay.ts`，逮到 13 条盲点，全部采纳并落进上文相关章节 + 验收：

- **E1 — `error` 帧分两类，不可无条件置全局 error。** `orchestrator.ts` 的 `processCandidate` 在 `scenes` 阶段发带 `sceneId` 的 `error` 后会**返回 placeholder scene 并继续** `partial_result`/`stage_progress`/`final_result`。reducer 须区分:**scene 级 warning**(stage===`scenes` 且有 `sceneId`)只记到对应场景/横幅、不杀全局；**fatal stream error**(无 `sceneId`，或 `chunk`/`storybible`/`assemble` 阶段，或流未收到 `final_result` 即断)才 `status="error"`。`final_result` 一律权威覆盖为 `done`。（改 §3.2B、§4.4）
- **E2 — 场景排序用自然数序，禁字典序。** id 形如 `scene_${chapter}_${index}`，字典序会把 `scene_1_10` 排到 `scene_1_2` 前。流式展示按**到达顺序**或自然数序;最终以 `final_result.screenplay.scenes` 为权威。（改 §3.2B、§4.2）
- **E3 — `runConversion` 把所有失败面收敛成 UI error，唯独取消不算失败。** 明确:`fetch` reject、`res.body===null`、reader read 抛错、流内 `error` 帧、JSON 解析失败 → 合成 UI error;**`AbortError`(用户取消)→ 静默回 idle，不显示失败**。（改 §3.2C、§4.5）
- **E4 — 并发转换要 `runId` 隔离。** 用户连点转换/选示例后再转，旧 stream 的 late event 会污染新 reducer。开新任务**先 abort 旧 `AbortController`**，reducer/回调忽略非当前 `runId` 的事件。（改 §3.2C、新增取消按钮）
- **E5 — UTF-8 多字节中文跨 chunk 必测。** `sseClient` 持 `TextDecoder("utf-8")`，对 `reader` 的 `Uint8Array` 用 `decode(value, {stream:true})`，流末 `decode()` flush 残字节;解码后的字符串才喂 `SSEFrameParser.feed`。验收必须覆盖「中文/YAML 在字节边界被拆」否则 demo 文本损坏。（改 §3.2A/C、§4.1）
- **E6 — parser 对坏 JSON/空 data 抛 typed 协议错。** `SSEFrameParser` 遇无法解析的帧 throw 一个 typed `SSEProtocolError`，由 `runConversion` 统一转 UI error;不静默跳过(否则丢事件难查)。（改 §3.2A）
- **E7 — vitest 要 `vite-tsconfig-paths`。** `tsconfig.json` 有 `"@/*": ["./*"]` 别名;组件测试若用 `@/` 导入，Vitest 下不加该插件会炸。devDeps 补 `vite-tsconfig-paths`，`vitest.config.ts` 加进 `plugins`。（改 §3.5、§7）
- **E8 — devDeps 补 `@testing-library/dom`，jest-dom 用 vitest 入口。** testing-library 生态把 `@testing-library/dom` 作显式 dep;setup 写 `import "@testing-library/jest-dom/vitest"`(非裸 `/jest-dom`)以稳住 Vitest matcher 类型与运行时。（改 §3.5、§7）
- **E9 — globals 策略与现有 lib 测试对齐。** 实现前看一眼现有 `lib/**/*.test.ts` 是否已开 `globals`(决定组件/单测要不要显式 `import {describe,it,expect,vi} from "vitest"`);`vitest.setup.ts` 必须被 `setupFiles` include 且 TS 能识别 jest-dom matcher。（改 §3.5）
- **E10 — client 边界纪律。** `"use client"` 只标真正的 client boundary 文件;`lib/sse/*`、`lib/client/*` **只能 `import type` from `schema`/`events`，严禁 import `lib/agent/*` 运行时或 fs/env**(否则把服务端代码拖进客户端 bundle)。（改 §3.3、§10）
- **E11 — 真浏览器流式验收(demo 主轴硬约束)。** WebKit 可能缓冲 <1024 字节、代理/压缩也缓冲;时间线「实时点亮」必须在 Chrome dev server 用 Network 面板确认 chunk 逐步到达 + UI 逐步更新，不能只靠单测。（改 §4 实跑行、§5）
- **E12 — sample 路由硬化。** `path.join(process.cwd(), "samples", "...")`、读失败回 500 + 错误体、`Content-Type: text/plain; charset=utf-8`、`runtime="nodejs"` + `dynamic` 行为;样本加载失败直接砸首屏 demo。（改 §3.4）
- **E13 — 导出文件名 sanitize Windows 非法字符。** 中文标题可留，但 `/ \\ : * ? " < > |` 与首尾空白必须替换/裁剪，否则下载文件名在部分浏览器/系统异常。（改 §3.3、§4.9）

> **新增取消按钮(E3/E4 + codex 末条)**:后端 `route.ts` 已转发 `req.signal`，前端运行态给一个「取消」按钮(abort 当前 run)——既是 E4 并发隔离的复用，也是 demo 安全阀。验收 §4 加一条。
