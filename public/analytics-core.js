export const TIME_LABELS = {
  new: "新创建",
  startingSoon: "即将开始",
  live: "进行中",
  endingSoon: "临近结束",
  waitingResolution: "等待结算",
  ended: "已结束",
  other: "其他"
};

export function analyzeMarkets(markets = [], now = Date.now(), uniqueTraderStats = null) {
  const nowMs = toTimestamp(now);
  const safeMarkets = markets.filter(Boolean);
  const enrichedMarkets = safeMarkets.map((market) => enrichMarket(market, nowMs));
  const outcomes = enrichedMarkets.flatMap((market) =>
    (market.outcomes || []).map((outcome) => ({
      ...outcome,
      market,
      payoutNumber: toNumber(outcome.payout),
      volumeNumber: toNumber(outcome.volume),
      marketCapNumber: toNumber(outcome.marketCap)
    }))
  );

  const marketTraderSum = sum(enrichedMarkets, "tradersNumber");
  const hasUniqueTraderCount = Number.isFinite(Number(uniqueTraderStats?.uniqueTraderCount));
  const totals = {
    marketCount: enrichedMarkets.length,
    liveCount: enrichedMarkets.filter((market) => ["live", "active", "open"].includes(String(market.status || "").toLowerCase())).length,
    newCount: enrichedMarkets.filter((market) => market.isNew).length,
    endingSoonCount: enrichedMarkets.filter((market) => market.timeType.key === "endingSoon").length,
    alertCount: enrichedMarkets.filter((market) => market.hasRecentAlert).length,
    outcomeCount: outcomes.length,
    totalVolume: sum(enrichedMarkets, "volumeNumber"),
    totalMarketCap: sum(enrichedMarkets, "marketCapNumber"),
    totalTraders: hasUniqueTraderCount ? Number(uniqueTraderStats.uniqueTraderCount) : marketTraderSum,
    uniqueTraderCount: hasUniqueTraderCount ? Number(uniqueTraderStats.uniqueTraderCount) : null,
    marketTraderSum,
    uniqueTraderSource: hasUniqueTraderCount ? uniqueTraderStats.source || "activity userAddress dedupe" : null,
    uniqueTraderGeneratedAt: hasUniqueTraderCount ? uniqueTraderStats.generatedAt || null : null,
    averageScore: average(enrichedMarkets.map((market) => market.scoreNumber))
  };

  return {
    generatedAt: new Date(nowMs).toISOString(),
    totals,
    distributions: {
      status: countBy(enrichedMarkets, (market) => statusLabel(market.status)),
      time: countBy(enrichedMarkets, (market) => market.timeType.key, (key) => TIME_LABELS[key] || key),
      category: countBy(enrichedMarkets, categoryKeysForMarket),
      collateral: countBy(enrichedMarkets, (market) => market.collateralSymbol || "未知"),
      outcomeCount: countBy(enrichedMarkets, (market) => outcomeBucket((market.outcomes || []).length))
    },
    rankings: {
      volume: topBy(enrichedMarkets, "volumeNumber", 12),
      marketCap: topBy(enrichedMarkets, "marketCapNumber", 12),
      traders: topBy(enrichedMarkets, "tradersNumber", 12),
      score: topBy(enrichedMarkets, "scoreNumber", 12),
      payoutOutcomes: outcomes
        .filter((outcome) => outcome.payoutNumber > 0)
        .sort((a, b) => b.payoutNumber - a.payoutNumber || b.volumeNumber - a.volumeNumber)
        .slice(0, 15),
      activeOutcomes: outcomes
        .filter((outcome) => outcome.volumeNumber > 0 || outcome.marketCapNumber > 0)
        .sort((a, b) => b.volumeNumber + b.marketCapNumber - (a.volumeNumber + a.marketCapNumber))
        .slice(0, 15)
    },
    flags: {
      thinLiquidity: enrichedMarkets
        .filter((market) => market.volumeNumber >= 1000 && market.tradersNumber <= 5)
        .sort((a, b) => b.volumeNumber - a.volumeNumber)
        .slice(0, 12),
      concentratedOutcome: enrichedMarkets
        .map((market) => ({ ...market, concentration: outcomeConcentration(market) }))
        .filter((market) => market.marketCapNumber >= 100 && market.concentration >= 0.65)
        .sort((a, b) => b.concentration - a.concentration || b.marketCapNumber - a.marketCapNumber)
        .slice(0, 12),
      newWithFlow: enrichedMarkets
        .filter((market) => market.isNew && (market.volumeNumber >= 300 || market.tradersNumber >= 5))
        .sort((a, b) => b.volumeNumber - a.volumeNumber)
        .slice(0, 12),
      endingSoon: enrichedMarkets
        .filter((market) => market.timeType.key === "endingSoon")
        .sort((a, b) => a.minutesToEnd - b.minutesToEnd)
        .slice(0, 12),
      hotAlerts: enrichedMarkets
        .filter((market) => market.hasRecentAlert)
        .sort((a, b) => b.volumeNumber - a.volumeNumber)
        .slice(0, 12),
      highPayoutOutcomes: outcomes
        .filter((outcome) => outcome.payoutNumber >= 0.3 && outcome.volumeNumber >= 100)
        .sort((a, b) => b.payoutNumber * b.volumeNumber - a.payoutNumber * a.volumeNumber)
        .slice(0, 12)
    }
  };
}

export function classifyMarketTime(market, now = Date.now()) {
  const nowMs = toTimestamp(now);
  const status = String(market?.status || "").toLowerCase();
  const createdAt = toTimestamp(market?.createdAt);
  const startAt = toTimestamp(market?.startDate);
  const endAt = toTimestamp(market?.endDate || market?.resolutionTime);
  const minutesFromStart = Number.isFinite(startAt) ? (startAt - nowMs) / 60000 : Infinity;
  const minutesToEnd = Number.isFinite(endAt) ? (endAt - nowMs) / 60000 : Infinity;

  if (["resolved", "closed", "ended", "finalized", "cancelled"].includes(status)) return { key: "ended", label: TIME_LABELS.ended };
  if (Number.isFinite(endAt) && endAt <= nowMs) return { key: "waitingResolution", label: TIME_LABELS.waitingResolution };
  if (Number.isFinite(endAt) && minutesToEnd <= 60 && minutesToEnd >= 0) return { key: "endingSoon", label: TIME_LABELS.endingSoon };
  if (Number.isFinite(startAt) && minutesFromStart > 0 && minutesFromStart <= 60) return { key: "startingSoon", label: TIME_LABELS.startingSoon };
  if (["live", "active", "open"].includes(status) || (Number.isFinite(startAt) && startAt <= nowMs && (!Number.isFinite(endAt) || endAt > nowMs))) return { key: "live", label: TIME_LABELS.live };
  if (Number.isFinite(createdAt) && nowMs - createdAt <= 30 * 60000) return { key: "new", label: TIME_LABELS.new };
  return { key: "other", label: TIME_LABELS.other };
}

export function isNewMarket(market, now = Date.now(), windowMinutes = 30) {
  const createdAt = toTimestamp(market?.createdAt);
  const nowMs = toTimestamp(now);
  return Number.isFinite(createdAt) && nowMs - createdAt >= 0 && nowMs - createdAt <= windowMinutes * 60000;
}

export function formatCompactNumber(value) {
  const number = toNumber(value);
  const abs = Math.abs(number);
  if (abs >= 1_000_000_000) return `${trimNumber(number / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trimNumber(number / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimNumber(number / 1_000)}K`;
  return trimNumber(number);
}

export function formatPercent(value, digits = 1) {
  const number = toNumber(value);
  return `${number.toFixed(digits)}%`;
}

function enrichMarket(market, nowMs) {
  const timeType = classifyMarketTime(market, nowMs);
  const endAt = toTimestamp(market.endDate || market.resolutionTime);
  return {
    ...market,
    timeType,
    isNew: isNewMarket(market, nowMs),
    volumeNumber: toNumber(market.volume),
    marketCapNumber: toNumber(market.totalMarketCap),
    tradersNumber: toNumber(market.traders),
    scoreNumber: toNumber(market.score),
    minutesToEnd: Number.isFinite(endAt) ? Math.max(0, Math.round((endAt - nowMs) / 60000)) : Infinity
  };
}

function categoryKeysForMarket(market) {
  const values = [...(market.categories || []), ...(market.subcategories || [])].filter(Boolean);
  return [...new Set(values.length ? values : ["未分类"])];
}

function countBy(items, keyGetter, labelGetter = (key) => key) {
  const map = new Map();
  for (const item of items) {
    const rawKeys = keyGetter(item);
    const keys = Array.isArray(rawKeys) ? rawKeys : [rawKeys];
    for (const key of keys.filter(Boolean)) {
      const label = labelGetter(key);
      const current = map.get(key) || { key, label, count: 0 };
      current.count += 1;
      map.set(key, current);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
}

function statusLabel(status) {
  const value = String(status || "未知");
  const normalized = value.toLowerCase();
  return {
    live: "进行中",
    active: "进行中",
    open: "进行中",
    upcoming: "未开始",
    pending: "未开始",
    resolved: "已结算",
    closed: "已关闭"
  }[normalized] || value;
}

function outcomeBucket(count) {
  if (count <= 2) return "1-2 个 Outcome";
  if (count <= 5) return "3-5 个 Outcome";
  if (count <= 10) return "6-10 个 Outcome";
  return "10+ 个 Outcome";
}

function outcomeConcentration(market) {
  const total = toNumber(market.totalMarketCap);
  if (!total) return 0;
  const maxOutcome = Math.max(0, ...(market.outcomes || []).map((outcome) => toNumber(outcome.marketCap)));
  return maxOutcome / total;
}

function topBy(items, key, limit) {
  return [...items].sort((a, b) => toNumber(b[key]) - toNumber(a[key])).slice(0, limit);
}

function sum(items, key) {
  return items.reduce((total, item) => total + toNumber(item[key]), 0);
}

function average(values) {
  const valid = values.map(toNumber).filter((value) => Number.isFinite(value));
  if (!valid.length) return 0;
  return valid.reduce((total, value) => total + value, 0) / valid.length;
}

function trimNumber(value) {
  const number = toNumber(value);
  const abs = Math.abs(number);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return number.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : NaN;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
