# PR12 设计 spec — 402 余额耗尽友好降级 + 本地部署引导 + 正式大审查

> 状态：设计定稿（待 codex 冷读）。基线 main HEAD `8327f78`，分支 `pr12-graceful-402`。
> 范围承袭 `docs/PROJECT.md §6 PR12 行`。本 spec 只覆盖**第 1 块（402 友好降级）的工程决策**；第 2 块（README）是文案打磨、第 3 块（大审查）是流程门禁，不需要架构设计。

## 1. 背景与问题

公开 Render 站点烧的是作者自己的 LLM key。余额耗尽后，第一笔 LLM 调用（StoryBible Curator）就会收到 provider 的 **HTTP 402 + `{"error":{"message":"Insufficient Balance"}}`**。当前链路把原始报文原样抛给用户：

```
转换失败（storybible）：LLM request failed 402: {"error":{"message":"Insufficient Balance"...}}
```

对非技术评审者既难懂、又像「系统崩了」。需要识别这一特定失败、换成**友好引导**：告诉用户这是演示站额度问题，要实际体验请克隆仓库本地部署、配自己的 key。

## 2. 设计目标 / 非目标

- **目标**：① 准确识别「余额耗尽」这一类失败；② 前端展示人话引导 + 可点的 GitHub 仓库链接；③ 不破坏既有错误展示（其它失败仍显示原始 message + 重试）；④ 识别逻辑健壮、不靠下游对「已格式化的错误字符串」做脆弱二次匹配。
- **非目标**：不做余额查询/预检；不做服务端限流；不改 LLM 重试策略（402 本就非 transient，不重试，正确）。

## 3. 核心决策：结构化错误码，而非字符串匹配

PROJECT.md 推荐「把 provider 的 402 归一成结构化错误码再 emit，前端按 code 显示文案」。采纳。理由：

- HTTP 响应层（`lib/llm/client.ts`）是**唯一**同时看得到 `res.status` 和原始 body 的地方——分类应当发生在这里，是「信息最全的源头」，而不是等错误被包装成 `LLM request failed 402: ...` 字符串后在前端 regex。
- 下游（orchestrator / reducer / 组件）只透传一个稳定的 `code` 字段，零字符串猜测，未来加别的错误类型也照此扩展。

### 3.1 分类点：`lib/llm/client.ts`

新增 `LLMError`（继承 `Error`），携带 `status?: number` 与 `code?: LLMErrorCode`：

```ts
export type LLMErrorCode = "insufficient_balance";

export class LLMError extends Error {
  status?: number;
  code?: LLMErrorCode;
  constructor(message: string, opts: { status?: number; code?: LLMErrorCode } = {}) {
    super(message);
    this.name = "LLMError";
    this.status = opts.status;
    this.code = opts.code;
  }
}
```

分类函数（导出，便于单测）：

```ts
export function classifyLLMErrorCode(status: number, body: string): LLMErrorCode | undefined {
  if (status === 402) return "insufficient_balance";
  if (/insufficient\s+balance|余额不足/i.test(body)) return "insufficient_balance";
  return undefined;
}
```

- 主信号 = `status === 402`（DeepSeek 实测就是 402）。
- 兜底 = body 文案匹配，覆盖「某 provider 用 400/403 + Insufficient Balance」的可能。匹配只发生在**原始 HTTP body** 这一处源头，不是下游字符串。
- 仅在**非 transient、最终抛出**那条路径替换为 `throw new LLMError(...)`（client.ts:169 附近）。transient（408/429/5xx）不变。

辅助读取（unknown→code），给 orchestrator 用：

```ts
export function llmErrorCode(err: unknown): LLMErrorCode | undefined {
  return err instanceof LLMError ? err.code : undefined;
}
```

### 3.2 事件契约：`lib/agent/events.ts`

`error` 变体加可选 `code`：

```ts
| { type: "error"; stage: Stage; sceneId?: string; message: string; code?: string };
```

用宽松 `code?: string`（而非 import LLMErrorCode），避免 events 契约耦合 llm 层；值域语义靠约定。`eventToSSE` 是 `JSON.stringify(event)`，`code` 自动随帧过 SSE；`parseSSE` 的 `JSON.parse` 自动带回——**序列化链零改动**。

### 3.3 orchestrator 透传

storybible catch（orchestrator.ts:348）emit 时附带 code：

```ts
} catch (err) {
  emit({ type: "error", stage: "storybible", message: (err as Error).message, code: llmErrorCode(err) });
  throw err;
}
```

`code` 为 undefined 时 `JSON.stringify` 自然省略，无副作用。其余 emit 点（bible-no-locations、scene 级、pipelineToSSEStream 兜底 assemble）**本次不强加** code——余额耗尽必先撞 storybible 这第一笔 LLM 调用，是唯一会带 `insufficient_balance` 的现实路径；过度铺开反增面。（备查：若未来 scene 阶段也想友好化，同法补 code 即可。）

### 3.4 reducer 携带：`lib/client/pipelineState.ts`

`PipelineState.error` 加 `code?: string`；fatal 分支把 `event.code` 带进去（undefined 则不写键，保持既有相等断言友好）。scene 级 warning 分支不动。

### 3.5 前端展示：`app/components/ConverterApp.tsx`

`state.error.code === "insufficient_balance"` 时，渲染友好块（替换原始 message 那行，保留「重试」按钮——万一作者刚充值，重试即恢复）：

> **演示站额度已用尽** 🪫
> 本站用的是作者的 API key，额度用完了。本站仍可**浏览内置示例与界面**；要实际体验「转换」，请克隆仓库本地部署、配置你自己的 API key（一步到位，见 README「快速开始」）。
> [在 GitHub 查看部署步骤 →](https://github.com/Lupinusluv/novel-to-screenplay#快速开始本地克隆即跑)

- 文案/链接常量定义在 client 组件内（ConverterApp.tsx），**不**从 `lib/agent/*` import（守 E10 client 边界）。
- 链接锚点指向 README「快速开始」节（GitHub 自动 slug：`#快速开始本地克隆即跑`）。
- 非 `insufficient_balance` 的 error：维持现状 `转换失败（{stage}）：{message}`。

## 4. TDD 计划（先红）

1. `lib/llm/client.test.ts`：
   - 402 响应 → `client.chat` 抛 `LLMError`，`.code==="insufficient_balance"`、`.status===402`。
   - 400 + body 含「Insufficient Balance」→ code 同上（兜底）。
   - 401（普通鉴权失败）→ 抛错但 `.code===undefined`（不误报）。
   - `classifyLLMErrorCode` 纯函数单元用例。
2. `lib/client/pipelineState.test.ts`：error 事件带 `code` → `state.error.code` 透传；不带 code → 无该键。
   - `chat()` 收到 402 后**不重试**（fetchImpl 只被调一次，验证 isRetryable 对 LLMError 返回 false）。
3. `lib/agent/orchestrator.test.ts`：
   - storybible 阶段 LLM 抛 `LLMError(402)` → 捕获到的 `error` 事件 `code==="insufficient_balance"`，且 run 抛出（fatal）。
   - **scene 阶段** LLM 抛 `LLMError(402)`（storybible 成功后）→ 不产出占位/`final_result`，而是 fatal `error` 事件带 `code==="insufficient_balance"`（经 pipelineToSSEStream 兜底）。
4. `app/components/ConverterApp.test.tsx`：注入 `error`(storybible, code=insufficient_balance) → 出现「演示站额度已用尽」+ GitHub 链接（`role=link`，href 含仓库），且**不**出现原始「Insufficient Balance」报文；普通 error 仍显示原文。

## 5.5 codex 冷读增量（SCORE 6/10 → 已吸收）

跨模型冷读逮到两个 High，已并入上面的设计（本节为定稿增量，覆盖 §3.1/§3.3）：

- **【High，已改】余额耗尽不必发生在第一笔调用**：StoryBible 成功后，scene convert / critic 阶段同样会 402。当前 `tryConvert` 把非 dangling 的 throw 吞成可重试失败→占位场景→scene warning，前端永不显示 402，甚至仍产出 `final_result`。**修正**：余额耗尽是**全局资源失败**，必须从**任意 LLM 阶段升级为 fatal 并中止整条 run**——
  - `tryConvert`：捕获到 `llmErrorCode(err) === "insufficient_balance"` 时**重新抛出**（与既有 `dangling references` 同款逃逸语义），不降级为占位。
  - `processCandidate` 两处 critic try/catch：同样**仅对 insufficient_balance 重新抛出**，其它 critic 异常维持「降级 needs_review 不中断」。
  - `runPool`：捕获首个 worker 异常、**停止派发新 item、向上重抛**（顺带消除既有「一个 worker throw 后其余 worker rejection 变 unhandled」的隐患——既服务 402，也服务既有 dangling 路径）。
  - `pipelineToSSEStream` 兜底 catch：合成的 `error` 帧附带 `code: llmErrorCode(err)`，使 scene 阶段逃逸上来的 402 同样被前端按 code 友好化。
  - 收益：余额耗尽后**不再制造一堆占位场景 + 误导性 final_result**，而是干净地一条 fatal「演示站额度已用尽」。
- **【High，已改】`LLMError` 必须显式 non-retryable**：`chat()` 的 catch 用 `isRetryable()` 判定，现实现靠 message regex `/LLM request failed \d/`。改用 `LLMError` 后**保留同款 message 格式**（regex 仍命中），并**额外**在 `isRetryable` 顶部加 `if (err instanceof LLMError) return false;`——双保险，杜绝 402 被当网络错误多烧几次。
- **【Medium，记录】** `status===402 ⇒ insufficient_balance` 对 OpenAI 兼容通用语义偏粗：`LLMError` **保留原始 `status`** 便于诊断；spec/测试注明这是 **demo 友好分类**，非所有 provider 402 的完整语义。body 兜底 regex 作用于**原始 HTTP body**（nested JSON `{"error":{"message":"Insufficient Balance"}}` 的子串也命中），非下游二次匹配。
- **Medium「warning 分支丢 code」/「scene 级如何终止」**：因上面把 insufficient_balance **升级为 fatal、永不走 warning 分支**，这两点自然消解——warning 分支保持不动。

## 5. 风险 / 权衡

- **误报**：402 偶尔被某些网关用作别的语义？现实中 402 Payment Required 几乎专用于计费，且 demo 用 DeepSeek 实测就是余额 402，风险极低；body 兜底匹配进一步对齐语义。
- **过度工程**：只为一个错误码引入 LLMError 类是否过重？——这是**可扩展点**而非一次性 hack；且类承载 status 对未来诊断有用。可接受。
- **E10 边界**：events.ts 在 `lib/agent/` 但本是契约层，reducer 既有就 `import type` 它，加字段不违边界；文案常量留在组件内。
