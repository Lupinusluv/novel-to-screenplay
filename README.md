# AI 小说转剧本（novel-to-screenplay）

把一部小说（≥3 章效果最佳）交给一支 **多 agent「AI 剧组」**，自动产出**结构化、可编辑、可溯源**的影视剧本初稿（YAML），全过程在前端**实时可见**。

> 在线体验：**<这里放 Render 链接，形如 https://novel-to-screenplay.onrender.com>**　|　Demo 视频：**<这里放 B 站/云盘链接>**
>
> 不想部署也能看：上面的在线地址点开就能用，内置多体裁示例，零配置。首次访问若是免费实例可能有 ~40s 冷启动，请稍候。

---

## 它能做什么

- **多 agent 流水线，全程可观测**：场记（切分）→ 设定集（抽人物/地点，别名归并）→ 场景编剧（逐场景改写）→ 校验 + 责编（自纠重试）→ 导演（汇编），每一步在时间线上实时点亮。
- **跨章一致性**：人物「林黛玉/黛玉/颦儿」归并到一个稳定 id，下游全用 id 引用，称谓再乱也不分裂。
- **可溯源**：每个生成场景都能一键跳回原文高亮段落，对抗 LLM 幻觉、建立信任。
- **可编辑**：右侧 YAML 可直接改，应用时重新过 schema + 引用校验，错误不破坏已有好状态。
- **吃多种体裁**：内置古典章回 / 现代网文 / 散文 / 意识流四类真实示例，均真端到端跑通；脏输入（无回目、超长段、近重复）也鲁棒。
- **可导出**：一键导出 `.yaml`，纯数据、无表现层，可被其它渲染器/排版工具消费。

---

## 快速开始（本地克隆即跑）

### 前置
- **Node.js ≥ 20.9**（推荐 20 或 22 LTS）
- 一个 **OpenAI 兼容**的 LLM API key（DeepSeek / OpenAI / 智谱 / 本地模型皆可；demo 用 DeepSeek）

### 步骤
```bash
# 1. 克隆并进入目录
git clone <仓库地址> && cd novel-to-screenplay

# 2. 安装依赖
npm install

# 3. 【关键】配置 LLM key —— 不配则页面能开、示例能显示，但「转换」会失败
cp .env.example .env.local
#   编辑 .env.local，填入你的 key（DeepSeek 示例）：
#     LLM_BASE_URL=https://api.deepseek.com/v1
#     LLM_API_KEY=sk-你的key
#     LLM_MODEL=deepseek-chat
#   （只设 DEEPSEEK_API_KEY 也行，会自动回退到 DeepSeek 默认 baseURL/model）

# 4. 启动
npm run dev          # 开发模式 → http://localhost:3000
# 或生产模式：
npm run build && npm start
```

打开 `http://localhost:3000`，**选一个内置示例 → 点「转换」**，即可看到流水线实时拆解。
真实模型耗时：散文≈20s、意识流≈40s、红楼海棠（22 场）≈1–3 分钟。

### 验证测试（不消耗 key，走 fixture）
```bash
npm test            # vitest，288 passed | 3 skipped
npx tsc --noEmit    # 类型检查
```

---

## 在线部署到 Render（让评审零配置实测）

选 Render 是因为转换是 1–3 分钟的长流式任务（红楼 22 场、网文 24 场），Render 的常驻容器**没有单次请求时限**，四类示例都能跑完；而 serverless（如 Vercel 免费版 60s）会把长样本中途切断。

1. 把仓库推到 GitHub（已是）。
2. 登录 [render.com](https://render.com) → **New → Web Service** → 连接本仓库。
3. 配置：
   - **Runtime**：Node
   - **Build Command**：`npm install && npm run build`
   - **Start Command**：`npm start`
   - **Instance Type**：Free 即可
4. 在 **Environment Variables** 里加（对应本地的 `.env.local`）：
   - `LLM_BASE_URL` = `https://api.deepseek.com/v1`
   - `LLM_API_KEY` = `sk-你的key`
   - `LLM_MODEL` = `deepseek-chat`
5. **Create Web Service** → 拿到 `https://<服务名>.onrender.com`，填回本 README 顶部。

> - **冷启动**：免费实例闲置约 15 分钟后休眠，评审第一次打开需等 ~40s 唤醒，之后正常。给评审前自己先点一下预热。
> - **安全**：公开链接用的是**你的 key**，谁拿到链接点转换都消耗你的额度。评审窗口期短风险低；给完链接后可在 Render 控制台 Suspend 服务或轮换 key。
> - 也可用 **Vercel**，但需 **Pro 套餐（300s）** 才能跑完红楼/网文（免费 60s 会超时）。`maxDuration` 已在 `app/api/convert/route.ts` 设为 300，Pro 自动生效。

---

## 架构与设计文档

| 文档 | 内容 |
|---|---|
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | **剧本 YAML Schema 设计文档 + 七个设计决策的原因**（议题要求项） |
| [`docs/PROJECT.md`](docs/PROJECT.md) | 完整设计、架构总览、agent 角色分工、PR 路线图 |
| [`docs/DEVLOG.md`](docs/DEVLOG.md) | 逐 PR 实现纪实（踩坑 / 权衡 / 真数据逼出的修复） |

### Agent 的四种能力（本作品的展示主轴）
- **规划**：Orchestrator 编排各阶段顺序、驱动自纠重试循环。
- **记忆**：StoryBible 是跨章共享的只读快照，所有场景引用它 → 跨章一致性。
- **工具**：确定性的 Chunker（切分）+ Validator（zod + 引用完整性校验），不调模型、可单测。
- **自纠**：Validator + Critic 双层把关，不过则带具体错误反馈打回重写（最多 N 次）。

### YAML Schema 三个核心设计（详见 `docs/SCHEMA.md`）
- **id 引用而非内联**：改一处全局生效、可机器校验引用完整性、是 agent 跨章记忆的落点。
- **`elements` 有序异构列表**：剧本是线性时间流，固定字段表达不了「动作—对白—动作」的交错。
- **`source` 溯源字段**：每个场景记录来源章节/段落，支撑可信闭环。

---

## 内置示例（多体裁，均真端到端验证）

| 体裁 | 示例 | 重点考验 |
|---|---|---|
| 古典章回 | 《红楼梦》海棠诗社（第36–38回） | 旁白、视角切换、古汉语、大量别名 → 跨章一致性 |
| 现代网文 | 人生何处不青山 · 轮回秋日的信 | 心理活动、世界观铺陈、长篇连续叙事 |
| 散文 | 鲁迅《从百草园到三味书屋》 | 无明确冲突下自动提取可视化场景 |
| 意识流 | 《追忆似水年华》节选 | 内心活动 / 回忆 / 抽象思维 → 可拍场景 |

新增体裁：往 `samples/` 丢一个 `.txt` + 在 `lib/samples/manifest.ts` 加一行即可。

---

## 技术栈

Next.js 16（App Router）+ React 19 + TypeScript + Tailwind 4 全栈单仓；LLM 走 OpenAI 兼容抽象层（`lib/llm/client.ts`，可配可换）；`zod`（schema）+ `yaml`（序列化）+ `vitest`（测试）。API Route 用 **SSE** 流式推送 agent 进度。

## 项目结构
```
app/            # 前端 + API 路由（/api/convert SSE、/api/sample 示例）
  components/    # 输入区 / 时间线 / 剧本卡片 / YAML 视图 / 溯源弹层 / 导出
lib/
  llm/           # OpenAI 兼容 client（超时/重试/稳健 JSON 抽取）
  schema/        # zod schema + YAML 序列化（单一事实来源）
  agent/         # chunker / storyBible / sceneConverter / validator / critic / orchestrator
  client/        # 纯前端逻辑（SSE 解析 / 状态 reducer / 多文件拼接 / 溯源定位）
  samples/       # 内置示例清单
samples/         # 示例小说文本
docs/            # SCHEMA / PROJECT / DEVLOG / DEMO-SCRIPT
```
