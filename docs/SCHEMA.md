# 剧本 YAML Schema 设计文档（SCHEMA.md）

> 本文档论证 `lib/schema/screenplay.ts`（zod，单一事实来源）与 `lib/schema/yaml.ts`（序列化）的设计**原因**。Schema 本身是评审明确要求的「自定义 YAML Schema + 书面论证」核心加分项。

---

## 1. 一眼看懂：一份剧本长什么样

```yaml
title: 深夜咖啡馆
logline: 一名刑警在街角咖啡馆遇见关键证人。
characters:                      # 人物表 = Story Bible（跨场景共享记忆）
  - id: char_lin                 # 稳定 id，被场景引用
    name: 林深
    aliases: [小林, 林队长]       # 同角色多称呼 → 跨章一致性关键
    description: 三十岁刑警
    arc: 从怀疑到信任
locations:
  - id: loc_cafe
    name: 街角咖啡馆
scenes:
  - id: scene_1
    heading:                     # 场景头（slug line），全部可机器校验
      int_ext: INT               # 枚举 INT | EXT
      location_id: loc_cafe      # 引用 locations[].id
      time_of_day: DAY           # 枚举 DAY | NIGHT | DAWN | DUSK | CONTINUOUS | LATER
    synopsis: 林深进入咖啡馆与证人对话。
    source:                      # 溯源 → 可信、可回查原文
      chapter: 1
      excerpt: 第1-3段
    elements:                    # 有序异构列表：忠实表达剧本线性时间流
      - { type: action, text: "林深推门而入。" }
      - { type: dialogue, character_id: char_lin, parenthetical: "(压低声音)", line: "你来了。" }
      - { type: transition, text: "CUT TO:" }
```

---

## 2. 顶层结构

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 剧名 |
| `logline` | string | 一句话梗概 |
| `characters` | `Character[]` | 人物表 = Story Bible，被场景以 id 引用 |
| `locations` | `Location[]` | 地点表，被场景头以 id 引用 |
| `scenes` | `Scene[]` | 有序场景列表 |

**Character**：`id`、`name`（必填）；`aliases`（缺省 `[]`）、`description`、`arc`（可选）。
**Location**：`id`、`name`（必填）；`description`（可选）。
**Scene**：`id`、`heading`、`synopsis`、`source`、`elements`（必填）；`needs_review`（可选，自纠超限时由 Critic/Orchestrator 打标）。
**Element**：按 `type` 区分的判别联合（discriminated union）：
- `action` → `{ type, text }`
- `dialogue` → `{ type, character_id, parenthetical?, line }`
- `transition` → `{ type, text }`

---

## 3. 七个设计决策与原因

### 3.1 id 引用，而非内联字符串
人物/地点用稳定 `id`（`char_lin` / `loc_cafe`）声明一次，场景只引用 id。

**为什么**：
- **跨章一致性**——这是「≥3 章」选题的核心难点。同一角色在不同章节有「小林/林队长」等多种称呼，`aliases` 把它们归并到一个 id，下游全用 id，称谓再乱也不会分裂成多个角色。
- **可机器校验引用完整性**——见 `checkReferentialIntegrity`：任何 `character_id`/`location_id` 没有对应声明，都能被定位报出（§3.4）。
- **改一处全局生效**——作者改个名字只动人物表一行。
- **agent 的记忆落点**——StoryBible Curator 拥有这张表，Scene Converter 只读引用，形成清晰的「共享只读记忆」边界。

### 3.2 `elements`：有序异构列表
场景内容不是固定字段，而是一个 `action / dialogue / transition` 交错的**有序列表**。

**为什么**：剧本的本质是**线性时间流**。「动作—对白—动作—转场」的次序本身携带信息，固定字段（如 `dialogues: []` + `actions: []`）会丢失交错顺序。用判别联合既保留顺序，又让每种元素有各自严格的字段约束。

### 3.3 `source` 溯源
每个场景记录来源 `chapter` + `excerpt`。

**为什么**：对抗 LLM 幻觉、建立作者信任。作者能从任一生成场景**跳回原文段落**核对，闭合「可信 → 可编辑 → 可打磨」的产品价值闭环。这也是 demo 的关键叙事点。

### 3.4 结构校验与引用完整性**分离**
`ScreenplaySchema`（zod）只管**结构**；`checkReferentialIntegrity()` 单独管**跨实体引用**，返回带定位的问题列表而非抛错：

```ts
interface ReferenceIssue {
  scene_id: string;
  kind: "character" | "location";
  ref: string;     // 没解析上的 id
  where: string;   // "heading.location_id" | "elements[2].character_id"
}
```

**为什么分开**：
- 一个场景可以**结构合法但引用了 Bible 尚未定义的 id**（流水线逐场景生成时很常见）。结构校验不该因此失败。
- 自纠闭环需要**带位置的引用错误**回灌给 Scene Converter 重试；一个笼统的 `ZodError` 给不了「第几个 element 的哪个 id 错了」。
- 空数组 = 通过。这正是 §4 职责表里 **Validator（格式审校）** 的「zod 校验 + 引用完整性」两件事，PR6 的 Validator 会直接复用这两块。

### 3.5 枚举对齐行业标准
`int_ext`（INT/EXT）、`time_of_day`（DAY/NIGHT/DAWN/DUSK/CONTINUOUS/LATER）用枚举。

**为什么**：对齐影视行业 slug line 约定；可机器校验、可被渲染器（卡片视图 / 未来的 Fountain·PDF 导出）直接消费；防止 LLM 写出「凌晨三点」这类自由文本污染结构。

### 3.6 `strictObject`：拒绝未知字段
所有对象用 zod `strictObject`，多出来的键直接判错。

**为什么**：LLM 会**幻觉出 schema 之外的字段**或把字段名拼错。宽松模式会静默保留/丢弃，让错误潜伏到下游；严格模式让它在校验这一关就**响亮失败**，是对抗幻觉的第一道闸。

### 3.7 纯数据，YAML 为面向作者的格式
Schema 不含任何表现层；序列化选 YAML 而非 JSON。

**为什么**：
- **纯数据**——同一份剧本可被多种渲染器消费（卡片流、YAML 源码视图、未来导出 Fountain/PDF）。
- **YAML 面向人手编辑**——块状结构、可读、diff 友好，契合「作者可编辑、可打磨」。`fromYAML` **始终经过 zod 校验**，手改漂移会响亮报错而非生成畸形剧本。
- 序列化**关闭 YAML anchor/alias**（`&a1`/`*a1`）：它们是合法 YAML 但对人类读者不友好，重复字符串宁可展开。

---

## 4. API 速查

```ts
import {
  ScreenplaySchema,          // zod schema（结构）
  parseScreenplay,           // (data) => Screenplay，非法抛 ZodError
  checkReferentialIntegrity, // (Screenplay) => ReferenceIssue[]（空=通过）
  type Screenplay, type Scene, type Element, type Character, type Location,
} from "@/lib/schema/screenplay";

import { toYAML, fromYAML } from "@/lib/schema/yaml";
// toYAML(screenplay): string        块状、可编辑、无 anchor
// fromYAML(text): Screenplay         解析 + zod 校验，非法抛错
```

**round-trip 保证**：`fromYAML(toYAML(s))` 深等于 `s`（见 `yaml.test.ts`）。

---

## 5. 非目标（YAGNI）

- 不内置 Fountain/PDF 导出（schema 已为之保持纯数据，留作后续）。
- 不做 schema 版本迁移（当前单版本；未来加版本号再议）。
- `time_of_day` 枚举只收最常用 6 项，按需扩展而非一次堆全。
