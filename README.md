# 42 Event Rush Monitor

42 事件战壕机会雷达，用于实时监控 42.space 事件市场的新标的、即将开始事件、成交/市值/价格/交易者异动、盈利钱包行为和全市场数据结构。

线上示例路径：

- 首页机会雷达：`/42event/`
- 数据分析页：`/42event/analytics.html`
- 盈利钱包总榜：`/42event/profit.html`

## 核心功能

- 实时市场监控：默认每 5 秒拉取一次 42 市场快照。
- 异动提醒：监控新标的、即将开始事件、成交量拉升、市值拉升、Outcome 价格拉升、交易者增加。
- 最近异动流：页面右侧累计展示，不随刷新丢失。
- Telegram 推送：服务端命中异动后推送到配置的 Telegram bot/chat。
- 浏览器提醒：支持页面 toast、浏览器通知和约 3 秒连续声音警报。
- 盈利钱包总榜：扫描市场 holder/PnL，按总收益、ROI、成本、当前价值展示。
- 盈利钱包监控：监控 Top 盈利钱包的新买入和卖出/退出行为。
- 数据分析页：展示核心指标、唯一交易者日新增、每日成交量、成交增长来源、具体标的成交占比、状态/时间窗口/类别结构。

## 页面说明

### 首页 `/42event/`

首页用于实盘盯盘，核心区域包括：

- 顶部统计卡片：全部标的、有异动、新创建、临近结束、盈利钱包榜单入口、数据分析入口。
- 筛选器：关键词、状态、类别、时间类型。
- 左侧盈利钱包监控：展示盈利钱包新买入/卖出事件。
- 中间标的列表：按时间窗口分组，卡片展示成交量、市值、交易者、最高赔率和 Outcome 明细。
- 右侧最近异动：累计显示服务端产生的告警。

### 数据分析页 `/42event/analytics.html`

用于看全市场结构和趋势：

- 全市场核心指标：标的数、进行中数量、总成交量、总市值、唯一交易者、Outcome 数量、平均评分、异动标的。
- 唯一交易者日新增柱状图：按钱包首次出现日期统计。
- 每日成交量柱状图：按天聚合全市场成交量。
- 成交增长来源饼图：按过去 24 小时成交增长来源分类。
- 具体标的成交占比饼图：按具体预测话题成交量统计，不按分类。
- 结构分布：状态、时间窗口、类别、结算币种、Outcome 数量。
- 异常与机会清单：少数人主导、Outcome 集中、新标的、临近结束、高赔率。

### 盈利钱包页 `/42event/profit.html`

用于单独扫描和查看全市场盈利钱包：

- 扫描当前可见市场的 holders 和 PnL。
- 按已实现 + 未实现 PnL 排序。
- 展示钱包地址、总盈利、ROI、成本、当前价值、主要盈利标的。
- API 限流时会显示已成功扫描的数据，并自动重试。

## 通知规则

服务端会把命中的告警写入最近异动，并尝试推送 Telegram。

| 类型 | metric | 触发规则 |
| --- | --- | --- |
| 新标的上线 | `newMarket` | 服务启动完成后，新出现的市场地址 |
| 新事件即将上线 | `startingSoon` | `startDate` 进入未来 60 分钟内，且状态不是 `resolved/finalised/ended/closed/cancelled` |
| 总市值拉升 | `totalMarketCap` | 5 分钟窗口内市场总市值上涨 >= 30% |
| Outcome 市值拉升 | `marketCap` | 5 分钟窗口内 Outcome 市值上涨 >= 40%，且市值达到阈值 |
| 成交放量 | `volume` | 5 分钟窗口内成交量上涨 >= 50%，且成交量达到阈值 |
| 价格拉升 | `price` | 5 分钟窗口内 Outcome 价格上涨 >= 25%，且市值达到阈值 |
| 交易者增加 | `traders` | 5 分钟窗口内交易者增加 >= 5 人 |

默认阈值可通过环境变量调整。

## 环境要求

- Node.js >= 18
- 可访问 `https://rest.ft.42.space`
- 如需 Telegram 推送，需要 Telegram bot token 和 chat id

## 安装与运行

```bash
npm install
npm run web
```

项目没有强依赖构建步骤，服务直接运行 `server.mjs`，默认监听：

```text
HOST=0.0.0.0
PORT=4242
```

访问：

```text
http://localhost:4242/42event/
http://localhost:4242/42event/analytics.html
http://localhost:4242/42event/profit.html
```

## 环境变量

复制 `.env.example` 为 `.env`：

```bash
cp .env.example .env
```

常用配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `4242` | Web 服务端口 |
| `HOST` | `0.0.0.0` | Web 服务监听地址 |
| `WEB_POLL_SECONDS` | `5` | 市场快照刷新间隔 |
| `HISTORY_MINUTES` | `30` | 内存短期历史保留分钟数 |
| `ALERT_WINDOW_MINUTES` | `5` | 异动对比窗口 |
| `ALERT_COOLDOWN_MINUTES` | `10` | 同一异动冷却时间 |
| `ALERT_MIN_MARKET_CAP` | `20` | 告警最低市值/成交阈值 |
| `TG_BOT_TOKEN` | 空 | Telegram bot token |
| `TG_CHAT_ID` | 空 | Telegram chat id |
| `ANALYTICS_HISTORY_DAYS` | `7` | 分析页历史保留天数 |
| `UNIQUE_TRADERS_REFRESH_SECONDS` | `120` | 唯一交易者后台刷新间隔 |

`.env` 不要提交到 GitHub。

## 数据文件

运行时会生成这些本地状态文件：

| 文件 | 作用 |
| --- | --- |
| `42-alerts-state.json` | 告警发送状态和最近异动持久化 |
| `42-analytics-history.json` | 分析页历史点 |
| `42-profit-leaderboard-cache.json` | 盈利钱包榜单缓存 |
| `42-profit-wallet-monitor-state.json` | 盈利钱包监控基线和事件 |
| `42-unique-traders-cache.json` | 唯一交易者缓存 |

这些文件是运行态数据，已通过 `.gitignore` 排除，不应提交。

## API

| 路径 | 说明 |
| --- | --- |
| `/42event/api/health` | 服务健康状态 |
| `/42event/api/snapshot` | 首页市场快照、最近异动、统计数据 |
| `/42event/api/analytics-history?range=day` | 分析页日图历史 |
| `/42event/api/analytics-history?range=week` | 分析页周图历史 |
| `/42event/api/unique-traders` | 唯一交易者后台扫描结果 |
| `/42event/api/profit-leaderboard` | 盈利钱包总榜 |
| `/42event/api/profit-wallet-monitor` | 盈利钱包买入/卖出监控 |
| `/42event/api/profit-wallets?market=0x...` | 单市场盈利钱包 |

## 部署建议

### 直接运行

```bash
npm run web
```

### Windows 后台运行

可以使用 `run-dashboard.ps1` 或任务计划程序启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\run-dashboard.ps1
```

### 反向代理

如果部署在域名子路径，例如：

```text
https://example.com/42event/
```

服务端已经支持 `/42event` base path。反向代理需要把 `/42event/*` 转发到 Node 服务。

## 本地检查

```bash
npm run check
node --check public/app.js
node --check public/analytics.js
node --check public/profit.js
node analytics-core.test.mjs
```

## 安全注意事项

- 不要提交 `.env`，里面可能包含 Telegram token。
- 不要提交 `42-*.json`，这些是运行状态、缓存和监控历史。
- 不要提交日志、zip、`node_modules`。
- GitHub 仓库只应包含源码、静态资源、脚本、测试和 `.env.example`。

## 目录结构

```text
.
├── server.mjs                    # Web 服务、API、告警检测、Telegram 推送
├── monitor-42-events.mjs          # 早期命令行监控脚本
├── analytics-core.test.mjs        # 分析核心逻辑测试
├── package.json
├── .env.example
├── public/
│   ├── index.html                 # 首页
│   ├── app.js                     # 首页交互、提醒、筛选、盈利钱包监控
│   ├── analytics.html             # 数据分析页
│   ├── analytics.js               # 数据分析页渲染
│   ├── analytics-core.js          # 数据分析核心逻辑
│   ├── profit.html                # 盈利钱包总榜页
│   ├── profit.js                  # 盈利钱包页交互
│   └── styles.css                 # 全站样式
└── docs/
    └── superpowers/plans/         # 开发计划文档
```

## 当前边界

- 数据来源依赖 42.space 公开 API；如果上游限流或返回异常，页面会降级显示已有数据。
- 盈利钱包榜单扫描成本较高，遇到 HTTP 429 会重试并展示已成功扫描的数据。
- 唯一交易者统计依赖 activity 明细，后台缓存刷新，不保证每秒实时。
- 浏览器弹窗通知取决于用户浏览器权限；权限被拒绝时仍会保留页面内提醒和声音提醒。
