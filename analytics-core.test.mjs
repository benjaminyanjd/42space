import assert from "node:assert/strict";
import {
  analyzeMarkets,
  classifyMarketTime,
  formatCompactNumber
} from "./public/analytics-core.js";

const now = Date.parse("2026-05-27T08:00:00Z");
const markets = [
  {
    address: "0xaaa",
    question: "BTC price?",
    status: "live",
    createdAt: "2026-05-27T07:45:00Z",
    startDate: "2026-05-27T07:00:00Z",
    endDate: "2026-05-27T08:30:00Z",
    categories: ["Price"],
    subcategories: ["Crypto"],
    collateralSymbol: "USDT",
    totalMarketCap: 1200,
    volume: 1800,
    traders: 3,
    score: 42,
    hasRecentAlert: true,
    outcomes: [
      { name: "Up", payout: 0.66, volume: 1400, marketCap: 1000 },
      { name: "Down", payout: 0.12, volume: 400, marketCap: 200 }
    ]
  },
  {
    address: "0xbbb",
    question: "BNB volume?",
    status: "upcoming",
    createdAt: "2026-05-27T05:00:00Z",
    startDate: "2026-05-27T08:20:00Z",
    endDate: "2026-05-27T12:00:00Z",
    categories: ["Crypto"],
    subcategories: ["Binance"],
    collateralSymbol: "USDT",
    totalMarketCap: 450,
    volume: 450,
    traders: 12,
    score: 31,
    outcomes: [
      { name: "$150M - $300M", payout: 0.2, volume: 300, marketCap: 300 },
      { name: "$300M - $450M", payout: 0.05, volume: 150, marketCap: 150 }
    ]
  }
];

assert.equal(classifyMarketTime(markets[0], now).key, "endingSoon");
assert.equal(classifyMarketTime(markets[1], now).key, "startingSoon");

const analysis = analyzeMarkets(markets, now);
assert.equal(analysis.totals.marketCount, 2);
assert.equal(analysis.totals.outcomeCount, 4);
assert.equal(analysis.totals.totalVolume, 2250);
assert.equal(analysis.totals.totalMarketCap, 1650);
assert.equal(analysis.totals.totalTraders, 15);
assert.equal(analysis.totals.marketTraderSum, 15);
assert.equal(analysis.totals.uniqueTraderCount, null);
assert.equal(analysis.totals.alertCount, 1);
assert.equal(analysis.distributions.time.find((item) => item.key === "endingSoon").count, 1);
assert.equal(analysis.distributions.category.find((item) => item.key === "Crypto").count, 2);
assert.equal(analysis.rankings.volume[0].address, "0xaaa");
assert.equal(analysis.rankings.payoutOutcomes[0].name, "Up");
assert.equal(analysis.flags.thinLiquidity[0].address, "0xaaa");
assert.equal(analysis.flags.concentratedOutcome[0].address, "0xaaa");
assert.equal(formatCompactNumber(1234567), "1.23M");

const uniqueAnalysis = analyzeMarkets(markets, now, {
  uniqueTraderCount: 9,
  generatedAt: "2026-05-27T08:00:00Z",
  source: "test"
});
assert.equal(uniqueAnalysis.totals.totalTraders, 9);
assert.equal(uniqueAnalysis.totals.uniqueTraderCount, 9);
assert.equal(uniqueAnalysis.totals.marketTraderSum, 15);

console.log("analytics-core tests passed");
