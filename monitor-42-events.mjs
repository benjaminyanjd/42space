import { existsSync, readFileSync, writeFileSync } from "node:fs";

loadDotEnv();

const MARKETS_URL =
  process.env.MARKETS_URL ||
  "https://rest.ft.42.space/api/v1/markets?limit=100&order=created_at&ascending=false&status=all";

const STATE_FILE = process.env.STATE_FILE || "./42-events-state.json";
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 45);
const SEND_INITIAL = process.env.SEND_INITIAL === "1";
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";
const ONCE = process.argv.includes("--once");

function loadDotEnv() {
  if (!existsSync(".env")) return;

  const lines = readFileSync(".env", "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { seen: {}, bootstrapped: false };
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "fortytwo-new-event-monitor/0.1"
    }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchMarkets() {
  const payload = await fetchJson(MARKETS_URL);
  return Array.isArray(payload) ? payload : payload.data || [];
}

function marketUrl(market) {
  const text = `${market.question || ""} ${(market.categories || []).join(" ")} ${(market.tags || []).join(" ")}`.toLowerCase();
  const path = text.includes("price") || text.includes("range") ? "live" : "event";
  return `https://www.42.space/${path}/${market.address}`;
}

function scoreMarket(market) {
  const createdAt = market.createdAt ? new Date(market.createdAt).getTime() : Date.now();
  const ageMinutes = Math.max(0, (Date.now() - createdAt) / 60000);
  const freshness = Math.max(0, 1 - ageMinutes / 60);
  const liquidity = Math.min(1, Math.log10(Number(market.totalMarketCap || market.volume || 0) + 1) / 4);
  const payouts = (market.outcomes || [])
    .map((o) => Number(o.payout || 0))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const maxPayout = payouts[payouts.length - 1] || 0;
  const convexity = Math.min(1, maxPayout / 10);
  const categoryText = `${(market.categories || []).join(" ")} ${(market.tags || []).join(" ")}`.toLowerCase();
  const categoryBoost = /(crypto|bitcoin|btc|eth|binance|finance|sports|election|macro)/.test(categoryText) ? 1 : 0.4;
  return Math.round((0.35 * freshness + 0.25 * convexity + 0.2 * liquidity + 0.2 * categoryBoost) * 100);
}

function formatMarket(market) {
  const outcomes = (market.outcomes || [])
    .slice(0, 8)
    .map((o) => {
      const payout = Number(o.payout || 0);
      const price = Number(o.price || 0);
      return `- ${o.name}: payout ${payout ? payout.toFixed(3) : "n/a"}, price ${price ? price.toFixed(6) : "n/a"}`;
    })
    .join("\n");

  return [
    `42 新事件 / 市场`,
    ``,
    `问题: ${market.question || "n/a"}`,
    `地址: ${market.address}`,
    `状态: ${market.status || "n/a"}`,
    `创建: ${market.createdAt || "n/a"}`,
    `开始: ${market.startDate || "n/a"}`,
    `结束: ${market.endDate || "n/a"}`,
    `结算: ${market.resolutionTime || "n/a"}`,
    `类别: ${(market.categories || []).join(", ") || "n/a"}`,
    `交易者: ${market.traders ?? "n/a"}`,
    `Volume: ${market.volume ?? "n/a"} ${market.collateralSymbol || ""}`,
    `MCap: ${market.totalMarketCap ?? "n/a"} ${market.collateralSymbol || ""}`,
    `监控评分: ${scoreMarket(market)}/100`,
    ``,
    `Outcomes:`,
    outcomes || "- n/a",
    ``,
    `链接: ${marketUrl(market)}`
  ].join("\n");
}

async function notify(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log("\n--- notification preview ---\n" + text + "\n--- end ---\n");
    return;
  }

  const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      disable_web_page_preview: true
    })
  });
  if (!res.ok) {
    throw new Error(`Telegram HTTP ${res.status}: ${await res.text()}`);
  }
}

async function tick() {
  const state = loadState();
  const markets = await fetchMarkets();
  const fresh = [];

  for (const market of markets) {
    if (!market.address) continue;
    const key = market.address.toLowerCase();
    if (!state.seen[key]) {
      state.seen[key] = {
        question: market.question || "",
        createdAt: market.createdAt || null,
        firstSeenAt: new Date().toISOString()
      };
      fresh.push(market);
    }
  }

  const shouldNotify = state.bootstrapped || SEND_INITIAL;
  state.bootstrapped = true;
  saveState(state);

  if (!shouldNotify) {
    console.log(`baseline saved: ${Object.keys(state.seen).length} markets, no notifications sent`);
    return;
  }

  fresh.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  for (const market of fresh) {
    await notify(formatMarket(market));
  }
  console.log(`checked ${markets.length} markets, new=${fresh.length}`);
}

async function main() {
  do {
    try {
      await tick();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ${error.stack || error.message}`);
    }

    if (ONCE) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
  } while (true);
}

await main();
