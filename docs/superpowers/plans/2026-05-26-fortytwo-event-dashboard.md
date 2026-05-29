# FortyTwo Event Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a realtime web dashboard for 42 event markets and notify when a market or outcome has a clear short-window rise.

**Architecture:** A single Node HTTP service polls the 42 REST API every 5 seconds, stores 30 minutes of in-memory history, detects 5-minute market/outcome increases, persists alert cooldowns, sends Telegram notifications, and serves a static dashboard. The browser consumes `/api/snapshot` and renders filters, cards, and recent alerts.

**Tech Stack:** Node.js 18+ built-ins only, HTML/CSS/vanilla JavaScript, Telegram Bot API.

---

### Task 1: Realtime Poller And Alert Engine

**Files:**
- Create: `server.mjs`
- Create: `42-alerts-state.json` at runtime

- [ ] Create a Node server that loads `.env`, polls `MARKETS_URL`, keeps current markets, and serves JSON endpoints.
- [ ] Keep a per-market 30-minute history with market-level and outcome-level values.
- [ ] Compare current values against the closest snapshot from at least 4 minutes ago.
- [ ] Trigger alerts for market cap, volume, trader, outcome market cap, outcome volume, and outcome price increases.
- [ ] Enforce a 10-minute cooldown per alert key and persist cooldown state to `42-alerts-state.json`.

### Task 2: Dashboard Frontend

**Files:**
- Create: `public/index.html`
- Create: `public/app.js`
- Create: `public/styles.css`

- [ ] Render top stats, recent alerts, and market cards from `/api/snapshot`.
- [ ] Add filters for status, category, keyword, and minimum score.
- [ ] Auto-refresh every 5 seconds.
- [ ] Highlight markets that have recent alerts.
- [ ] Show outcome price, payout, volume, and market cap.

### Task 3: Package Scripts And Verification

**Files:**
- Modify: `package.json`
- Modify: `.env.example`

- [ ] Add `web` and `web:once` scripts.
- [ ] Add dashboard/alert threshold environment examples.
- [ ] Verify `node --check server.mjs`.
- [ ] Verify `/api/health` and `/api/snapshot` return live 42 data.
- [ ] Open the local dashboard and confirm the page renders real market cards.

### Task 4: Remote Deployment

**Files:**
- Remote path: `C:\Users\Administrator\fortytwo-new-event-monitor`

- [ ] Upload changed files to DESKTOP-JC145FQ.
- [ ] Run `npm install` and `node --check server.mjs` remotely.
- [ ] Create or update a scheduled task for the dashboard service.
- [ ] Verify the remote node process exists and `/api/health` returns live status.
