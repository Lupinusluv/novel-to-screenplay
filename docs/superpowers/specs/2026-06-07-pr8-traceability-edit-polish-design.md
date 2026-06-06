# PR8 设计 spec — 最后阶段打磨：溯源 + YAML 回灌编辑 + 空/错态

> 状态：设计完成，待 codex 冷读 + TDD 实现。
> 分支：`pr8-traceability-polish`（基于 main `5d726af`）。
> 大审查节点：PR8 = `/code-review`+`/security-review` 锚 `69ff533`（覆盖 PR7+PR8）。
> demo / README 已拆到 PR9（本 PR 不含）。

---

## 1. Context（为什么 / 谁在乎）

PR1–PR7 已让全栈端到端跑通：小说 → chunk → StoryBible → 逐场景转换 → SSE → 前端**只读**时间线 + 卡片/YAML + 导出。但「只读」漏掉了产品价值闭环里最关键的两块：

- **信任**：作者凭什么相信 LLM 没幻觉？需要把每个场景**钉回原文**（schema 早已留了 `source:{chapter,excerpt}`，前端还没用）。
- **可编辑**：产品一句话是「结构化、**可编辑**、可溯源」。只读等于半成品。

谁在乎：① 终端作者——溯源建立信任、编辑让初稿可打磨落地；② 评审——「完整度与创新 40%」直接看这两个闭环，demo 脚本第 4（编辑导出）、第 5（溯源跳原文）步全靠 PR8。

为什么现在：后端契约 + 前端只读骨架都已稳定（209 passed），此刻补溯源/编辑是纯前端增量，风险最低、价值最高。

---

## 2. 范围（用户已拍板）

三件事，全部纳入（D1/D2/D3 = A/A/A）：

1. **场景溯源弹层 + 只读原文高亮面板**（D1=A）：SceneCard 加「溯源」入口 → 弹层显示章号 + excerpt（始终可见，兜底），并能在只读原文视图里 `<mark>` 高亮并滚动到匹配段落。
2. **YAML 回灌编辑**（D2=A）：YamlView 变可编辑 → 「应用」→ `fromYAML` 解析+zod 校验 → 通过则回灌为 `edited` 剧本，**同时驱动卡片视图 + YAML + 导出**；校验失败内联报错且**不破坏现有状态**；引用未命中（referential）应用但出非致命警告；重新转换重置。
3. **空/错状态视觉打磨**（D3=A）：枚举全部空/错/待复核态并统一视觉，顺手补 `busy={inFlight}` 防重复提交。

### Out of scope（明确不做，留 PR9 或永不做）

- **demo 录屏脚本 + README**（拆到 PR9）。
- **卡片内联编辑**（编辑只走 YAML 回灌这一条路；用户已定 D2=A 的实现路线为 YAML 回灌）。
- PDF / Fountain 导出、账号/数据库、实时协同（项目级 YAGNI）。
- 改动任何 `lib/agent/*` 后端 / SSE 契约 / schema —— PR8 是纯前端 + 前端纯逻辑（`lib/client/*`）增量。

---

## 3. 验证过的当前状态（Verified，2026-06-07）

| 事实 | 出处 | 对设计的影响 |
|---|---|---|
| `scene.source = { chapter:number, excerpt:string }` | `lib/schema/screenplay.ts:96-100` | 溯源只有章号 + 摘录字符串，无字符偏移/行号 → 需运行时在原文里定位 |
| `excerpt = excerptOf(candidate.text)`，是原文真实切片的 head（≤120 字 + `…`），**绝不来自 LLM** | `lib/agent/sceneConverter.ts:384-388,415` | excerpt 可在原文中定位（不是 LLM 改写） |
| chunker 在段内**丢弃单个空行**（`blankRun<2` 的空行 `continue` 不入 current） | `lib/agent/chunker.ts:170-184` | 整段 excerpt 的 `indexOf` 可能因被丢的空行而失配；**excerpt 第一段（首个 `\n` 前）始终是原文连续子串** → 可作可靠锚点 |
| 原文存在 `ConverterApp.novel`（useState） | `app/components/ConverterApp.tsx:50` | 溯源高亮的原文数据源现成，只需逐级传 prop |
| 输入区是 `<textarea>` | `app/components/InputPanel.tsx:62-67` | textarea 内无法渲染 `<mark>` → 高亮必须用**独立只读原文渲染**（非复用输入框） |
| `fromYAML(text)` = `yaml.parse` + `parseScreenplay`(zod)，坏输入抛错 | `lib/schema/yaml.ts:35-38` | 回灌校验现成；组件可直接 import（schema 层允许，仅 `lib/sse`/`lib/client` 限 type-only） |
| `fromYAML` **不**跑 `checkReferentialIntegrity`（独立导出 fn） | `lib/schema/screenplay.ts:152` | 回灌时若要 catch 断引用需另调 |
| `toYAML(screenplay)` 现成，关 anchor、round-trip identity | `lib/schema/yaml.ts:22-28` | `edited` 剧本可重新序列化喂 YAML 视图 + 导出 |
| `ConverterApp` **未**传 `busy={inFlight}` 给 InputPanel | `app/components/ConverterApp.tsx:100-104` vs `InputPanel.tsx:36` | 现状转换中「转换」按钮没禁用 → 可重复提交；D3 顺手补 |
| `pipelineState.warnings: SceneWarning[]`（含 `sceneId`+`message`）已存在 | `lib/client/pipelineState.ts:31-34,141` | needs_review 详情有数据可展示，按 sceneId 关联 |
| `state.error: {stage,sceneId?,message}` + 顶部红 banner 已有 | `pipelineState.ts:46` / `ConverterApp.tsx:106-110` | 错态打磨在此基础上加「重试」等 |

E10 边界纪律（AGENTS.md）：`lib/sse/*`、`lib/client/*` 只 `import type` from schema/events，严禁 import `lib/agent/*` 运行时/fs/env。`lib/schema/*` 是允许的运行时依赖（pure、无 fs）。组件（`app/components/*`）可 import schema 运行时（`fromYAML`/`toYAML`/`checkReferentialIntegrity`）。

---

## 4. 设计：溯源（D1=A）

### 4.1 纯逻辑 —— `lib/client/locateExcerpt.ts`（node 单测，type-only import）

```ts
export interface ExcerptMatch { start: number; end: number } // [start,end) 原文 JS UTF-16 索引（非码点；与 String.slice/React 一致，E4）
/** 在 novel 中定位 excerpt，返回原文偏移区间；定位不到返回 null。 */
export function locateExcerpt(novel: string, excerpt: string): ExcerptMatch | null
```

逐级回退（命中即返回）：
1. **精确**：去掉 excerpt 末尾省略号 `…`，`novel.indexOf(trimmed)`，`end = start + trimmed.length`。
2. **首段锚点**：取 excerpt 第一个 `\n` 前的非空片段 `anchor`（去除前后空白），`indexOf(anchor)`；命中则 **`end = start + anchor.length`**（只高亮锚点本身，**不**延伸到整段 excerpt 长度——E3：延伸会盖到不相关后文）。
3. **空白归一化**：归一化助手 `normalizeWithMap(s)` 把 `\r\n`/`\r`/`\n`、ASCII 空白、全角空格 `　`、tab 的连续段折叠成单个空格，返回 `{ norm:string, map:number[] }`（`map[i]` = norm 第 i 字符对应的原文 UTF-16 索引，E5）；在 `norm(novel)` 里 `indexOf(norm(excerpt 去…))`；命中用 `map` 把 start/end 映回原文偏移。**该助手独立导出并单测**。
4. 全失败 → `null`。

**作用域说明（E1/E6）**：locateExcerpt 在**整本** novel 搜索、取第一处命中（确定性）。不按章裁剪——前端无章偏移，按章裁剪需复刻 chunker 逻辑（违 E10 且会漂移）。excerpt 是 ≤120 字的叙事 head，碰撞概率低；残余「定位到同文异章」风险记为**已知限制**（数据不错，仅高亮位置可能偏；弹层 excerpt 文本始终正确）。若日后需精确按章，应由 schema/SSE 把章偏移带到前端，不在 PR8 复刻 chunker。

边界用例（必测）：空 novel / 空 excerpt → null；CJK 偏移正确（明确是 UTF-16 索引）+ **emoji/代理对单独一例**（E4）；excerpt 跨被丢空行（步骤 1 失配、步骤 3 命中）；CRLF 原文（步骤 3 归一）；excerpt 末尾 `…`；同一片段出现多次（取第一次，确定性）；novel 被改动后失配 → null（弹层兜底）。

> 为什么是 `lib/client` 而非组件内：纯函数、零 DOM，node 环境单测最稳；偏移正确性是这功能的命门，必须可单测。

### 4.2 组件

- **`SceneCard`** 新增 prop `novel: string` + 「溯源」按钮（footer，挨着「第 N 章」）。点击 → 打开 `SourceModal`。
- **`SourceModal`**（新建 `app/components/SourceModal.tsx`，client）：props `{ scene, novel, onClose }`。内容：
  - 标题：`第 {chapter} 章 · 溯源`（`aria-labelledby` 指向它，E8）。
  - **excerpt 区**：始终渲染 `scene.source.excerpt`（verbatim，兜底——即便定位失败也看得到原文摘录，信任闭环不依赖定位成功）。
  - **原文定位区**：固定高度可滚动区（`max-h` + `overflow-auto`，E20），调 `locateExcerpt(novel, excerpt)`：
    - 命中 → 渲染原文的上下文窗口（match 前后各 ~200 字，避免渲染整本）：**用 React 文本节点** `{before}<mark>{match}</mark>{after}` + `whitespace-pre-wrap`。**禁用 `dangerouslySetInnerHTML`**（E7：novel 是用户粘贴文本，innerHTML 注入即 XSS；React 文本节点天然转义）。`<mark>` 上挂 ref，`useEffect` 里 `markRef.current?.scrollIntoView({block:"center"})`。
    - 未命中 → 提示「未能在原文中精确定位（可能原文已被编辑），下方为场景摘录」，不渲染高亮。
  - **关闭 + a11y（E8/E9）**：右上 ×、点**遮罩**（`onMouseDown` 只挂 backdrop，dialog 面板 `stopPropagation`，防选中原文时误关——E9）、`Esc`。`role="dialog"` `aria-modal`；打开时焦点进入 modal 并**焦点陷阱**（Tab 循环在 modal 内），关闭时**焦点还给触发按钮**（保存 opener ref）。
- **传参链**：`ConverterApp` 的**运行快照** `sourceNovel`（见 §5.2，E2）→ `ScreenplayView`（加 `novel` prop）→ `SceneCard`（加 `novel` prop）。`SourceModal` 开合状态在 `SceneCard` 本地 `useState`；**当 `scene.id`/`scene.source.excerpt` 变化时 effect 关闭 modal**（E19：YAML 编辑替换/删除了该场景时不残留陈旧弹层）。

> 上下文窗口而非整本：红楼三回样本就上万字，整本塞进 modal 会卡且找不到重点。窗口取 match±200 字。
> 滚动测试只断言 ref 路径（mark 挂了 ref、effect 调了 scrollIntoView），不测真实浏览器滚动物理（jsdom 无布局，E20）。

---

## 5. 设计：YAML 回灌编辑（D2=A）

### 5.1 纯逻辑 —— `lib/client/applyEdit.ts`（node 单测，**例外**：import 运行时 from `lib/schema`）

> E10 例外说明：AGENTS.md 禁的是 `lib/client` import `lib/agent`（后端/fs/env）。`lib/schema` 是 pure 运行时、前后端共用、无 fs。`pipelineState.ts` 已 `import type` from schema；`applyEdit` 需要 `fromYAML`/`checkReferentialIntegrity` 的**运行时**。这是有意为之的窄例外，spec 在此显式记录，实现里加注释，避免后人误判越界。若坚持零运行时跨界，退路是把 `applyEdit` 放进组件——但那样纯逻辑就没法 node 单测了，得不偿失。

```ts
export type ApplyResult =
  | { ok: true; screenplay: Screenplay; refWarnings: ReferenceIssue[] }
  | { ok: false; error: string }
/** 解析+校验用户编辑的 YAML。结构/zod 错 → ok:false（保留旧态由调用方决定）；
 *  断引用 → ok:true + refWarnings（应用但警示）。 */
export function applyEdit(text: string): ApplyResult
```

- **长度护栏（E14）**：`text.length > MAX_YAML_CHARS`（取个宽松上限，如 1_000_000）→ `{ok:false, error:"内容过长"}`，避免超大/alias 密集 YAML 卡死 `yaml.parse`。
- `try { sp = fromYAML(text) } catch (e) { return {ok:false, error: friendly(e)} }`
- `friendly(e)`：ZodError → 取首个 issue 的 `path.join('.')` + message，拼成中文可读串（如「characters.0.name: 不能为空」）；YAML 解析错 → 「YAML 语法错误：<parser msg>」。
- **附加不变量（E12/E13，`fromYAML` 不覆盖）**：
  - **id 唯一性**：`scenes[].id` / `characters[].id` / `locations[].id` 各自去重；有重复 → `{ok:false, error:"scenes.id 重复：scene_1_1"}`（重复 id 会砸 React key + 引用 + 导出语义）。
  - **至少一个场景**：`scenes.length === 0` → `{ok:false, error:"剧本至少需要一个场景"}`。
- 全部通过 → `refWarnings = checkReferentialIntegrity(sp)`；返回 `{ok:true, screenplay:sp, refWarnings}`。

必测：合法 YAML → ok + screenplay；YAML 语法错 → ok:false + 含「语法」；zod 违例（缺字段/未知字段/空串）→ ok:false + 路径可读；**重复 id → ok:false**；**空 scenes → ok:false**；断引用（dialogue 引用不存在的 character_id）→ ok:true + refWarnings 非空；空串 / 超长 → ok:false。

### 5.2 状态模型（`ConverterApp`）

- 新增 `const [edited, setEdited] = useState<Screenplay | undefined>(undefined)`。
- **运行快照 `sourceNovel`（E2）**：`startConversion` 时把当时的 `novel` 存入 `const [sourceNovel, setSourceNovel] = useState("")`（或 ref）。溯源高亮用 `sourceNovel`（本轮转换的原文），**不**用实时 `novel`——否则用户转换后又编辑输入框，溯源会去搜被改过的文本。
- 派生：
  - `displayScreenplay = edited ?? state.screenplay`
  - `displayScenes = edited ? edited.scenes : state.scenes`
  - `displayYaml = edited ? toYAML(edited) : state.yaml`
- **`startConversion` / `cancelConversion` / 重试 时先 `setEdited(undefined)` 再 dispatch reset**（E16：编辑随新一轮/取消/重试作废，所有渲染+导出只走 display*）。
- 传给 `ScreenplayView`：`scenes=displayScenes`、`screenplay=displayScreenplay`、`yaml=displayYaml`、`novel=sourceNovel`、`warnings=state.warnings`、`canEdit = state.status === "done"`、`onApplyEdit = (sp) => setEdited(sp)`。

> 为什么 overlay 而不改 reducer：`pipelineState` 是 SSE 流的纯投影，必须保持「流→态」单向可重放（E4 runId 隔离靠它）。用户编辑是**流之外**的另一来源，塞进 reducer 会污染可重放性。overlay 在 App 层合流，职责干净。

### 5.3 组件

- **`YamlView`** 重写为可编辑：props `{ yaml, canEdit, onApply }`。
  - `canEdit=false`（流式中）→ 维持现状只读 `<pre>`。
  - `canEdit=true` → `<textarea>`（本地 draft state，seed=yaml）+ 「应用」「重置」按钮 + 内联错误/警告区。
    - 「应用」→ `applyEdit(draft)`：`ok` → `onApply(screenplay)` **并把本地 draft 重置为 `toYAML(screenplay)`**（E10：应用后规范化文本回灌编辑器，使 卡片/YAML/导出 三者可见一致，不留陈旧文本）；有 `refWarnings` → 显示黄色「引用警告：场景 X 引用了未定义的 Y（已应用，建议核对）」；`!ok` → 显示红色 error，**不调 onApply**（旧态不变）。
    - 「重置」→ draft 回到当前 `yaml`（即 displayYaml），清错误。
  - draft 与外部 yaml 不同步问题：用「重置」显式同步，避免边输入边被 prop 覆盖（受控/非受控折中：textarea 用本地 state，prop 变化不自动覆盖 draft，靠重置）。
  - **UX 文案（E15）**：注明「应用会规范化 YAML（注释/锚点不保留）」——`toYAML` 关 anchor、`yaml.parse`→`stringify` 丢注释，这是可接受取舍，明示用户。
- **`ScreenplayView`** 透传 `canEdit`/`onApply` 给 YamlView；导出按钮已用 `yaml` prop（现在是 displayYaml）→ 自动导出编辑后内容。

---

## 6. 设计：空/错状态打磨（D3=A）

枚举全状态 + 统一视觉（统一用 Tailwind，保持现有 zinc/red/amber 配色；可加极简 inline SVG/emoji 图标，不引图标库）：

| 状态 | 现状 | PR8 打磨 |
|---|---|---|
| 空输入（idle，未转换） | 一行灰字提示 | 居中引导卡：图标 + 「粘贴/上传/载入示例」一句话 + 指向三按钮 |
| 转换中、场景未到 | 「尚无场景……」 | 骨架/脉冲占位 + 「场景编剧工作中 n/total」 |
| 转换失败（fatal error） | 顶部红 banner | 红 banner + **「重试」按钮**（重跑 startConversion）+ stage 名 |
| 场景 needs_review | amber「需复核」徽章 | 徽章可点 → 展开/tooltip 显示该 sceneId 对应 `warnings` 的 message（无 message 时给默认文案） |
| 示例载入失败 | 已有红字 | 维持（已 OK），文案统一 |
| 超字数 | 计数变红 | 维持 + 「转换」禁用态文案提示已隐含 |
| 取消转换 | reset 回 idle | 回到空输入引导态（复用第一行） |
| 防重复提交 | **缺** `busy` 未传 | `ConverterApp` 传 `busy={inFlight}`；转换中「转换」禁用 |

needs_review 详情数据：`ScreenplayView`/`SceneCard` 需拿到 `warnings`（按 sceneId 查 message）。传 `warnings: SceneWarning[]` 给 ScreenplayView → 在 map 时按 `scene.id` 找对应 message 传给 SceneCard。

**编辑后 warnings 去耦（E11）**：当 `edited` 存在时，`warnings` 是「生成版本」的产物，可能指向已被编辑改 id/删除的场景。处理：渲染时**只保留 sceneId 仍存在于 displayScenes 的 warning**；若 `edited` 存在且仍有 warning，加一行说明「警告来自生成版本，编辑后可能已不适用」。

---

## 7. 文件清单（Files Reference）

| 文件 | 改动 |
|---|---|
| `lib/client/locateExcerpt.ts` | 新建：excerpt→原文偏移定位（3 级回退） |
| `lib/client/locateExcerpt.test.ts` | 新建：精确/锚点/归一化/未命中/CJK/多次出现 |
| `lib/client/applyEdit.ts` | 新建：YAML 回灌解析+校验+断引用警告（schema 运行时窄例外） |
| `lib/client/applyEdit.test.ts` | 新建：合法/语法错/zod 违例/断引用/空串 |
| `app/components/SourceModal.tsx` | 新建：溯源弹层 + 高亮原文窗口 + a11y |
| `app/components/SourceModal.test.tsx` | 新建：开合/高亮渲染/未命中兜底/Esc |
| `app/components/SceneCard.tsx` | 加 `novel`+可选 needs_review message prop、溯源按钮、徽章可展开 |
| `app/components/SceneCard.test.tsx` | 增：溯源按钮触发 modal、徽章展开 message |
| `app/components/YamlView.tsx` | 重写：canEdit 时可编辑 + 应用/重置 + 错误/警告区 |
| `app/components/YamlView.test.tsx` | 新建：只读态、应用成功 onApply、语法错不调 onApply、断引用警告、重置 |
| `app/components/ScreenplayView.tsx` | 透传 novel/warnings/canEdit/onApply |
| `app/components/ScreenplayView.test.tsx` | 增：透传、displayYaml 导出、空/骨架态 |
| `app/components/ConverterApp.tsx` | edited overlay + display* 派生 + busy + 重试 + 空态引导 |
| `app/components/ConverterApp.test.tsx` | 增：编辑回灌后卡片+导出同步、重置作废、busy 禁用、重试 |
| `app/components/InputPanel.tsx` | 可能微调空态引导（或在 ConverterApp 侧加引导卡） |
| `docs/DEVLOG.md` | PR8 实现纪实节 |

---

## 8. 验收标准（Acceptance Criteria，可测）

1. `locateExcerpt`：对样本「红楼三回」每个场景的 excerpt，精确或归一化命中率可断言（≥ 单测固定用例全过）；空输入返回 null；CJK 偏移正确。
2. 点 SceneCard「溯源」→ 弹层出现，excerpt 文本始终可见；命中时原文窗口含 `<mark>` 高亮且滚动到位；未命中显示兜底提示、不报错。
3. YAML 视图（done 后）改为合法 YAML 点「应用」→ 卡片视图同步反映改动、导出内容为编辑后 YAML。
4. YAML 改为非法（语法错或 zod 违例）点「应用」→ 内联红色错误（含可读路径/原因），卡片与导出**保持上一份好状态**不变。
5. YAML 改为合法但含断引用 → 应用成功 + 黄色引用警告。
6. 流式进行中 YAML 视图不可编辑（只读 `<pre>`）。
7. 转换失败 → 红 banner + 「重试」可重新发起；needs_review 徽章可展开看原因。
8. 转换中「转换」按钮禁用（`busy`），不能重复提交；取消后回到空输入引导态。
9. 新一轮转换 / 取消 → `edited` 作废，回到流式态。
10. `npm test` 全绿（既有 209 不回归 + 新增）、`npx tsc --noEmit` 干净、`npm run lint` 干净。
11. E10 边界不破：`lib/client/*` 仍只对 `lib/agent` type-only；`applyEdit` 仅对 `lib/schema` 运行时依赖（已记录例外）。

---

## 9. 测试金字塔

| 层 | 测什么 | 增量 |
|---|---|---|
| 单元(node) | `locateExcerpt` 4+ 路径、`applyEdit` 5 路径 | +~15 |
| 组件(jsdom) | SourceModal 开合/高亮/兜底；YamlView 编辑→应用/报错/警告/重置；SceneCard 溯源+徽章；ScreenplayView 透传/空骨架；ConverterApp 回灌合流/busy/重试/作废 | +~15 |
| E2E(真浏览器) | playwright MCP：转换→点溯源跳高亮→改 YAML 应用→卡片刷新→导出（PR8 收尾人工实跑，不进 CI） | 1 轮 |

---

## 10. 实现顺序（TDD）

1. `locateExcerpt`（红→绿，纯函数先行，命门）。
2. `applyEdit`（红→绿，纯函数）。
3. `SourceModal` + `SceneCard` 溯源（组件红→绿）；接 `ScreenplayView`/`ConverterApp` 传 novel。
4. `YamlView` 可编辑 + `ConverterApp` edited overlay 合流（组件红→绿）。
5. 空/错态打磨 + `busy` + 重试 + needs_review 详情。
6. `tsc`/`lint`/全量 `npm test` → 真浏览器实跑 → DEVLOG。
7. **大审查**：`/code-review`+`/security-review` 冷读 `git diff 69ff533...<head>` → 结论交用户 → 用户点头 merge。

## 11. 回滚

纯前端增量，无数据/迁移。回滚 = revert PR。`edited` overlay 不持久化（无 localStorage），刷新即回到流式态，无残留。

## 12. codex 冷读增量（E1–E20，2026-06-07，初版 6.5/10 → 已吸收）

codex（read-only，medium）冷读初版 spec 给 20 条 + 6.5/10。逐条处置如下；**已吸收**项已写回上文对应小节，**已知限制/取舍**项保留并明示。

| # | 问题 | 处置 |
|---|---|---|
| E1 | locateExcerpt 整本搜索 → 同文异章可能高亮错章 | **已知限制**：前端无章偏移，按章裁剪需复刻 chunker（违 E10）。excerpt 120 字够独特，碰撞罕见；数据不错仅高亮位置可能偏。见 §4.1 作用域说明。日后精确需由 schema/SSE 带章偏移 |
| E2 | `novel` 是实时可编辑态，非本轮转换原文 | **已吸收** §5.2：`startConversion` 快照 `sourceNovel` 传下游 |
| E3 | 首段锚点把 end 延到整段长度 → 盖到后文 | **已吸收** §4.1 步骤 2：`end = start + anchor.length` |
| E4 | 「CJK 偏移」措辞含糊；JS 是 UTF-16 | **已吸收** §4.1：明确 UTF-16 索引 + emoji/代理对单独测 |
| E5 | 归一化对 CRLF/全角空格/tab/丢空行未定清 | **已吸收** §4.1 步骤 3：`normalizeWithMap` 独立导出+单测，覆盖 `\r\n`/`\r`/`\n`/ASCII ws/`　`/tab |
| E6 | 多处归一化命中「首个」常错 | **同 E1**：确定性取首个 + 文档化限制 |
| E7 | 高亮若用 `dangerouslySetInnerHTML` → XSS | **已吸收** §4.2：React 文本节点 + `whitespace-pre-wrap`，禁 dangerouslySetInnerHTML 并加测试断言 |
| E8 | modal 焦点陷阱/焦点还原缺失 | **已吸收** §4.2：focus trap + opener 还焦 + `aria-labelledby` + Esc |
| E9 | 点遮罩关闭可能误关（选中原文时） | **已吸收** §4.2：close 只挂 backdrop，面板 stopPropagation |
| E10 | 应用成功后 textarea 仍显陈旧文本 | **已吸收** §5.3：onApply 后 draft = `toYAML(applied)` |
| E11 | 编辑改/删场景后 warnings 与场景脱节 | **已吸收** §6：只留 sceneId 仍存在的 warning + 说明 |
| E12 | schema 允许重复 id → 砸 React key/引用/导出 | **已吸收** §5.1：applyEdit 加 id 唯一性校验 → ok:false |
| E13 | 编辑后空场景/断章等不变量缺 | **已吸收** §5.1：≥1 场景 + 唯一 id；正章号 zod 已覆盖；定位不到→警告 |
| E14 | 超大/alias 密集 YAML 卡死 parse | **已吸收** §5.1：`MAX_YAML_CHARS` 长度护栏 |
| E15 | 应用会丢注释/锚点，与「注释友好」措辞冲突 | **已吸收** §5.3：UX 文案明示「规范化、注释不保留」取舍 |
| E16 | `canEdit` 在重试后行为未定 | **已吸收** §5.2：start/cancel/重试先清 `edited`，全走 display* |
| E17 | 重试 UX 含糊，须复用 startConversion 守卫 | **已吸收** §6 + §5.2：重试按钮调 startConversion，守卫同 InputPanel |
| E18 | 没有测「导出标题/内容随编辑变」 | **已吸收** §8 验收 3 + §9：加 title 改后导出断言 |
| E19 | SceneCard modal 状态在场景被替换后残留 | **已吸收** §4.2：scene.id/excerpt 变 → effect 关 modal |
| E20 | scrollIntoView 无稳定滚动容器/ref 契约 | **已吸收** §4.2：固定高度滚动区 + mark 挂 ref + useEffect；测 ref 路径非滚动物理 |

吸收后预期执行性显著高于初版 6.5（盲点已转成显式契约 + 验收项 + 测试）。实现时以本节为准逐条核对。
