# 42 Event Rush Monitor

42 事件战壕机会雷达，用于实时监控新事件、即将开始事件、成交/市值/价格/交易者异动、盈利钱包监控和数据分析。

## 功能

- 实时拉取 42 事件市场数据
- 最近异动累计展示，支持浏览器提醒、声音提醒和 Telegram 推送
- 新标的上线与新事件即将上线通知
- 盈利钱包总榜与盈利钱包新买入/卖出监控
- 数据分析页：核心指标、唯一交易者日新增、每日成交量、成交增长来源、具体标的成交占比

## 运行

```bash
npm run web
```

默认监听 `0.0.0.0:4242`，页面路径：

- `/42event/`
- `/42event/analytics.html`
- `/42event/profit.html`

## 配置

复制 `.env.example` 为 `.env`，按需填写：

```bash
TG_BOT_TOKEN=
TG_CHAT_ID=
WEB_POLL_SECONDS=5
```

不要提交 `.env`、运行状态 JSON、日志和打包文件。
