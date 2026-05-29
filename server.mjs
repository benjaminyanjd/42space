import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

loadDotEnv();

const PORT = Number(process.env.PORT || 4242);
const HOST = process.env.HOST || "0.0.0.0";
const MARKETS_URL =
  process.env.MARKETS_URL ||
  "https://rest.ft.42.space/api/v1/markets?limit=100&order=created_at&ascending=false&status=all";
const LOCALIZED_MARKETS_URL = withLocale(MARKETS_URL, "zh");
const POLL_SECONDS = Number(process.env.WEB_POLL_SECONDS || 5);
const HISTORY_MINUTES = Number(process.env.HISTORY_MINUTES || 30);
const ALERT_WINDOW_MINUTES = Number(process.env.ALERT_WINDOW_MINUTES || 5);
const ALERT_COOLDOWN_MINUTES = Number(process.env.ALERT_COOLDOWN_MINUTES || 10);
const MIN_MARKET_CAP = Number(process.env.ALERT_MIN_MARKET_CAP || 20);
const ALERT_STATE_FILE = process.env.ALERT_STATE_FILE || "./42-alerts-state.json";
const PROFIT_LEADERBOARD_CACHE_FILE = process.env.PROFIT_LEADERBOARD_CACHE_FILE || "./42-profit-leaderboard-cache.json";
const PROFIT_MONITOR_STATE_FILE = process.env.PROFIT_MONITOR_STATE_FILE || "./42-profit-wallet-monitor-state.json";
const ANALYTICS_HISTORY_FILE = process.env.ANALYTICS_HISTORY_FILE || "./42-analytics-history.json";
const ANALYTICS_HISTORY_DAYS = Number(process.env.ANALYTICS_HISTORY_DAYS || 7);
const ANALYTICS_HISTORY_MIN_INTERVAL_SECONDS = Number(process.env.ANALYTICS_HISTORY_MIN_INTERVAL_SECONDS || 60);
const UNIQUE_TRADERS_CACHE_FILE = process.env.UNIQUE_TRADERS_CACHE_FILE || "./42-unique-traders-cache.json";
const UNIQUE_TRADERS_REFRESH_SECONDS = Number(process.env.UNIQUE_TRADERS_REFRESH_SECONDS || 120);
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";

const dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(dirname, "public");
const historyByMarket = new Map();
const profitWalletCache = new Map();
const profitLeaderboardCache = new Map();
const profitLeaderboardRefreshes = new Map();
const profitWalletMonitorState = loadProfitWalletMonitorState();
const profitWalletMonitorKnown = new Set(profitWalletMonitorState.knownPositions || []);
const profitWalletMonitorDetails = new Map(Object.entries(profitWalletMonitorState.knownPositionDetails || {}));
let profitWalletMonitorActivities = Array.isArray(profitWalletMonitorState.activities) ? profitWalletMonitorState.activities : [];
let profitWalletMonitorCache = null;
const seenMarketAddresses = new Set();
let hasBootstrappedMarkets = false;
let latestMarkets = [];
let recentAlerts = [];
let lastUpdatedAt = null;
let lastError = null;
let isPolling = false;
let alertState = loadAlertState();
recentAlerts = Array.isArray(alertState.recentAlerts) ? alertState.recentAlerts.slice(0, 200) : [];
let lastProfitLeaderboardPayload = loadProfitLeaderboardCache();
let analyticsHistory = loadAnalyticsHistory();
let uniqueTraderStats = loadUniqueTraderCache();
let uniqueTraderRefreshPromise = null;

function loadDotEnv() {
  if (!existsSync(".env")) return;

  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

function loadAlertState() {
  if (!existsSync(ALERT_STATE_FILE)) return { lastSentByKey: {}, recentAlerts: [] };
  try {
    const state = JSON.parse(readFileSync(ALERT_STATE_FILE, "utf8"));
    return {
      lastSentByKey: state.lastSentByKey && typeof state.lastSentByKey === "object" ? state.lastSentByKey : {},
      recentAlerts: Array.isArray(state.recentAlerts) ? state.recentAlerts.slice(0, 200) : []
    };
  } catch {
    return { lastSentByKey: {}, recentAlerts: [] };
  }
}

function saveAlertState() {
  alertState.recentAlerts = recentAlerts.slice(0, 200);
  writeFileSync(ALERT_STATE_FILE, `${JSON.stringify(alertState, null, 2)}\n`);
}

function loadProfitLeaderboardCache() {
  if (!existsSync(PROFIT_LEADERBOARD_CACHE_FILE)) return null;
  try {
    const payload = JSON.parse(readFileSync(PROFIT_LEADERBOARD_CACHE_FILE, "utf8"));
    return payload && Array.isArray(payload.wallets) ? payload : null;
  } catch {
    return null;
  }
}

function saveProfitLeaderboardCache(payload) {
  try {
    writeFileSync(PROFIT_LEADERBOARD_CACHE_FILE, `${JSON.stringify(payload)}\n`);
  } catch {
    // Disk cache is best-effort; in-memory cache still works.
  }
}

function loadProfitWalletMonitorState() {
  if (!existsSync(PROFIT_MONITOR_STATE_FILE)) return { knownPositions: [], knownPositionDetails: {}, activities: [] };
  try {
    const payload = JSON.parse(readFileSync(PROFIT_MONITOR_STATE_FILE, "utf8"));
    return {
      knownPositions: Array.isArray(payload.knownPositions) ? payload.knownPositions : [],
      knownPositionDetails: payload.knownPositionDetails && typeof payload.knownPositionDetails === "object" ? payload.knownPositionDetails : {},
      activities: validProfitMonitorActivities(Array.isArray(payload.activities) ? payload.activities : []).slice(0, 300)
    };
  } catch {
    return { knownPositions: [], knownPositionDetails: {}, activities: [] };
  }
}

function saveProfitWalletMonitorState() {
  try {
    writeFileSync(
      PROFIT_MONITOR_STATE_FILE,
      `${JSON.stringify({
        updatedAt: new Date().toISOString(),
        knownPositions: [...profitWalletMonitorKnown].slice(-5000),
        knownPositionDetails: Object.fromEntries([...profitWalletMonitorDetails.entries()].slice(-5000)),
        activities: validProfitMonitorActivities(profitWalletMonitorActivities).slice(0, 300)
      })}\n`
    );
  } catch {
    // Disk persistence is best-effort; in-memory monitor still works.
  }
}

function loadAnalyticsHistory() {
  if (!existsSync(ANALYTICS_HISTORY_FILE)) return [];
  try {
    const payload = JSON.parse(readFileSync(ANALYTICS_HISTORY_FILE, "utf8"));
    return Array.isArray(payload.points) ? payload.points.filter((point) => point && point.timestamp) : [];
  } catch {
    return [];
  }
}

function saveAnalyticsHistory() {
  try {
    writeFileSync(
      ANALYTICS_HISTORY_FILE,
      `${JSON.stringify({
        updatedAt: new Date().toISOString(),
        minIntervalSeconds: ANALYTICS_HISTORY_MIN_INTERVAL_SECONDS,
        retentionDays: ANALYTICS_HISTORY_DAYS,
        points: analyticsHistory
      })}\n`
    );
  } catch {
    // Analytics history is best-effort; live snapshot still works.
  }
}

function loadUniqueTraderCache() {
  if (!existsSync(UNIQUE_TRADERS_CACHE_FILE)) return null;
  try {
    const payload = JSON.parse(readFileSync(UNIQUE_TRADERS_CACHE_FILE, "utf8"));
    return payload && Number.isFinite(Number(payload.uniqueTraderCount)) ? payload : null;
  } catch {
    return null;
  }
}

function saveUniqueTraderCache(payload) {
  try {
    writeFileSync(UNIQUE_TRADERS_CACHE_FILE, `${JSON.stringify(payload)}\n`);
  } catch {
    // Unique trader scan is best-effort; live market snapshot still works.
  }
}

function shanghaiDayKey(timestampMs) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestampMs));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

async function fetchMarkets() {
  const response = await fetch(LOCALIZED_MARKETS_URL, {
    headers: {
      accept: "application/json",
      "user-agent": "fortytwo-event-dashboard/0.1"
    }
  });
  if (!response.ok) {
    throw new Error(`42 API HTTP ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  return Array.isArray(payload) ? payload : payload.data || [];
}

async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "fortytwo-event-dashboard/0.1"
      }
    });
    if (response.ok) return response.json();

    const body = await response.text();
    if (response.status !== 429 || attempt === 2) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
    }

    const retryAfter = Number(response.headers.get("retry-after") || 2);
    await sleep(Math.min(10, Math.max(2, retryAfter)) * 1000);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    .map((outcome) => Number(outcome.payout || 0))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const maxPayout = payouts[payouts.length - 1] || 0;
  const convexity = Math.min(1, maxPayout / 10);
  const categoryText = `${(market.categories || []).join(" ")} ${(market.tags || []).join(" ")}`.toLowerCase();
  const categoryBoost = /(crypto|bitcoin|btc|eth|binance|finance|sports|election|macro)/.test(categoryText) ? 1 : 0.4;
  return Math.round((0.35 * freshness + 0.25 * convexity + 0.2 * liquidity + 0.2 * categoryBoost) * 100);
}

function compactMarket(market) {
  return {
    address: market.address,
    question: localizeQuestion(market),
    sourceQuestion: market.question || "n/a",
    slug: market.slug || "",
    status: market.status || "n/a",
    createdAt: market.createdAt || null,
    startDate: market.startDate || null,
    endDate: market.endDate || null,
    resolutionTime: market.resolutionTime || null,
    categories: market.categories || [],
    subcategories: market.subcategories || [],
    tags: market.tags || [],
    collateralSymbol: market.collateralSymbol || "",
    totalMarketCap: Number(market.totalMarketCap || 0),
    volume: Number(market.volume || 0),
    traders: Number(market.traders || 0),
    score: scoreMarket(market),
    url: marketUrl(market),
    outcomes: (market.outcomes || []).map((outcome) => ({
      tokenId: String(outcome.tokenId ?? outcome.index ?? outcome.name),
      name: localizeOutcome(outcome),
      sourceName: outcome.name || outcome.symbol || `Outcome ${outcome.index ?? ""}`,
      price: Number(outcome.price || 0),
      payout: Number(outcome.payout || 0),
      volume: Number(outcome.volume || 0),
      marketCap: Number(outcome.marketCap || 0)
    }))
  };
}

async function profitWalletsForMarket(marketAddress) {
  const address = String(marketAddress || "").toLowerCase();
  const cached = profitWalletCache.get(address);
  if (cached && Date.now() - cached.timestamp < 60_000) return cached.payload;

  const market = latestMarkets.find((item) => item.address.toLowerCase() === address);
  if (!market) {
    return {
      marketAddress,
      generatedAt: new Date().toISOString(),
      error: "market_not_in_current_snapshot",
      wallets: []
    };
  }

  const rows = await collectProfitRowsForMarket(market);
  const payload = {
    marketAddress: market.address,
    question: market.question,
    generatedAt: new Date().toISOString(),
    wallets: rows,
    summary: {
      profitableWallets: rows.length,
      totalPositivePnl: rows.reduce((sum, wallet) => sum + wallet.totalPnl, 0),
      topWallet: rows[0]?.userAddress || null
    }
  };
  profitWalletCache.set(address, { timestamp: Date.now(), payload });
  return payload;
}

async function profitLeaderboard({ limit = 50, marketLimit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const safeMarketLimit = Math.min(Math.max(Number(marketLimit) || 100, 1), 100);
  const cacheKey = profitLeaderboardCacheKey(safeLimit, safeMarketLimit);
  const cached = profitLeaderboardCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 60_000) return normalizeProfitLeaderboardPayload(cached.payload, { safeLimit });

  const reusable = cached?.payload || lastProfitLeaderboardPayload;
  refreshProfitLeaderboardInBackground(cacheKey, safeLimit, safeMarketLimit);

  if (reusable) {
    return normalizeProfitLeaderboardPayload(reusable, { safeLimit, refreshing: true, stale: true });
  }

  return {
    generatedAt: new Date().toISOString(),
    marketCount: Math.min(latestMarkets.length, safeMarketLimit),
    scannedMarketCount: 0,
    skippedMarketCount: 0,
    walletCount: 0,
    wallets: [],
    summary: { totalPositivePnl: 0, topWallet: null, topPnl: 0 },
    errors: [],
    refreshing: true,
    stale: false,
    note: "Profit leaderboard is being built in the background."
  };
}

function profitLeaderboardCacheKey(safeLimit, safeMarketLimit) {
  return `${safeLimit}:${safeMarketLimit}:${latestMarkets.map((market) => market.address).join(",")}`;
}

function refreshProfitLeaderboardInBackground(cacheKey, safeLimit, safeMarketLimit) {
  if (profitLeaderboardRefreshes.has(cacheKey)) return;
  const refresh = computeProfitLeaderboard({ cacheKey, safeLimit, safeMarketLimit })
    .catch((error) => {
      console.error(`[${new Date().toISOString()}] profit leaderboard refresh failed: ${error.message}`);
    })
    .finally(() => {
      profitLeaderboardRefreshes.delete(cacheKey);
    });
  profitLeaderboardRefreshes.set(cacheKey, refresh);
}

function normalizeProfitLeaderboardPayload(payload, { safeLimit, refreshing = false, stale = false } = {}) {
  const wallets = (payload.wallets || []).slice(0, safeLimit || payload.wallets?.length || 0);
  return {
    ...payload,
    wallets,
    walletCount: wallets.length,
    summary: {
      ...(payload.summary || {}),
      totalPositivePnl: wallets.reduce((sum, wallet) => sum + Number(wallet.totalPnl || 0), 0),
      topWallet: wallets[0]?.userAddress || null,
      topPnl: wallets[0]?.totalPnl || 0
    },
    refreshing,
    stale
  };
}

async function computeProfitLeaderboard({ cacheKey, safeLimit, safeMarketLimit }) {
  const aggregate = new Map();
  const markets = latestMarkets.slice(0, safeMarketLimit);
  const errors = [];
  const concurrency = 1;

  for (let index = 0; index < markets.length; index += concurrency) {
    const batch = markets.slice(index, index + concurrency);
    const batchRows = await Promise.all(
      batch.map(async (market) => {
        try {
          return await collectProfitRowsForMarket(market, { includeLosers: true });
        } catch (error) {
          errors.push({ marketAddress: market.address, question: market.question, error: error.message });
          return [];
        }
      })
    );
    for (const rows of batchRows) {
      for (const row of rows) {
        const key = row.userAddress.toLowerCase();
        const current = aggregate.get(key) || {
          userAddress: row.userAddress,
          realizedPnl: 0,
          unrealizedPnl: 0,
          totalPnl: 0,
          costBasis: 0,
          currentValue: 0,
          heldQuantity: 0,
          marketCount: 0,
          outcomeCount: 0,
          positions: []
        };

        current.realizedPnl += row.realizedPnl;
        current.unrealizedPnl += row.unrealizedPnl;
        current.totalPnl += row.totalPnl;
        current.costBasis += row.costBasis;
        current.currentValue += row.currentValue;
        current.heldQuantity += row.heldQuantity;
        current.outcomeCount += row.outcomes.length;
        current.positions.push(...row.positions);
        aggregate.set(key, current);
      }
    }
    if (index + concurrency < markets.length) await sleep(250);
  }

  const rows = [...aggregate.values()]
    .map((wallet) => {
      const profitablePositions = wallet.positions.filter((position) => position.totalPnl > 0);
      const marketCount = new Set(wallet.positions.map((position) => position.marketAddress.toLowerCase())).size;
      const topPositions = [...profitablePositions].sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 5);
      return {
        ...wallet,
        marketCount,
        profitableMarketCount: new Set(profitablePositions.map((position) => position.marketAddress.toLowerCase())).size,
        topPositions,
        roi: wallet.costBasis > 0 ? (wallet.totalPnl / wallet.costBasis) * 100 : null,
        confidence:
          wallet.costBasis >= 500 && marketCount >= 3
            ? "high"
            : wallet.costBasis >= 100 || marketCount >= 2
              ? "medium"
              : "low"
      };
    })
    .filter((wallet) => wallet.totalPnl > 0)
    .sort((a, b) => b.totalPnl - a.totalPnl)
    .slice(0, safeLimit);

  const payload = {
    generatedAt: new Date().toISOString(),
    marketCount: markets.length,
    scannedMarketCount: markets.length - errors.length,
    skippedMarketCount: errors.length,
    walletCount: rows.length,
    wallets: rows,
    summary: {
      totalPositivePnl: rows.reduce((sum, wallet) => sum + wallet.totalPnl, 0),
      topWallet: rows[0]?.userAddress || null,
      topPnl: rows[0]?.totalPnl || 0
    },
    errors: errors.slice(0, 10),
    note: "This ranks current holders by realizedPnl + unrealizedPnl from 42 holders API; it is not full historical closed-trade PnL."
  };
  profitLeaderboardCache.set(cacheKey, { timestamp: Date.now(), payload });
  lastProfitLeaderboardPayload = payload;
  saveProfitLeaderboardCache(payload);
  return normalizeProfitLeaderboardPayload(payload, { safeLimit });
}

async function profitWalletMonitor({ force = false } = {}) {
  if (!force && profitWalletMonitorCache && Date.now() - profitWalletMonitorCache.timestamp < 60_000) {
    return profitWalletMonitorCache.payload;
  }

  const leaderboard = await profitLeaderboard({ limit: 30, marketLimit: 100 });
  const detectedAt = new Date().toISOString();
  const candidates = [];
  const currentKeys = new Set();
  const scannedWallets = new Set();

  for (const [walletIndex, wallet] of (leaderboard.wallets || []).entries()) {
    const walletAddress = String(wallet.userAddress || "").toLowerCase();
    if (walletAddress) scannedWallets.add(walletAddress);
    for (const position of wallet.positions || wallet.topPositions || []) {
      if (!position.marketAddress || Number(position.heldQuantity || 0) <= 0) continue;
      const key = profitMonitorPositionKey(wallet.userAddress, position);
      if (!key) continue;
      currentKeys.add(key);
      candidates.push({
        key,
        walletRank: walletIndex + 1,
        wallet,
        position
      });
    }
  }

  const isInitialBaseline = profitWalletMonitorKnown.size === 0;
  const activityItems = [];
  for (const { key, walletRank, wallet, position } of candidates) {
    profitWalletMonitorDetails.set(key, profitMonitorDetailSnapshot({ key, walletRank, wallet, position, action: "buy" }));
    if (profitWalletMonitorKnown.has(key)) continue;
    profitWalletMonitorKnown.add(key);
    if (isInitialBaseline) continue;
    activityItems.push(profitMonitorActivityFromDetail(profitWalletMonitorDetails.get(key), { action: "buy", detectedAt }));
  }

  if (!isInitialBaseline) {
    for (const key of [...profitWalletMonitorKnown]) {
      const walletAddress = key.split("|")[0];
      if (!scannedWallets.has(walletAddress) || currentKeys.has(key)) continue;
      const previous = profitWalletMonitorDetails.get(key);
      profitWalletMonitorKnown.delete(key);
      profitWalletMonitorDetails.delete(key);
      if (!isCompleteProfitMonitorDetail(previous)) continue;
      activityItems.push(profitMonitorActivityFromDetail(previous, { action: "sell", detectedAt }));
    }
  }

  if (activityItems.length) {
    const existing = new Set(profitWalletMonitorActivities.map((item) => item.id));
    profitWalletMonitorActivities = validProfitMonitorActivities([
      ...activityItems.filter((item) => !existing.has(item.id)),
      ...profitWalletMonitorActivities
    ]).slice(0, 300);
  }
  profitWalletMonitorActivities = validProfitMonitorActivities(profitWalletMonitorActivities).slice(0, 300);
  saveProfitWalletMonitorState();

  const payload = {
    generatedAt: leaderboard.generatedAt || detectedAt,
    scannedWalletCount: (leaderboard.wallets || []).length,
    knownPositionCount: profitWalletMonitorKnown.size,
    newActivityCount: activityItems.length,
    buyActivityCount: activityItems.filter((item) => item.action === "buy").length,
    sellActivityCount: activityItems.filter((item) => item.action === "sell").length,
    activities: validProfitMonitorActivities(profitWalletMonitorActivities),
    note: isInitialBaseline
      ? "Initial scan only builds the baseline; later scans report newly observed wallet-market-outcome holdings."
      : "Reports newly observed buy and sell/exited holdings among wallets that remain in the current top profitable wallet scan."
  };
  profitWalletMonitorCache = { timestamp: Date.now(), payload };
  return payload;
}

function profitMonitorPositionKey(walletAddress, position) {
  return [
    String(walletAddress || "").toLowerCase(),
    String(position.marketAddress || "").toLowerCase(),
    String(position.tokenId || position.outcomeName || position.name || "").toLowerCase()
  ].join("|");
}

function profitMonitorDetailSnapshot({ key, walletRank, wallet, position, action }) {
  return {
    key,
    action,
    wallet: wallet.userAddress,
    walletRank,
    marketAddress: position.marketAddress,
    question: position.question,
    url: position.url,
    outcomeName: position.outcomeName || position.name,
    tokenId: position.tokenId,
    heldQuantity: Number(position.heldQuantity || 0),
    currentValue: Number(position.currentValue || 0),
    currentPrice: Number(position.currentPrice || 0),
    walletTotalPnl: Number(wallet.totalPnl || 0),
    walletRoi: wallet.roi,
    updatedAt: new Date().toISOString()
  };
}

function profitMonitorActivityFromDetail(detail, { action, detectedAt }) {
  const safe = detail || {};
  return {
    id: `${safe.key || `${safe.wallet || "wallet"}|${safe.marketAddress || "market"}|${safe.outcomeName || "outcome"}`}:${action}:${detectedAt}`,
    action,
    wallet: safe.wallet,
    walletRank: safe.walletRank,
    marketAddress: safe.marketAddress,
    question: safe.question,
    url: safe.url,
    outcomeName: safe.outcomeName,
    tokenId: safe.tokenId,
    heldQuantity: Number(safe.heldQuantity || 0),
    currentValue: Number(safe.currentValue || 0),
    currentPrice: Number(safe.currentPrice || 0),
    walletTotalPnl: Number(safe.walletTotalPnl || 0),
    walletRoi: safe.walletRoi,
    detectedAt
  };
}

function validProfitMonitorActivities(items) {
  return (items || []).filter((item) => {
    if (!item || !item.id) return false;
    if (item.action !== "sell") return true;
    return (
      item.wallet &&
      item.marketAddress &&
      item.question &&
      item.outcomeName &&
      Number.isFinite(Number(item.walletRank)) &&
      Number(item.heldQuantity || 0) > 0 &&
      Number(item.currentValue || 0) > 0
    );
  });
}

function isCompleteProfitMonitorDetail(detail) {
  return Boolean(
    detail &&
      detail.wallet &&
      detail.marketAddress &&
      detail.question &&
      detail.outcomeName &&
      Number.isFinite(Number(detail.walletRank)) &&
      Number(detail.heldQuantity || 0) > 0 &&
      Number(detail.currentValue || 0) > 0
  );
}

async function collectProfitRowsForMarket(market, { includeLosers = false } = {}) {
  const wallets = new Map();
  for (const outcome of market.outcomes || []) {
    const holders = await fetchOutcomeHolders(market.address, outcome.tokenId);
    for (const holder of holders) {
      const userAddress = holder.userAddress;
      if (!userAddress) continue;
      const key = userAddress.toLowerCase();
      const current = wallets.get(key) || {
        userAddress,
        realizedPnl: 0,
        unrealizedPnl: 0,
        totalPnl: 0,
        costBasis: 0,
        currentValue: 0,
        heldQuantity: 0,
        outcomes: [],
        positions: []
      };

      const heldQuantity = Number(holder.heldQuantity || holder.mintedQuantity || 0);
      const avgPrice = Number(holder.avgPrice || 0);
      const currentPrice = Number(holder.currentPrice || 0);
      const realizedPnl = Number(holder.realizedPnl || 0);
      const unrealizedPnl = Number(holder.unrealizedPnl || 0);
      const costBasis = heldQuantity * avgPrice;
      const currentValue = heldQuantity * currentPrice;

      current.realizedPnl += realizedPnl;
      current.unrealizedPnl += unrealizedPnl;
      current.totalPnl += realizedPnl + unrealizedPnl;
      current.costBasis += costBasis;
      current.currentValue += currentValue;
      current.heldQuantity += heldQuantity;
      const position = {
        marketAddress: market.address,
        question: market.question,
        url: market.url,
        status: market.status,
        tokenId: outcome.tokenId,
        outcomeName: outcome.name,
        name: outcome.name,
        heldQuantity,
        avgPrice,
        currentPrice,
        realizedPnl,
        unrealizedPnl,
        totalPnl: realizedPnl + unrealizedPnl,
        costBasis,
        currentValue,
        roi: costBasis > 0 ? ((realizedPnl + unrealizedPnl) / costBasis) * 100 : null
      };
      current.outcomes.push(position);
      current.positions.push(position);
      wallets.set(key, current);
    }
  }

  const rows = [...wallets.values()]
    .map((wallet) => ({
      ...wallet,
      roi: wallet.costBasis > 0 ? (wallet.totalPnl / wallet.costBasis) * 100 : null,
      marketCount: 1,
      profitableMarketCount: wallet.totalPnl > 0 ? 1 : 0,
      topPositions: [...wallet.positions].filter((position) => position.totalPnl > 0).sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 5),
      confidence:
        wallet.costBasis >= 100 && wallet.outcomes.length >= 2
          ? "high"
          : wallet.costBasis >= 20
            ? "medium"
            : "low"
    }))
    .filter((wallet) => includeLosers || wallet.totalPnl > 0)
    .sort((a, b) => b.totalPnl - a.totalPnl);
  return includeLosers ? rows : rows.slice(0, 50);
}

async function fetchOutcomeHolders(marketAddress, tokenId) {
  const all = [];
  const limit = 100;
  for (let offset = 0; offset < 500; offset += limit) {
    const url = new URL("https://rest.ft.42.space/api/v1/market-data/holders");
    url.searchParams.set("market", marketAddress);
    url.searchParams.set("token_id", tokenId);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const payload = await fetchJson(url.toString());
    const data = Array.isArray(payload) ? payload : payload.data || [];
    all.push(...data);
    if (!payload.pagination?.hasMore || data.length < limit) break;
  }
  return all;
}

async function fetchMarketActivity(marketAddress) {
  const all = [];
  const limit = 100;
  for (let offset = 0; offset < 5000; offset += limit) {
    const url = new URL("https://rest.ft.42.space/api/v1/market-data/activity");
    url.searchParams.set("market", marketAddress);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const payload = await fetchJson(url.toString());
    const data = Array.isArray(payload) ? payload : payload.data || [];
    all.push(...data);
    if (!payload.pagination?.hasMore || data.length < limit) break;
  }
  return all;
}

function marketSetKey(markets) {
  return markets.map((market) => String(market.address || "").toLowerCase()).sort().join(",");
}

function isUniqueTraderCacheFresh(payload, markets) {
  if (!payload || !payload.generatedAt || payload.marketKey !== marketSetKey(markets)) return false;
  const ageMs = Date.now() - Date.parse(payload.generatedAt);
  return Number.isFinite(ageMs) && ageMs < UNIQUE_TRADERS_REFRESH_SECONDS * 1000;
}

async function computeUniqueTraderStats(markets) {
  const startedAt = Date.now();
  const uniqueWallets = new Set();
  const walletFirstSeen = new Map();
  const perMarket = [];
  const errors = [];
  let activityRows = 0;
  const marketTraderSum = markets.reduce((total, market) => total + Number(market.traders || 0), 0);

  for (const market of markets) {
    try {
      const activities = await fetchMarketActivity(market.address);
      activityRows += activities.length;
      const marketWallets = new Set();
      for (const activity of activities) {
        const address = String(activity.userAddress || "").toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(address)) continue;
        uniqueWallets.add(address);
        marketWallets.add(address);
        const rawTimestamp = Number(activity.timestamp || 0);
        const timestampMs = rawTimestamp > 1e12 ? rawTimestamp : rawTimestamp * 1000;
        if (Number.isFinite(timestampMs) && timestampMs > 0) {
          const currentFirstSeen = walletFirstSeen.get(address);
          if (!currentFirstSeen || timestampMs < currentFirstSeen) walletFirstSeen.set(address, timestampMs);
        }
      }
      perMarket.push({
        address: market.address,
        question: market.question,
        url: market.url,
        marketTraders: Number(market.traders || 0),
        uniqueTraderCount: marketWallets.size,
        activityRows: activities.length
      });
    } catch (error) {
      errors.push({
        address: market.address,
        question: market.question,
        error: error.message
      });
    }
    await sleep(120);
  }

  const dailyNewUniqueTraders = [...walletFirstSeen.values()]
    .reduce((rows, timestampMs) => {
      const date = shanghaiDayKey(timestampMs);
      rows.set(date, (rows.get(date) || 0) + 1);
      return rows;
    }, new Map());

  return {
    generatedAt: new Date().toISOString(),
    source: "42 market-data/activity userAddress dedupe",
    marketKey: marketSetKey(markets),
    marketCount: markets.length,
    scannedMarketCount: markets.length - errors.length,
    skippedMarketCount: errors.length,
    activityRows,
    uniqueTraderCount: uniqueWallets.size,
    marketTraderSum,
    repeatedTraderCount: Math.max(0, marketTraderSum - uniqueWallets.size),
    dailyNewUniqueTraders: [...dailyNewUniqueTraders.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    durationMs: Date.now() - startedAt,
    topMarkets: perMarket.sort((a, b) => b.uniqueTraderCount - a.uniqueTraderCount).slice(0, 12),
    errors: errors.slice(0, 10),
    note: "uniqueTraderCount dedupes userAddress across current markets from activity rows; marketTraderSum is the old per-market traders sum."
  };
}

function refreshUniqueTradersInBackground({ force = false } = {}) {
  if (!latestMarkets.length) return null;
  if (!force && isUniqueTraderCacheFresh(uniqueTraderStats, latestMarkets)) return uniqueTraderStats;
  if (uniqueTraderRefreshPromise) return uniqueTraderStats;

  const markets = latestMarkets.slice(0, 100);
  uniqueTraderRefreshPromise = computeUniqueTraderStats(markets)
    .then((payload) => {
      uniqueTraderStats = payload;
      saveUniqueTraderCache(payload);
      return payload;
    })
    .catch((error) => {
      uniqueTraderStats = {
        ...(uniqueTraderStats || {}),
        generatedAt: uniqueTraderStats?.generatedAt || null,
        lastErrorAt: new Date().toISOString(),
        error: error.message,
        marketKey: marketSetKey(markets)
      };
      return uniqueTraderStats;
    })
    .finally(() => {
      uniqueTraderRefreshPromise = null;
    });

  return uniqueTraderStats;
}

function uniqueTradersResponse({ force = false } = {}) {
  refreshUniqueTradersInBackground({ force });
  const scanning = Boolean(uniqueTraderRefreshPromise);
  return {
    scanning,
    refreshSeconds: UNIQUE_TRADERS_REFRESH_SECONDS,
    latestMarketCount: latestMarkets.length,
    stats: uniqueTraderStats && uniqueTraderStats.marketKey === marketSetKey(latestMarkets) ? uniqueTraderStats : null,
    staleStats: uniqueTraderStats || null
  };
}

function withLocale(url, locale) {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("locale")) {
    parsed.searchParams.set("locale", locale);
  }
  return parsed.toString();
}

function localizeQuestion(market) {
  const official = cleanOfficialTranslation(market.translation?.title);
  if (official) return official;

  let text = market.question || "n/a";
  text = text.replace(/\s+\?/g, "?").trim();

  const priceRange = text.match(/^([A-Z0-9/]+)\s+price range,\s+(.+?)\s+\((.+?)\)\?$/i);
  if (priceRange) {
    return `${priceRange[1].toUpperCase()} 价格区间，${localizeDateText(priceRange[2])}（${priceRange[3]}）？`;
  }

  const tweetCount = text.match(/^(.+?)\s+Tweet Count\s+\((.+?)\)\?$/i);
  if (tweetCount) {
    return `${tweetCount[1]} 推文数量（${localizeDateText(tweetCount[2])}）？`;
  }

  const futuresVolume = text.match(/^(.+?)\s+Futures Daily Volume,\s+(.+?)\?$/i);
  if (futuresVolume) {
    return `${futuresVolume[1]} 期货日成交量，${localizeDateText(futuresVolume[2])}？`;
  }

  const ranking = text.match(/^(.+?)'s ranking on Coingecko mCAP list by (.+?)\?$/i);
  if (ranking) {
    return `${ranking[1]} 在 CoinGecko 市值榜到 ${localizeDateText(ranking[2])} 的排名？`;
  }

  const appreciate = text.match(/^How much will (.+?) appreciate (?:by |following |after )(.+?)\?$/i);
  if (appreciate) {
    return `${localizeContext(appreciate[2])}后，${appreciate[1]} 会上涨多少？`;
  }

  return text
    .replace(/\bprice range\b/gi, "价格区间")
    .replace(/\bmarket cap\b/gi, "市值")
    .replace(/\bmCAP\b/g, "市值")
    .replace(/\bFDV\b/g, "FDV")
    .replace(/\bTweet Count\b/gi, "推文数量")
    .replace(/\bFutures Daily Volume\b/gi, "期货日成交量")
    .replace(/\bby Dec 31st 2026\b/gi, "到 2026年12月31日")
    .replace(/\bby June 30\b/gi, "到 6月30日")
    .replace(/\bWhich\b/gi, "哪个")
    .replace(/\bWinner\b/gi, "获胜者")
    .replace(/\?$/, "？");
}

function localizeOutcome(outcome) {
  const official = cleanOfficialTranslation(outcome.translation?.name);
  if (official && !official.includes("copy-")) return official;

  const source = outcome.name || outcome.symbol || `Outcome ${outcome.index ?? ""}`;
  return source
    .replace(/^Below\s+/i, "低于 ")
    .replace(/^Above\s+/i, "高于 ")
    .replace(/^Less than\s+/i, "低于 ")
    .replace(/^More than\s+/i, "高于 ")
    .replace(/\bYes\b/i, "是")
    .replace(/\bNo\b/i, "否")
    .replace(/\bUp\b/i, "上涨")
    .replace(/\bDown\b/i, "下跌");
}

function cleanOfficialTranslation(value) {
  if (!value) return "";
  const cleaned = String(value).replace(/^\[[a-z-]+\]\s*/i, "").trim();
  return /[\u4e00-\u9fff]/.test(cleaned) ? cleaned : "";
}

function localizeDateText(value) {
  return String(value)
    .replace(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d+)(st|nd|rd|th)?,\s*(\d{4})\b/gi, (_, month, day, _suffix, year) => `${year}年${monthToNumber(month)}月${day}日`)
    .replace(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d+)(st|nd|rd|th)?\s+(\d{4})\b/gi, (_, month, day, _suffix, year) => `${year}年${monthToNumber(month)}月${day}日`)
    .replace(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d+)(st|nd|rd|th)?\b/gi, (_, month, day) => `${monthToNumber(month)}月${day}日`)
    .replace(/\bJan(?:uary)?\b/gi, "1月")
    .replace(/\bFeb(?:ruary)?\b/gi, "2月")
    .replace(/\bMar(?:ch)?\b/gi, "3月")
    .replace(/\bApr(?:il)?\b/gi, "4月")
    .replace(/\bMay\b/gi, "5月")
    .replace(/\bJun(?:e)?\b/gi, "6月")
    .replace(/\bJul(?:y)?\b/gi, "7月")
    .replace(/\bAug(?:ust)?\b/gi, "8月")
    .replace(/\bSep(?:tember)?\b/gi, "9月")
    .replace(/\bOct(?:ober)?\b/gi, "10月")
    .replace(/\bNov(?:ember)?\b/gi, "11月")
    .replace(/\bDec(?:ember)?\b/gi, "12月")
    .replace(/(\d+)(st|nd|rd|th)/gi, "$1日")
    .replace(/月\s+/g, "月")
    .replace(/\s*-\s*/g, " - ");
}

function localizeContext(value) {
  return String(value)
    .replace(/Vitalik'?s post/gi, "Vitalik 发文")
    .replace(/CZ'?s post/gi, "CZ 发文")
    .replace(/Elon Musk'?s post/gi, "马斯克发文");
}

function monthToNumber(month) {
  const key = String(month).slice(0, 3).toLowerCase();
  return {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12
  }[key] || month;
}

function uniqueStatsForMarkets(markets) {
  return uniqueTraderStats && uniqueTraderStats.marketKey === marketSetKey(markets) ? uniqueTraderStats : null;
}

function analyticsPoint(markets, timestamp, alertCount = 0, previousPoint = null) {
  const uniqueStats = uniqueStatsForMarkets(markets);
  const point = {
    timestamp: new Date(timestamp).toISOString(),
    marketCount: markets.length,
    outcomeCount: 0,
    totalVolume: 0,
    totalMarketCap: 0,
    totalTraders: 0,
    alertCount,
    newMarketCount: 0,
    startingSoonCount: 0,
    endingSoonCount: 0,
    activeMarketCount: 0,
    volumeDelta: 0,
    traderDelta: 0,
    statusCounts: {},
    categoryCounts: {},
    categoryVolumes: {},
    categoryTraders: {},
    timeCounts: {}
  };

  for (const market of markets) {
    const status = market.status || "unknown";
    point.statusCounts[status] = (point.statusCounts[status] || 0) + 1;
    point.totalVolume += Number(market.volume || 0);
    point.totalMarketCap += Number(market.totalMarketCap || 0);
    point.totalTraders += Number(market.traders || 0);
    point.outcomeCount += Array.isArray(market.outcomes) ? market.outcomes.length : 0;
    if (Number(market.volume || 0) > 0 || Number(market.traders || 0) > 0) point.activeMarketCount += 1;
    if (isAnalyticsNewMarket(market, timestamp)) point.newMarketCount += 1;

    const categories = [...(market.categories || []), ...(market.subcategories || [])].filter(Boolean);
    for (const category of new Set(categories.length ? categories : ["未分类"])) {
      point.categoryCounts[category] = (point.categoryCounts[category] || 0) + 1;
      point.categoryVolumes[category] = (point.categoryVolumes[category] || 0) + Number(market.volume || 0);
      point.categoryTraders[category] = (point.categoryTraders[category] || 0) + Number(market.traders || 0);
    }

    const timeKey = analyticsTimeKey(market, timestamp);
    point.timeCounts[timeKey] = (point.timeCounts[timeKey] || 0) + 1;
    if (timeKey === "即将开始") point.startingSoonCount += 1;
    if (timeKey === "临近结束") point.endingSoonCount += 1;
  }

  point.marketTraderSum = point.totalTraders;
  if (uniqueStats) {
    point.totalTraders = Number(uniqueStats.uniqueTraderCount || 0);
    point.uniqueTraderCount = Number(uniqueStats.uniqueTraderCount || 0);
    point.uniqueTraderGeneratedAt = uniqueStats.generatedAt;
    point.uniqueTraderSource = uniqueStats.source;
  }

  if (previousPoint) {
    point.volumeDelta = Math.max(0, point.totalVolume - Number(previousPoint.totalVolume || 0));
    point.traderDelta = Math.max(0, point.totalTraders - Number(previousPoint.totalTraders || 0));
  }

  return point;
}

function isAnalyticsNewMarket(market, timestamp) {
  const createdAt = Date.parse(market.createdAt || "");
  return Number.isFinite(createdAt) && timestamp - createdAt >= 0 && timestamp - createdAt <= 30 * 60000;
}

function analyticsTimeKey(market, timestamp) {
  const status = String(market.status || "").toLowerCase();
  const createdAt = Date.parse(market.createdAt || "");
  const startAt = Date.parse(market.startDate || "");
  const endAt = Date.parse(market.endDate || market.resolutionTime || "");
  const minutesFromStart = Number.isFinite(startAt) ? (startAt - timestamp) / 60000 : Infinity;
  const minutesToEnd = Number.isFinite(endAt) ? (endAt - timestamp) / 60000 : Infinity;

  if (["resolved", "closed", "ended", "finalized", "cancelled"].includes(status)) return "已结束";
  if (Number.isFinite(endAt) && endAt <= timestamp) return "等待结算";
  if (Number.isFinite(endAt) && minutesToEnd <= 60 && minutesToEnd >= 0) return "临近结束";
  if (Number.isFinite(startAt) && minutesFromStart > 0 && minutesFromStart <= 60) return "即将开始";
  if (["live", "active", "open"].includes(status) || (Number.isFinite(startAt) && startAt <= timestamp && (!Number.isFinite(endAt) || endAt > timestamp))) return "进行中";
  if (Number.isFinite(createdAt) && timestamp - createdAt >= 0 && timestamp - createdAt <= 30 * 60000) return "新创建";
  return "其他";
}

function addAnalyticsHistory(markets, timestamp, alertCount = 0) {
  const lastPoint = analyticsHistory.at(-1);
  const intervalMs = Math.max(5, ANALYTICS_HISTORY_MIN_INTERVAL_SECONDS) * 1000;
  if (lastPoint && timestamp - Date.parse(lastPoint.timestamp) < intervalMs) return;

  analyticsHistory.push(analyticsPoint(markets, timestamp, alertCount, lastPoint));
  const cutoff = timestamp - ANALYTICS_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  analyticsHistory = analyticsHistory.filter((point) => Date.parse(point.timestamp) >= cutoff);
  saveAnalyticsHistory();
}

function snapshotMarket(market, timestamp) {
  return {
    timestamp,
    totalMarketCap: market.totalMarketCap,
    volume: market.volume,
    traders: market.traders,
    outcomes: Object.fromEntries(
      market.outcomes.map((outcome) => [
        outcome.tokenId,
        {
          name: outcome.name,
          price: outcome.price,
          volume: outcome.volume,
          marketCap: outcome.marketCap,
          payout: outcome.payout
        }
      ])
    )
  };
}

function addHistory(market, timestamp) {
  const key = market.address.toLowerCase();
  const list = historyByMarket.get(key) || [];
  list.push(snapshotMarket(market, timestamp));

  const cutoff = timestamp - HISTORY_MINUTES * 60_000;
  while (list.length && list[0].timestamp < cutoff) list.shift();
  historyByMarket.set(key, list);
}

function baselineSnapshot(market, timestamp) {
  const list = historyByMarket.get(market.address.toLowerCase()) || [];
  const target = timestamp - ALERT_WINDOW_MINUTES * 60_000;
  let baseline = null;
  for (const item of list) {
    if (item.timestamp <= target) baseline = item;
    else break;
  }
  return baseline;
}

function pctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function addAlert(candidates, market, type, metric, changePct, previous, current, outcome = null) {
  candidates.push({
    id: `${Date.now()}-${market.address}-${type}-${metric}-${outcome?.tokenId || "market"}`,
    key: `${type}:${metric}:${market.address.toLowerCase()}:${outcome?.tokenId || "market"}`,
    type,
    metric,
    changePct,
    previous,
    current,
    marketAddress: market.address,
    question: market.question,
    status: market.status,
    score: market.score,
    url: market.url,
    outcome,
    createdAt: new Date().toISOString()
  });
}

function detectNewMarketAlerts(markets) {
  const candidates = [];
  for (const market of markets) {
    const key = market.address.toLowerCase();
    if (seenMarketAddresses.has(key)) continue;
    seenMarketAddresses.add(key);
    if (!hasBootstrappedMarkets) continue;

    candidates.push({
      id: `${Date.now()}-${market.address}-newMarket`,
      key: `newMarket:${key}`,
      type: "market",
      metric: "newMarket",
      changePct: 0,
      previous: 0,
      current: market.totalMarketCap,
      marketAddress: market.address,
      question: market.question,
      status: market.status,
      score: market.score,
      url: market.url,
      outcome: null,
      createdAt: new Date().toISOString()
    });
  }
  hasBootstrappedMarkets = true;
  return candidates;
}

function detectStartingSoonAlerts(markets, timestamp) {
  const candidates = [];
  for (const market of markets) {
    const status = String(market.status || "").toLowerCase();
    if (["resolved", "finalised", "finalized", "ended", "closed", "cancelled", "canceled"].includes(status)) continue;

    const startAt = Date.parse(market.startDate || "");
    if (!Number.isFinite(startAt)) continue;

    const minutesFromStart = (startAt - timestamp) / 60000;
    if (minutesFromStart <= 0 || minutesFromStart > 60) continue;

    const key = market.address.toLowerCase();
    candidates.push({
      id: `${Date.now()}-${market.address}-startingSoon`,
      key: `startingSoon:${key}:${new Date(startAt).toISOString()}`,
      type: "market",
      metric: "startingSoon",
      changePct: 0,
      previous: 60,
      current: Math.max(0, Math.ceil(minutesFromStart)),
      startDate: new Date(startAt).toISOString(),
      marketAddress: market.address,
      question: market.question,
      status: market.status,
      score: market.score,
      url: market.url,
      outcome: null,
      createdAt: new Date().toISOString()
    });
  }
  return candidates;
}

function detectAlerts(market, baseline) {
  const candidates = [];
  if (!baseline) return candidates;
  if (market.totalMarketCap < MIN_MARKET_CAP && market.volume < MIN_MARKET_CAP) return candidates;

  const marketCapChange = pctChange(market.totalMarketCap, baseline.totalMarketCap);
  if (marketCapChange !== null && marketCapChange >= 30) {
    addAlert(candidates, market, "market", "totalMarketCap", marketCapChange, baseline.totalMarketCap, market.totalMarketCap);
  }

  const volumeChange = pctChange(market.volume, baseline.volume);
  if (volumeChange !== null && volumeChange >= 50) {
    addAlert(candidates, market, "market", "volume", volumeChange, baseline.volume, market.volume);
  }

  const traderIncrease = market.traders - baseline.traders;
  if (traderIncrease >= 5) {
    addAlert(candidates, market, "market", "traders", traderIncrease, baseline.traders, market.traders);
  }

  for (const outcome of market.outcomes) {
    const before = baseline.outcomes[outcome.tokenId];
    if (!before) continue;

    const outcomeMarketCapChange = pctChange(outcome.marketCap, before.marketCap);
    if (outcomeMarketCapChange !== null && outcomeMarketCapChange >= 40 && outcome.marketCap >= MIN_MARKET_CAP) {
      addAlert(candidates, market, "outcome", "marketCap", outcomeMarketCapChange, before.marketCap, outcome.marketCap, outcome);
    }

    const outcomeVolumeChange = pctChange(outcome.volume, before.volume);
    if (outcomeVolumeChange !== null && outcomeVolumeChange >= 50 && outcome.volume >= MIN_MARKET_CAP) {
      addAlert(candidates, market, "outcome", "volume", outcomeVolumeChange, before.volume, outcome.volume, outcome);
    }

    const outcomePriceChange = pctChange(outcome.price, before.price);
    if (outcomePriceChange !== null && outcomePriceChange >= 25 && outcome.marketCap >= MIN_MARKET_CAP) {
      addAlert(candidates, market, "outcome", "price", outcomePriceChange, before.price, outcome.price, outcome);
    }
  }

  return candidates;
}

function isAlertAllowed(alert, timestamp) {
  const lastSent = alertState.lastSentByKey[alert.key];
  if (!lastSent) return true;
  if (alert.metric === "startingSoon") return false;
  return timestamp - new Date(lastSent).getTime() >= ALERT_COOLDOWN_MINUTES * 60_000;
}

async function sendTelegram(alert) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

  const text = [
    `42 事件战壕提醒：${metricDisplayName(alert.metric)}`,
    ``,
    `标的：${alert.question}`,
    alert.outcome ? `Outcome：${alert.outcome.name}` : null,
    `变化：${formatTelegramChange(alert)}`,
    `评分：${alert.score}/100`,
    `链接：${alert.url}`
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
  }
  console.log(`[${new Date().toISOString()}] Telegram alert sent: ${alert.key}`);
}

function metricDisplayName(metric) {
  return {
    newMarket: "新标的上线",
    startingSoon: "新事件即将上线",
    totalMarketCap: "市值拉升",
    marketCap: "Outcome 市值拉升",
    volume: "成交放量",
    price: "价格拉升",
    traders: "交易者增加"
  }[metric] || metric;
}

function formatTelegramChange(alert) {
  if (alert.metric === "newMarket") {
    return `初始市值 ${formatCompactMoney(alert.current)}`;
  }

  if (alert.metric === "startingSoon") {
    return `${formatNumber(alert.current)} 分钟后开始`;
  }

  if (alert.metric === "traders") {
    return `+${formatNumber(alert.changePct)} 人，${formatNumber(alert.previous)} -> ${formatNumber(alert.current)}`;
  }

  const delta = Number(alert.current || 0) - Number(alert.previous || 0);
  const pct = Number.isFinite(alert.changePct) ? `+${alert.changePct.toFixed(1)}%` : "";
  const formatter = alert.metric === "price" ? formatNumber : formatCompactMoney;
  return `${pct}，+${formatter(delta)}，${formatter(alert.previous)} -> ${formatter(alert.current)}`;
}

function formatCompactMoney(value) {
  const number = Number(value || 0);
  const abs = Math.abs(number);
  if (abs >= 1_000_000) return `${trimNumber(number / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimNumber(number / 1_000)}K`;
  return trimNumber(number);
}

function trimNumber(value) {
  const abs = Math.abs(Number(value || 0));
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  });
}

async function handleAlerts(candidates, timestamp) {
  for (const alert of candidates) {
    if (!isAlertAllowed(alert, timestamp)) continue;

    alertState.lastSentByKey[alert.key] = new Date(timestamp).toISOString();
    recentAlerts.unshift(alert);
    recentAlerts = recentAlerts.slice(0, 200);
    saveAlertState();

    try {
      await sendTelegram(alert);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Telegram alert failed: ${error.message}`);
    }
  }
}

async function poll() {
  if (isPolling) return;
  isPolling = true;
  const timestamp = Date.now();

  try {
    const rawMarkets = await fetchMarkets();
    const compacted = rawMarkets.map(compactMarket);
    const alertCandidates = [
      ...detectNewMarketAlerts(compacted),
      ...detectStartingSoonAlerts(compacted, timestamp)
    ];

    for (const market of compacted) {
      const baseline = baselineSnapshot(market, timestamp);
      alertCandidates.push(...detectAlerts(market, baseline));
      addHistory(market, timestamp);
    }

    latestMarkets = compacted;
    lastUpdatedAt = new Date(timestamp).toISOString();
    lastError = null;
    await handleAlerts(alertCandidates, timestamp);
    refreshUniqueTradersInBackground();
    addAnalyticsHistory(compacted, timestamp, alertCandidates.length);
    console.log(`[${lastUpdatedAt}] markets=${latestMarkets.length} alerts=${alertCandidates.length}`);
  } catch (error) {
    lastError = `${error.message}`;
    console.error(`[${new Date().toISOString()}] poll failed: ${error.stack || error.message}`);
  } finally {
    isPolling = false;
  }
}

function stats() {
  const statusCounts = {};
  let totalVolume = 0;
  let totalMarketCap = 0;
  let latestCreatedAt = null;

  for (const market of latestMarkets) {
    statusCounts[market.status] = (statusCounts[market.status] || 0) + 1;
    totalVolume += market.volume;
    totalMarketCap += market.totalMarketCap;
    if (!latestCreatedAt || new Date(market.createdAt || 0) > new Date(latestCreatedAt)) {
      latestCreatedAt = market.createdAt;
    }
  }

  return {
    count: latestMarkets.length,
    statusCounts,
    totalVolume,
    totalMarketCap,
    latestCreatedAt
  };
}

function snapshotResponse() {
  const alertMarketKeys = new Set(recentAlerts.slice(0, 50).map((alert) => alert.marketAddress.toLowerCase()));
  return {
    lastUpdatedAt,
    lastError,
    config: {
      pollSeconds: POLL_SECONDS,
      alertWindowMinutes: ALERT_WINDOW_MINUTES,
      alertCooldownMinutes: ALERT_COOLDOWN_MINUTES,
      minMarketCap: MIN_MARKET_CAP,
      telegramConfigured: Boolean(TG_BOT_TOKEN && TG_CHAT_ID)
    },
    stats: stats(),
    uniqueTraders: uniqueTradersResponse(),
    alerts: recentAlerts.slice(0, 80),
    markets: latestMarkets.map((market) => ({
      ...market,
      hasRecentAlert: alertMarketKeys.has(market.address.toLowerCase())
    }))
  };
}

function analyticsHistoryResponse(range = "day") {
  const now = Date.now();
  const windowMs = range === "week" ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const cutoff = now - windowMs;
  let points = analyticsHistory.filter((point) => Date.parse(point.timestamp) >= cutoff);

  if (!points.length && latestMarkets.length) {
    points = [analyticsPoint(latestMarkets, now, recentAlerts.length, analyticsHistory.at(-1) || null)];
  }

  if (points.length && latestMarkets.length) {
    const lastPoint = points.at(-1);
    const lastTimestamp = Date.parse(lastPoint.timestamp);
    if (!lastPoint.categoryVolumes || now - lastTimestamp > POLL_SECONDS * 1000) {
      points = [...points, analyticsPoint(latestMarkets, now, recentAlerts.length, lastPoint)];
    }
  }

  points = points.map(enrichAnalyticsHistoryPoint);

  return {
    range: range === "week" ? "week" : "day",
    generatedAt: new Date(now).toISOString(),
    retentionDays: ANALYTICS_HISTORY_DAYS,
    minIntervalSeconds: ANALYTICS_HISTORY_MIN_INTERVAL_SECONDS,
    pointCount: points.length,
    points,
    latest: points.at(-1) || null
  };
}

function enrichAnalyticsHistoryPoint(point) {
  return {
    ...point,
    newMarketCount: Number(point.newMarketCount ?? point.timeCounts?.["新创建"] ?? 0),
    startingSoonCount: Number(point.startingSoonCount ?? point.timeCounts?.["即将开始"] ?? 0),
    endingSoonCount: Number(point.endingSoonCount ?? point.timeCounts?.["临近结束"] ?? 0),
    activeMarketCount: Number(point.activeMarketCount ?? point.marketCount ?? 0),
    alertCount: Number(point.alertCount ?? 0),
    volumeDelta: Number(point.volumeDelta ?? 0),
    traderDelta: Number(point.traderDelta ?? 0)
  };
}

function formatNumber(value) {
  const number = Number(value || 0);
  if (Math.abs(number) >= 1000) return number.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(number) >= 1) return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return number.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function stripAppBasePath(pathname) {
  if (pathname === "/42event") return "/";
  if (pathname.startsWith("/42event/")) return pathname.slice("/42event".length) || "/";
  return pathname;
}

function redirect(res, location) {
  res.writeHead(308, {
    location,
    "cache-control": "no-store"
  });
  res.end();
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/42event") {
    redirect(res, "/42event/");
    return;
  }
  const pathname = stripAppBasePath(url.pathname);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const relativeRequest = requested.replace(/^[/\\]+/, "");
  const filePath = resolve(publicDir, relativeRequest);
  const publicRoot = resolve(publicDir);

  if ((filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8"
  };

  res.writeHead(200, {
    "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  res.end(readFileSync(filePath));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/42event") {
    redirect(res, "/42event/");
    return;
  }

  const routePath = stripAppBasePath(url.pathname);
  if (routePath === "/api/health") {
    json(res, lastError ? 503 : 200, {
      ok: !lastError,
      lastUpdatedAt,
      lastError,
      markets: latestMarkets.length,
      telegramConfigured: Boolean(TG_BOT_TOKEN && TG_CHAT_ID)
    });
    return;
  }

  if (routePath === "/api/snapshot" || routePath === "/api/markets") {
    json(res, 200, snapshotResponse());
    return;
  }

  if (routePath === "/api/analytics-history") {
    json(res, 200, analyticsHistoryResponse(url.searchParams.get("range") || "day"));
    return;
  }

  if (routePath === "/api/unique-traders") {
    json(res, 200, uniqueTradersResponse({ force: url.searchParams.get("force") === "1" }));
    return;
  }

  if (routePath === "/api/profit-leaderboard") {
    profitLeaderboard({
      limit: url.searchParams.get("limit") || 50,
      marketLimit: url.searchParams.get("marketLimit") || 100
    })
      .then((payload) => json(res, 200, payload))
      .catch((error) => json(res, 500, { error: error.message }));
    return;
  }

  if (routePath === "/api/profit-wallet-monitor") {
    profitWalletMonitor({ force: url.searchParams.get("force") === "1" })
      .then((payload) => json(res, 200, payload))
      .catch((error) => json(res, 500, { error: error.message }));
    return;
  }

  if (routePath === "/api/profit-wallets") {
    const market = url.searchParams.get("market");
    if (!market || !/^0x[a-fA-F0-9]{40}$/.test(market)) {
      json(res, 400, { error: "valid market query parameter is required" });
      return;
    }

    profitWalletsForMarket(market)
      .then((payload) => json(res, payload.error ? 404 : 200, payload))
      .catch((error) => json(res, 500, { error: error.message }));
    return;
  }

  serveStatic(req, res);
});

await poll();
setInterval(poll, POLL_SECONDS * 1000);

server.listen(PORT, HOST, () => {
  console.log(`42 dashboard listening on http://${HOST}:${PORT}`);
});
