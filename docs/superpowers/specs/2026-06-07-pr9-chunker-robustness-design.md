# PR9 — 切分鲁棒性（后端 chunker）· 设计 spec

> 设计走 gstack `/gstack-spec`（轻量档：spec + 一次 codex 冷读复审，不跑 `/code-review`+`/security-review` 大审查——用户拍板并入下次前端 PR）。实现走 superpowers TDD。
> 锚点：基于 main `1162e8d`（Merge PR #10）。分支 `pr9-chunker-robustness`。

## Context
用户实跑（DeepSeek，真红楼）暴露 `lib/agent/chunker.ts` 在脏/多版本/非标准输入下三处失守。chunker 是确定性、无 LLM 的纯函数（`lib/agent`），解析**未信任的外部粘贴文本** → 属安全敏感面。PR9 只改 `lib/agent`，不动前端 / schema 顶层契约 / 新增 LLM 调用。

## Current State（已核验，2026-06-07）
| 症状 | 根因 | 证据 |
|---|---|---|
| ① `《红楼梦》第三回…` 全篇当 1 章、`source.chapter` 全 1、标题吞进 excerpt | `CHAPTER_HEADING`（chunker.ts:26）要求行首 `^[空白]*第N回`，`《》` 前缀失配 → `headings.length===0` → 整篇 1 章；`chapter = ch.index+1`（orchestrator.ts:341） | 绑定样本 `samples/honglou-meng-ch1-3.txt:1` 是干净 `第一回　…`（所以现有测试全绿），用户那份是带 `《》` 的另一来源 |
| ② 多版本粘贴 → 近重复场景 `1_1≈1_3` | `splitScenes` 无去重 | chunker.ts:157 |
| ③ 现代散文整篇成 1 超大场景 → 超 `SCENE_BODY_CAP=4000` → 诚实截断+needs_review | `splitScenes` 三启发式（分隔行/≥2空行/cue）对无信号散文不触发，无长度兜底 | chunker.ts:157、sceneConverter.ts:371-380 |

## Proposed Change

### 1. 回目识别鲁棒化（稳健集，D1）
重写 `CHAPTER_HEADING` 为「可选前缀 + 可选空白 + 主标记 + 可选空白 + 可选标题（禁句读，保留 PR4 护栏）」，整行锚定 `^…$`。

**精确边界规则（codex F1 收紧）**：
- **空白**：marker 前后、prefix 后均允许 `[ \t　]*`（含全角空格），故 `《红楼梦》　第三回　甄士隐` 也命中。
- **可选前缀**：`(《[^》\n]{1,30}》|【[^】\n]{1,30}】)?`——非贪婪、限长、禁跨行/禁嵌套同类括号。前缀后只能接空白 + 主标记，前缀+主标记中间不许夹其它正文。
- **主标记**（marker capture，任一）：
  - 中式 `第\s*[0-9〇零一二三四五六七八九十百千两]+\s*[卷章回节部篇]`；
  - 组合 `第N卷` + 空白 + `第N章/回/节`（如 `第二卷 第3章` / `第二卷·第三章`，分隔 `[ \t　·．.]`），**marker 串保留两级**（`第二卷第三章`，`normalizeMarker` 折叠内空白）；
  - 英译 `(?:chapter|ch\.?)\s*[0-9]+`，大小写不敏感（`Chapter 1` / `CHAPTER 12` / `Ch. 3`）。
- **可选标题**：marker 后 `[ \t　：:.]*` 分隔，再接标题；标题段沿用 PR4 护栏 `[^。！？，、；：…．,.!?;:]*?`（禁句末标点 → 堵 `第四回中既将…`），整行 `$` 收尾。`第三回：黛玉进府` / `Chapter 1: The Storm` 均命中，标题入 `title` 不进 body。
- **不认**：裸数字行（`1`/`一、`/`01`）、罗马数字（`Chapter I`）——回归风险高，明确 out-of-scope（§Out of Scope）。
- **护栏=仅 PR4 标点护栏**（codex F2）：**不引入「章号递增 sanity」**——它会错杀合法的选集（从第 80 回起）、卷内重置（`第二卷 第1章`）、番外、乱序粘贴，得不偿失。残留风险（孤行 `第十回里的故事` 无标点 → 可能误判）与 PR4 defer 项同档，文档记录、不强治。
- **网文说明**：散乱网文不会出现上述前缀 / 组合（用户指出）；其鲁棒性靠 §2 长度兜底，不靠回目正则。简单 `第N章 标题` 仍照常识别。

### 2. 分体裁切分 + 长度兜底（硬保证·段落优先，D2）
不引入硬性体裁分类器——三个启发式是**加性**的，各自有信号才触发（cue 仅章回体命中，散文天然不触发），再加一道**通用长度兜底**作 Pass 3：
- 新增 `SCENE_SOFT_TARGET = 1500`（字符数，与现有 `capSceneBody` 一致用 `String.length` = UTF-16 码元；中文几乎全 BMP，码元 ≈ 字，足够；emoji 等罕见非 BMP 不精确但无害）。`splitScenes` 现有两 pass 后，对仍超软目标的候选 `packBySoftTarget` 级联再切。
- **精确装箱算法（codex F3）**——「发射在溢出之前」greedy：
  1. **段落级**：按单空行拆段，段间以 `\n` 重连计长。逐段累加进当前箱；**若加入下一段会使箱长 > `SCENE_SOFT_TARGET` 且当前箱非空 → 先发射当前箱**，新箱从该段起。
  2. **单段仍 > 软目标** → 该段按句末标点（`[。！？…；!?;]` 之后切，标点留在前句）拆句，同样 greedy 装箱（句间直接拼接，不插分隔）。
  3. **单句/无标点长串仍 > 软目标** → 按 `SCENE_SOFT_TARGET` 定长硬切（兜底的兜底）。
- **硬保证**：输出任一候选 `text.length ≤ SCENE_SOFT_TARGET ≤ SCENE_BODY_CAP`。`SCENE_BODY_CAP` / 截断逻辑保留作纯 backstop，正常输入永不触发 → 导出不再出现 needs_review 截断。
- **边界测试**（codex F3）：3999 / 4000 / 4001 字单候选；4000 字单段拆成 1500/1500/1000；4000 字无任何标点长串 → 全部断言每候选 ≤ 1500 且总长无损（拼回 == 原文去多余空白）。
- 不改 sceneConverter 的 cap 常量（防御性双保险）。

### 3. 近重复检测（标记 + 自动合并相邻，D2 决策）
- **指标**：候选文本归一化（去全部空白 + 句读标点）后取字符 3-gram 集合，算 Jaccard 相似度 `|A∩B| / |A∪B|`。归一化后 < 3 字符的候选退化为完全相等比较。
- **防误杀（codex F4）**：仅对**归一化长度 ≥ `NEAR_DUP_MIN_LEN = 100`** 的候选参与近重复判定 → 短对白 / 诗词叠句 / 套语不被误并；阈值上调 `NEAR_DUP_SIM = 0.9`。多版本粘贴的重复**整块**天然 ≥100 字且高度相似，正中靶心；合法的短重复（chorus / 对仗）因长度门槛被放过。
- **相邻自动合并**：相邻候选相似度 ≥ `NEAR_DUP_SIM` → 去重保一份，**保留更长者**（信息更全；等长取靠前），丢另一份；纯 chunker 内部，输出候选数减少、保序、re-index from 0，无下游改动。（语义=去重，非拼接。）
- **非相邻标记**：候选与更前某候选相似度 ≥ `NEAR_DUP_SIM` 但不相邻 → 在 `SceneCandidate` 加可选字段 `nearDuplicateOf?: number`。**语义明确（codex F5）**：该值 = 它所相似的更前候选的**最终 `index`（合并去重、re-index 之后的、章内 0-based）**，与同对象 `index` 同一坐标系。orchestrator 装配该场景时若命中 → 打 `needs_review` + 一条 `near_duplicate` issue（文案含 `nearDuplicateOf` 指向的章内序号，约 3 行 plumbing）。不自动删（可能是合法复现场景，判断留人）。

### 4. 顺序保持（位置忠实，文档写明）
chunker 严格按物理位置切与排，**不做语义重排**。多版本 / 乱序输入的顺序问题源于输入物理序，非 chunker bug。`source.chapter` 维持**位置序**（`ch.index+1`），不解析回目真实号（回目号非总是干净数字；位置序总有效）。这两点写进 chunker 顶部 doc-comment + DEVLOG。

### 5. 三体裁 fixtures（脏输入，非 happy-path——codex F6）
新增 `lib/agent/__fixtures__/`（不污染 demo 的 `samples/`）。**刻意做脏**，因为 bug 类就是脏外部输入：
- **红楼章回·脏**：带 `《》` 前缀（复刻 ① bug）+ 全角空格分隔 + clean `第N回` 与带前缀 `《…》第N回` 混用 + **混入一份重复粘贴的整章**（multi-version → 测非相邻近重复标记）；
- **现代散文·无章回线索**：含**一个超长单段** + **一个超长无标点长句**（测长度兜底段级/句级/硬切三路径，断言无候选超 cap）；
- **网文短章**：多个 `第N章 标题` 短章（章号正确递增 + 每短章 ≈ 1 候选）+ 夹一处英译 `Chapter N` / `Ch. N` 段（测英译识别）。
- 罗马数字 `Chapter I`、OCR 噪声等**不**纳入 fixtures（out-of-scope，避免 scope 膨胀）。

## Acceptance Criteria
1. `《红楼梦》第三回 …` 三章粘贴 → `chunkNovel` 得 3 章，marker 各为 `第一回 / 第二回 / 第三回`，标题不进 body 首行。
2. PR4 红线回归仍绿：正文 `第四回中既将…` 不被当标题。
3. `Chapter 1 / Chapter 2` 英译式 → 识别为 2 章。
4. 现代散文长文（无章回 / 分隔 / cue）→ 所有候选 `text.length ≤ SCENE_BODY_CAP`，且 > 1 个候选。
5. 相邻近重复（同段贴两遍）→ 合并为 1 候选；非相邻近重复 → 保留两份且后者 `nearDuplicateOf` 指向前者。
6. 既有 256 测试零回归；新增单测先红后绿。
7. `npx tsc --noEmit` 干净、`npm run lint` 干净。

## Testing Plan
| Layer | What | Count |
|---|---|---|
| Unit | `CHAPTER_HEADING` 各模式 + 护栏 + sanity | +6~8 |
| Unit | `splitScenes` 长度兜底级联（段 / 句 / 硬切） | +3~4 |
| Unit | 近重复 Jaccard 合并 / 标记 | +3 |
| Integration | 三体裁 fixtures 端到端 `chunkNovel` 断言 | +3 |
| (LLM smoke) | 不新增；既有 gated smoke 不动 | 0 |

## Files Reference
| File | Change |
|---|---|
| `lib/agent/chunker.ts` | 重写 `CHAPTER_HEADING`；新增前缀 / Chapter / 组合；sanity 护栏；`splitScenes` Pass 3 长度兜底；近重复合并 / 标记；`SceneCandidate.nearDuplicateOf?` |
| `lib/agent/orchestrator.ts` | 装配时 `nearDuplicateOf` → needs_review + `near_duplicate` issue（~3 行） |
| `lib/agent/chunker.test.ts` | 新增上述单测 |
| `lib/agent/__fixtures__/*.txt` | 三体裁 fixtures |
| `docs/DEVLOG.md` | PR9 实现纪实 |
| `docs/PROJECT.md` | §6 PR9 标 ✅ |

## Out of Scope
- 语义重排 / 按真实回目号重排（位置忠实，§4）。
- `source.chapter` 改为解析回目真实号（保持位置序）。
- 前端、schema 顶层契约、新 LLM 调用。
- 裸数字行回目、罗马数字 `Chapter I`、网文专有花式标记、OCR 噪声归一化。
- 章号递增 sanity 护栏（codex F2：错杀选集/卷重置/番外，弃用）。
- 大审查（`/code-review`+`/security-review`）——用户拍板并入下次前端 PR；本 PR 仅一次 codex 冷读复审（Phase 4.5）。

## Rollback
纯 `lib/agent` 增量，无迁移 / 无外部状态。回滚 = revert PR。旧行为通过保留 cap backstop 仍安全。

## §6 codex 冷读复审记录（Phase 4.5，2026-06-07）
`codex exec`（read-only, medium）冷读本 spec：**SCORE 7/10**（≥7 过门禁）。6 条 findings 全数处置：
| # | codex finding | 处置 |
|---|---|---|
| F1 | 回目正则边界（前缀/全角空格/`：`标题/防夹正文）未定义 | §1 写死精确正则与各部件规则 + AC1 澄清三章各带前缀 |
| F2 | 「章号递增 sanity」危险（错杀选集/卷重置/番外/乱序） | **弃用**该护栏，仅留 PR4 标点护栏，残留风险文档化（§1 + Out of Scope） |
| F3 | 长度兜底装箱数学不精确（溢出前/后切、分隔符计长、UTF-16） | §2 写死「发射在溢出之前」greedy + 3999/4000/4001 + 拆箱 + 无标点长串边界测试 |
| F4 | 近重复指标太糙（套语/诗词/叠句误杀）、合并丢尾不清 | §3 加 `NEAR_DUP_MIN_LEN=100` 门槛 + 阈值升 0.9 + 合并=保留更长者去重 |
| F5 | `nearDuplicateOf` 坐标系歧义（合并前后/全局/章内/0-1 based） | §3 钉死=合并 re-index 后的章内 0-based `index`，与 `index` 同坐标系 |
| F6 | fixtures 太 happy-path，未覆盖真正脏输入 | §5 三体裁全部做脏（前缀混用/重复粘贴/超长段/超长句/英译混排） |
