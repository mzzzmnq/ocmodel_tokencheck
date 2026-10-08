# tokencheck · OpenCode Go 额度监控

本地 Web 仪表盘，用来盯住 **OpenCode Go 订阅里每个模型各自的额度消耗**。

```
npm start          # 或 node --experimental-sqlite src/server.mjs
→ http://127.0.0.1:7788/
```

零依赖：只用 Node 内置模块（`node:http`、`node:sqlite`）和原生前端，不需要 `npm install`。

---

## 为什么需要它

OpenCode Go 的额度是**按模型**给的（每个模型一个月度美元上限，$15 / $30 / $60 不等），
并且分成 5 小时滚动 / 每周 / 每月三档。但官方用量接口

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_GO_API_KEY>
→ {"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"..."},
            "weekly":{"status":"ok","percent":3,"resetsAt":"..."},
            "monthly":{"status":"ok","percent":36,"resetsAt":"..."}}}
```

只返回**账户级聚合百分比**，文档也说明额度详情要去 console 看。它没有任何按模型的拆分，
`?model=`、`/usage/models`、`/quota`、`/limits` 都不存在（实测 404 或返回同一份聚合数据）。

所以本工具把两个数据源拼起来：

| 数据源 | 提供什么 | 精度 |
| --- | --- | --- |
| 官方 `/v1/usage` | 账户 5 小时 / 每周 / 每月百分比、重置时间、限流状态 | 官方权威 |
| 本地 opencode 库 | **按模型**的 token、费用、调用次数、峰谷时段 | 每次调用精确记账 |

本地这一层不是估算：opencode 在 `~/.local/share/opencode/opencode.db` 的
`session_message` 表里，为每条 assistant 消息都记录了当时的模型、完整 token 分解
（`input` / `output` / `reasoning` / `cache.read` / `cache.write`）以及它自己算出的 `cost`。
tokencheck 按官方价格表逐条复算，并用 opencode 自己记录的 cost 做交叉校验。

## 准确性验证

```
npm run calibrate
```

复算结果（本机 322 条 OpenCode Go 调用）：

```
DeepSeek V4.1 Flash  调用 322  记录 $0.417309  复算 $0.731767
完全一致 60 条 · 仅因峰谷加价不同 262 条 · 无法解释 0 条 · 未收录价格 0 条
```

**0 条无法解释的偏差**，说明价格表（含分档、缓存价、峰谷价）能精确复现计费规则。

那 262 条差异不是 bug：DeepSeek 模型在 Go 文档里是峰谷双价（UTC 周一至周五
01:00–04:00 与 06:00–10:00 为高峰，价格翻倍），而 **opencode 自己记录的 cost 恒用平价单价**——
它读取的 models.dev 定价表（provider `opencode-go`）只有一档价格、没有"时段"维度，算不出峰谷。

因此本工具以**官方峰谷口径为主**（进度条、消耗、汇总、日图都用它），
同时把 opencode 记录值（平价）作为对照并列显示，不做静默取舍。界面对这类模型标「峰谷价」标签。

## 界面说明

- **官方额度窗口**：三个环形进度，直接来自官方接口，含重置倒计时和 `rate-limited` 状态。
- **各模型额度消耗**：按 5 小时 / 本周 / 本月 / 全部切换。进度条 = 该模型本窗口消耗 ÷
  **该窗口自己的上限**（月额度的 20% / 50% / 100%），所以一个被 5 小时上限卡住的模型
  不会因为月度数字还好看而被藏起来。超 70% 变黄、90% 变红。消耗按**官方峰谷口径**计；
  峰谷价模型会在模型名下方并列显示 opencode 记录值（平价口径）作对照。
  加载时会**自动切到压力最大的那个窗口**，手动点过之后就交给你。
- **模型覆盖**：点右上角「模型覆盖」，或直接打开 `/`**`?coverage=1`**。把官方在售模型、
  本工具价格表、本机实际用过的模型三方对齐，列出每个模型的 5 小时 / 每周 / 每月上限，
  并标出「在用」「未收录价格」「已下架」「峰谷价」——用它一眼看出哪些开销**没被计价**。
- **每日消耗图**：近 14 天按天汇总，没有记录的日子补零，横轴不跳日期。
- **汇总**：跟随当前所选窗口，另附累计值。
- **最近调用**：逐条明细，便于核对。
- **套餐切换**：Go（$10/月）与 Go Plus（$40/月）。文档只给出 Go 的各模型月额度，
  并说明 Go Plus 是"更高的用量上限"；本工具按 2× 换算，切换会即时重算所有窗口上限。
- **API key**：默认自动从 opencode 自己的凭据库读取，正常情况无需任何配置。
- 深链：`?win=monthly` 固定计费窗口。

## 覆盖缺口（实测）

官方 `/v1/models` 当前在售 **43** 个模型，文档的价格表只覆盖其中 **31** 个。差额 13 个
模型可以调用、却没有任何公开价格可查：

```
deepseek-flash  glm-5  glm-5.1  grok-4.5  hy3-preview  kimi-k2.5  mimo-v2-omni
mimo-v2-pro  minimax-m2.5  omen-alpha  qwen3.5-plus  qwen3.6-plus  qwen3.7-max
```

它们会被统计 token 与调用次数，但**费用不计入估算**，界面标为「未收录价格」。
反过来 `claude-haiku-5-5` 有官方价格、却不在当前在售列表里，界面标为「已下架」。

`npm run smoke` 会把这份清单与实时目录对比，上游增删模型时直接报错，
避免价格表悄悄过期。

## 额度规则

每个模型的额度是它**自己**的月度上限，并分成三档（文档原文：5-hour — 20% of the monthly
limit; weekly — 50%; monthly — 100%），所以三类窗口都可能先被顶到：

| 窗口 | 上限 | 对齐方式 |
| --- | --- | --- |
| 5 小时滚动 | 月额度 × 20% | 从现在往前 5 小时 |
| 每周 | 月额度 × 50% | 每周一 00:00 UTC 重置 |
| 每月 | 月额度 × 100% | 每月 1 日 00:00 UTC 重置 |

每周/每月的重置时刻与官方 `resetsAt` 实测一致（周一 00:00 UTC、月初 00:00 UTC）。

## 配置

API key 解析顺序：

1. `TOKENCHECK_API_KEY` 环境变量
2. 本工具的配置文件（界面里「API key」按钮可写入），Windows 在
   `%APPDATA%\tokencheck\config.json`，其他平台在 `~/.config/tokencheck/config.json`
3. opencode 凭据库（`credential` 表中 `integration_id` 以 `opencode` 开头的活动条目）

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TOKENCHECK_PORT` | `7788` | 监听端口 |
| `TOKENCHECK_HOST` | `127.0.0.1` | 监听地址 |
| `TOKENCHECK_DB` | `~/.local/share/opencode/opencode.db` | opencode 数据库路径 |
| `TOKENCHECK_API_KEY` | 未设置 | 覆盖自动发现的 API key |
| `TOKENCHECK_USAGE_URL` | `https://opencode.ai/zen/go/v1/usage` | 官方用量接口地址 |
| `TOKENCHECK_MODELS_URL` | `https://opencode.ai/zen/go/v1/models` | 官方在售模型目录 |
| `TOKENCHECK_CACHE_MS` | `60000` | 官方用量接口缓存时长 |
| `TOKENCHECK_CATALOG_MS` | `86400000` | 模型目录缓存时长（24 小时） |

命令行参数：`--port=7788 --host=127.0.0.1 --db=<path> --plan=plus`。

## HTTP 接口

| 路由 | 说明 |
| --- | --- |
| `GET /api/usage[?plan=go\|plus&force=1]` | 官方额度 + 本地按模型统计 + 最近调用 |
| `GET /api/coverage[?plan=&force=1]` | 在售模型 × 价格表 × 本机用量，含各窗口上限与缺口警告 |
| `GET /api/models` | 内置价格表（各模型分档、月额度、窗口规则、峰谷标记） |
| `GET /api/catalog[?force=1]` | 官方在售模型 id 列表 |
| `GET /api/key` / `POST /api/key` | 查看 / 保存 API key（`{"apiKey":"oc_sk_..."}`，空串即清除） |
| `POST /api/refresh` | 清缓存并强制刷新官方用量与目录 |
| `GET /api/health` | 健康检查 |

## 目录结构

```
src/pricing.mjs   OpenCode Go 价格表与额度表、分档选择、峰谷判定、计费窗口
src/stats.mjs     读取 opencode SQLite，按模型 × 计费窗口聚合
src/official.mjs  官方 /v1/usage 与 /v1/models 客户端、API key 发现与配置存储
src/coverage.mjs  在售模型 / 价格表 / 本机用量 三方覆盖对齐
src/server.mjs    零依赖 HTTP 服务与静态资源
public/           仪表盘前端（index.html / styles.css / app.js）
tools/calibrate.mjs  用 opencode 自身记录的 cost 校验价格表
tools/smoke.mjs      HTTP 端到端检查（隔离实例）
test/                node:test 用例（含合成数据库夹具与假 DOM 渲染）
start.cmd / start.sh 一键启动
```

## 测试

```
npm test        # 37 个单元/渲染用例
npm run smoke   # 起一个隔离实例，跑 28 项 HTTP 端到端检查
npm run calibrate
```

单元测试覆盖价格分档与边界、缓存写价、峰谷窗口边界（含周末）、月额度与 Go Plus 换算、
三档窗口上限（20%/50%/100%）与嵌套单调性、计费窗口对齐、按模型聚合、token 累加、
错误调用标记、日汇总补零、缺库报错、非法套餐、覆盖报告的四类模型划分与目录不可用降级、
以及渲染崩溃时报错而不是留下空白页；外加一个最小假 DOM 直接渲染 `public/app.js`，
断言环形进度、模型表格、汇总卡片、日图、调用明细、最紧窗口自动选择、覆盖面板、
`?coverage=1` / `?win=` 深链都真的生效。

## 启动脚本

- Windows：双击 `start.cmd`
- macOS / Linux：`./start.sh`

两者都会先检查 Node，再启动服务并尝试打开浏览器。

`smoke` 会在 `7799` 端口起一个独立实例（配置目录指向临时目录、`TOKENCHECK_API_KEY` 清空），
验证健康检查、`/api/usage` 的套餐参数、`/api/models` 的窗口规则、`/api/catalog`、
`/api/coverage` 的合并结果与"不给未定价模型编造上限"、key 的读写与清除、非法 JSON、
未知路由、路径穿越防护、响应不泄露完整 API key，以及 `KNOWN_UNPRICED` 是否仍与实时目录一致。

## 已知限制

- 官方百分比是账户级聚合，**无法按模型拆分**。界面里每个模型的百分比来自本地记账
  （本窗口消耗 ÷ 该窗口上限），与官方账户百分比不是同一个分母，仅供横向比较。
- 本地统计只覆盖**这台机器**上 opencode 产生的调用。在别的机器/客户端上用的量不会出现在
  按模型的表格里，但会计入官方账户百分比。
- 未在官方 Go 文档价格表里出现的模型（`omen-alpha`、`grok-4.5` 等 13 个）标为
  「未收录价格」，只统计 token 与调用次数，不做费用估算。
- opencode 自己记录的 `cost` 不含峰谷加价（其 models.dev 定价表没有时段维度），所以高峰时段的
  DeepSeek 调用，记录值会低于官方计费。本工具主口径用官方峰谷价，并把记录值并列显示。
- Go Plus 的各模型额度官方未公布具体数字，本工具按 Go 的 2× 推算，属于估计值。
- 价格表源自 <https://opencode.ai/docs/go/>，官方调整价格后需同步 `src/pricing.mjs`，
  并用 `npm run calibrate` 复验。
- 需要 Node ≥ 22.5（`node:sqlite`）。Node 22 需 `--experimental-sqlite`，Node 24+ 可直接运行。
