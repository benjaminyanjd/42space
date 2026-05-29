import {
  analyzeMarkets,
  formatCompactNumber,
  formatPercent
} from "./analytics-core.js";

const APP_BASE = window.location.pathname.startsWith("/42event") ? "/42event" : "";
const apiPath = (path) => `${APP_BASE}${path}`;

const els = {
  dot: document.querySelector("#analytics-dot"),
  status: document.querySelector("#analytics-status"),
  updated: document.querySelector("#analytics-updated"),
  error: document.querySelector("#analytics-error"),
  summary: document.querySelector("#analytics-summary"),
  chartSummary: document.querySelector("#analytics-chart-summary"),
  historyCharts: document.querySelector("#analytics-history-charts"),
  metrics: document.querySelector("#analytics-metrics"),
  distributions: document.querySelector("#analytics-distributions"),
  flags: document.querySelector("#analytics-flags"),
  rankings: document.querySelector("#analytics-rankings"),
  refresh: document.querySelector("#refresh-analytics")
};

let snapshot = null;
let historyPayloads = { day: null, week: null };
let uniqueTraderPayload = null;
let refreshTimer = null;
let loading = false;

async function loadAnalytics({ silent = false } = {}) {
  if (loading) return;
  loading = true;
  if (!silent) renderLoading();

  try {
    const [snapshotResponse, dayResponse, weekResponse, uniqueTraderResponse] = await Promise.all([
      fetch(apiPath("/api/snapshot"), { cache: "no-store" }),
      fetch(apiPath("/api/analytics-history?range=day"), { cache: "no-store" }),
      fetch(apiPath("/api/analytics-history?range=week"), { cache: "no-store" }),
      fetch(apiPath("/api/unique-traders"), { cache: "no-store" })
    ]);
    const data = await readJsonResponse(snapshotResponse, "当前快照", { required: true });
    const [dayHistory, weekHistory, uniqueTraders] = await Promise.all([
      readJsonResponse(dayResponse, "日图历史", { required: false }),
      readJsonResponse(weekResponse, "周图历史", { required: false }),
      readJsonResponse(uniqueTraderResponse, "唯一交易者", { required: false })
    ]);
    snapshot = data;
    historyPayloads = { day: dayHistory, week: weekHistory };
    uniqueTraderPayload = uniqueTraders;
    renderAnalytics(data);
  } catch (error) {
    renderError(error);
  } finally {
    loading = false;
  }
}

async function readJsonResponse(response, label, { required = false } = {}) {
  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.toLowerCase().includes("application/json");
  if (!response.ok) {
    if (!required) return null;
    const text = await response.text().catch(() => "");
    throw new Error(`${label} HTTP ${response.status}${text ? `：${text.slice(0, 120)}` : ""}`);
  }
  if (!isJson) {
    if (!required) return null;
    const text = await response.text().catch(() => "");
    throw new Error(`${label} 返回非 JSON：${text.slice(0, 120) || contentType || "empty response"}`);
  }
  try {
    return await response.json();
  } catch (error) {
    if (!required) return null;
    throw new Error(`${label} JSON 解析失败：${error.message}`);
  }
}

function renderLoading() {
  els.dot.className = "dot";
  els.status.textContent = "读取中";
  els.updated.textContent = "正在拉取当前快照";
}

function renderError(error) {
  els.dot.className = "dot bad";
  els.status.textContent = "数据异常";
  els.updated.textContent = error.message;
  els.error.classList.remove("hidden");
  els.error.textContent = `数据分析页拉取失败：${error.message}`;
  if (!snapshot) {
    els.metrics.innerHTML = `<div class="empty">暂无可分析数据</div>`;
  }
}

function renderAnalytics(data) {
  const markets = data.markets || [];
  const uniqueStats = data.uniqueTraders?.stats || uniqueTraderPayload?.stats || null;
  const analysis = analyzeMarkets(markets, Date.now(), uniqueStats);
  const pollSeconds = Number(data.config?.pollSeconds || 10);

  els.dot.className = data.lastError ? "dot bad" : "dot good";
  els.status.textContent = data.lastError ? "API 异常" : "数据已更新";
  els.updated.textContent = data.lastUpdatedAt ? `更新 ${formatTime(data.lastUpdatedAt)}` : "实时快照";
  els.error.classList.toggle("hidden", !data.lastError);
  els.error.textContent = data.lastError || "";
  els.summary.textContent = `当前快照覆盖 ${analysis.totals.marketCount} 个标的、${analysis.totals.outcomeCount} 个 Outcome；页面每 ${pollSeconds} 秒自动刷新。`;

  renderMetrics(analysis.totals);
  renderHistoryCharts(historyPayloads, analysis);
  renderDistributions(analysis);
  renderFlags(analysis.flags);
  renderRankings(analysis.rankings);

  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => loadAnalytics({ silent: true }), pollSeconds * 1000);
}

function renderMetrics(totals) {
  const uniqueReady = Number.isFinite(Number(totals.uniqueTraderCount));
  const cards = [
    ["全部标的", totals.marketCount, "当前 API 返回的可见标的"],
    ["进行中", totals.liveCount, "status 为 live / active / open"],
    ["新创建", totals.newCount, "创建时间在 30 分钟内"],
    ["临近结束", totals.endingSoonCount, "60 分钟内结束"],
    ["总成交量", `${formatCompactNumber(totals.totalVolume)} USDT`, "所有标的成交量合计"],
    ["总市值", `${formatCompactNumber(totals.totalMarketCap)} USDT`, "所有标的 totalMarketCap 合计"],
    ["唯一交易者", uniqueReady ? formatCompactNumber(totals.uniqueTraderCount) : "扫描中", uniqueReady ? "activity userAddress 跨标去重" : "正在扫描 activity 明细"],
    ["Outcome", formatCompactNumber(totals.outcomeCount), "所有结果项数量"],
    ["平均评分", totals.averageScore.toFixed(1), "score 的简单平均"],
    ["异动标的", totals.alertCount, "当前快照带 hasRecentAlert"]
  ];

  els.metrics.innerHTML = cards
    .map(
      ([label, value, hint]) => `
        <article class="metric-card">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <em>${escapeHtml(hint)}</em>
        </article>
      `
    )
    .join("");
}

function renderHistoryCharts(payloads, analysis = null) {
  const day = payloads.day || { range: "day", points: [] };
  const week = payloads.week || { range: "week", points: [] };
  const dayPoints = (day.points || []).map(hydrateHistoryPoint);
  const weekPoints = (week.points || []).map(hydrateHistoryPoint);
  const uniqueDailyPoints = exactDailyUniqueTraderNewPoints(uniqueTraderPayload?.stats?.dailyNewUniqueTraders, weekPoints);
  const pointText = `日图 ${dayPoints.length} 个点，周图 ${weekPoints.length} 个点；历史从服务上线后开始累计。`;
  if (els.chartSummary) els.chartSummary.textContent = pointText;

  els.historyCharts.innerHTML = [
    renderHistoryPanel("唯一交易者日新增", "历史唯一交易者新增 · 按钱包首次出现日期统计", uniqueDailyPoints, "uniqueDaily"),
    renderHistoryPanel("周图表", "过去 7 天 · 每日成交量", weekPoints, "week"),
    renderCategoryPiePanel(dayPoints),
    renderMarketSharePiePanel(analysis)
  ].join("");
}

function hydrateHistoryPoint(point) {
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

function renderHistoryPanel(title, subtitle, points, mode = "week") {
  const latest = points.at(-1);
  const isUniqueDaily = mode === "uniqueDaily";
  const trendPoints = isUniqueDaily ? points : dailyVolumePoints(points);
  return `
    <article class="history-panel">
      <div class="history-head">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <span>${escapeHtml(subtitle)} · ${isUniqueDaily ? `${points.length} 天` : `${points.length} 个历史点`}</span>
        </div>
        <strong>${latest ? formatTime(latest.timestamp) : "等待累计"}</strong>
      </div>
      <div class="history-body single-chart">
        <div class="trend-card">
          <div class="chart-title">
            <strong>${isUniqueDaily ? "历史唯一交易者新增柱状图" : "每日成交量柱状图"}</strong>
            <span>${isUniqueDaily ? "按天统计新增去重钱包" : "按天聚合成交量"}</span>
          </div>
          ${renderBarSvg(trendPoints, isUniqueDaily ? dailyUniqueTraderNewSeries() : dailyVolumeSeries())}
        </div>
      </div>
    </article>
  `;
}

function renderCategoryPiePanel(dayPoints) {
  const latest = dayPoints.at(-1);
  return `
    <article class="history-panel category-pie-panel">
      <div class="history-head">
        <div>
          <h3>成交增长分类饼图</h3>
          <span>按过去 24 小时成交增长来源统计 · 独立展示</span>
        </div>
        <strong>${latest ? formatTime(latest.timestamp) : "等待累计"}</strong>
      </div>
      <div class="history-body single-chart">
        <div class="pie-card standalone-pie-card">
          <div class="chart-title">
            <strong>成交增长来源</strong>
            <span>Crypto / Binance / Sports 等分类占比</span>
          </div>
          ${renderPieChart(dailyCategoryVolumeGrowth(dayPoints))}
        </div>
      </div>
    </article>
  `;
}

function renderMarketSharePiePanel(analysis) {
  const marketCounts = marketTopicVolumeCounts(snapshot?.markets || []);
  return `
    <article class="history-panel category-pie-panel">
      <div class="history-head">
        <div>
          <h3>具体标的占比饼图</h3>
          <span>按当前快照的具体预测话题成交量统计 · 独立展示</span>
        </div>
        <strong>${snapshot?.lastUpdatedAt ? formatTime(snapshot.lastUpdatedAt) : "实时快照"}</strong>
      </div>
      <div class="history-body single-chart">
        <div class="pie-card standalone-pie-card">
          <div class="chart-title">
            <strong>具体预测话题成交占比</strong>
            <span>每个扇区是一个具体标的，不是分类</span>
          </div>
          ${renderPieChart(marketCounts)}
        </div>
      </div>
    </article>
  `;
}

function marketTopicVolumeCounts(markets, limit = 8) {
  const sorted = (markets || [])
    .map((market) => ({
      label: compactQuestion(market.question || market.title || market.address || "Unknown market"),
      value: numericValue(market.volume ?? market.volumeNumber)
    }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);

  if (!sorted.length) {
    return aggregateEntries(
      (markets || [])
        .slice(0, limit)
        .map((market) => [compactQuestion(market.question || market.title || market.address || "Unknown market"), 1])
    );
  }

  const top = sorted.slice(0, limit);
  const other = sorted.slice(limit).reduce((sum, item) => sum + item.value, 0);
  const entries = top.map((item) => [item.label, item.value]);
  if (other > 0) entries.push(["其他标的", other]);
  return aggregateEntries(entries);
}

function aggregateEntries(entries) {
  const counts = {};
  for (const [label, rawValue] of entries) {
    const key = label || "Unknown";
    const value = numericValue(rawValue);
    if (value > 0) counts[key] = (counts[key] || 0) + value;
  }
  return counts;
}

function compactQuestion(question, maxLength = 42) {
  const text = String(question || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function numericValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value ?? "").trim().toUpperCase().replace(/[$,\s,]/g, "");
  const match = text.match(/^(-?\d+(?:\.\d+)?)([KMB])?$/);
  if (!match) return 0;
  const number = Number(match[1]);
  const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[match[2]] || 1;
  return Number.isFinite(number) ? number * multiplier : 0;
}

function dailyGrowthPoints(points) {
  if (!points.length) return [];
  const first = points[0];
  return points.map((point) => ({
    ...point,
    volumeGrowth: Math.max(0, Number(point.totalVolume || 0) - Number(first.totalVolume || 0)),
    traderGrowth: Math.max(0, Number(point.totalTraders || 0) - Number(first.totalTraders || 0))
  }));
}

function dailyGrowthSeries() {
  return [
    ["volumeGrowth", "成交增长", "#ffe16f"],
    ["traderGrowth", "唯一交易者增长", "#75eaff"]
  ];
}

function dailyUniqueTraderNewSeries() {
  return [["uniqueTraderNew", "新增唯一交易者", "#75eaff"]];
}

function dailyVolumeSeries() {
  return [["dailyVolume", "成交量", "#ffe16f"]];
}

function exactDailyUniqueTraderNewPoints(rows, fallbackPoints) {
  if (Array.isArray(rows) && rows.length) {
    return rows.map((row) => ({
      timestamp: `${row.date}T00:00:00+08:00`,
      dayLabel: formatDateKeyLabel(row.date),
      uniqueTraderNew: Number(row.count || 0)
    }));
  }
  return dailyUniqueTraderNewPoints(fallbackPoints);
}

function dailyUniqueTraderNewPoints(points) {
  const byDay = new Map();
  for (const point of points) {
    if (!point?.timestamp) continue;
    const dayKey = dateKeyFromTimestamp(point.timestamp);
    const dayLabel = formatDateLabel(point.timestamp);
    const total = Number(point.uniqueTraderCount ?? point.totalTraders ?? 0);
    const existing = byDay.get(dayKey);
    if (!existing) {
      byDay.set(dayKey, {
        timestamp: point.timestamp,
        dayLabel,
        firstUniqueTraderCount: total,
        lastUniqueTraderCount: total,
        uniqueTraderNew: 0
      });
      continue;
    }
    existing.timestamp = point.timestamp;
    existing.lastUniqueTraderCount = total;
    existing.uniqueTraderNew = Math.max(0, existing.lastUniqueTraderCount - existing.firstUniqueTraderCount);
  }
  return [...byDay.values()];
}

function formatDateKeyLabel(dateKey) {
  const parts = String(dateKey || "").split("-");
  if (parts.length < 3) return String(dateKey || "");
  return `${parts[0]}/${parts[1]}/${parts[2]}`;
}

function dailyVolumePoints(points) {
  const byDay = new Map();
  for (const point of points) {
    if (!point?.timestamp) continue;
    const dayKey = dateKeyFromTimestamp(point.timestamp);
    byDay.set(dayKey, {
      timestamp: point.timestamp,
      dayLabel: formatDateLabel(point.timestamp),
      dailyVolume: Number(point.totalVolume || 0)
    });
  }
  return [...byDay.values()];
}

function dailyCategoryVolumeGrowth(points) {
  if (points.length < 2) return points.at(-1)?.categoryVolumes || {};
  const first = points[0]?.categoryVolumes || {};
  const latest = points.at(-1)?.categoryVolumes || {};
  const categories = new Set([...Object.keys(first), ...Object.keys(latest)]);
  const growth = {};
  for (const category of categories) {
    const delta = Number(latest[category] || 0) - Number(first[category] || 0);
    if (delta > 0) growth[category] = delta;
  }
  return growth;
}

function renderBarSvg(points, series) {
  if (!points.length) return `<div class="empty small-empty">暂无历史点。服务运行后会自动累计。</div>`;
  const width = 720;
  const height = 260;
  const padding = { left: 44, right: 18, top: 20, bottom: 48 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const valuesBySeries = series.map(([key]) => points.map((point) => Number(point[key] || 0)));
  const max = Math.max(1, ...valuesBySeries.flat());
  const groupWidth = innerWidth / Math.max(1, points.length);
  const barWidth = Math.max(3, Math.min(13, (groupWidth * 0.72) / series.length));
  const groupGap = Math.max(2, (groupWidth - barWidth * series.length) / 2);
  const showValueLabels = groupWidth >= 34;
  const barItems = points
    .map((point, pointIndex) =>
      series
        .map(([key, label, color], seriesIndex) => {
          const value = Number(point[key] || 0);
          const barHeight = Math.max(value > 0 ? 2 : 0, (value / max) * innerHeight);
          const x = padding.left + pointIndex * groupWidth + groupGap + seriesIndex * barWidth;
          const y = padding.top + innerHeight - barHeight;
          const labelX = x + barWidth / 2;
          const labelY = Math.max(22, y - 10);
          const valueLabel = showValueLabels && value > 0
            ? `
              <text class="bar-svg-label" x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle">${formatCompactNumber(value)}</text>
            `
            : "";
          return `
            <g>
              <rect class="bar-svg-rect" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2" fill="${color}"><title>${escapeHtml(label)} ${formatCompactNumber(value)}</title></rect>
              ${valueLabel}
            </g>
          `;
        })
        .join("")
    )
    .join("");
  const latestValues = series.map(([key, label, color]) => ({
    label,
    color,
    latest: Number(points.at(-1)?.[key] || 0)
  }));
  const xAxisLabels = points
    .map((point, index) => {
      const x = padding.left + index * groupWidth + groupWidth / 2;
      const label = point.dayLabel || (point.timestamp ? formatDateLabel(point.timestamp) : "");
      if (!label) return "";
      return `<text class="bar-axis-label" x="${x.toFixed(1)}" y="${height - 13}" text-anchor="middle">${escapeHtml(label)}</text>`;
    })
    .join("");

  return `
    <div class="trend-wrap">
      <svg class="trend-svg bar-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="柱状图">
        ${[0, 1, 2, 3].map((i) => `<line x1="${padding.left}" x2="${width - padding.right}" y1="${padding.top + (innerHeight / 3) * i}" y2="${padding.top + (innerHeight / 3) * i}" />`).join("")}
        ${barItems}
        ${xAxisLabels}
      </svg>
      <div class="trend-legend">
        ${latestValues
          .map(
            (line) => `
              <span><i style="background:${line.color}"></i>${escapeHtml(line.label)} <strong>${formatCompactNumber(line.latest)}</strong></span>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderTrendSvg(points, series) {
  if (!points.length) return `<div class="empty small-empty">暂无历史点。服务运行后会自动累计。</div>`;
  const width = 720;
  const height = 260;
  const padding = { left: 44, right: 18, top: 20, bottom: 36 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const xFor = (index) => padding.left + (points.length <= 1 ? innerWidth : (index / (points.length - 1)) * innerWidth);
  const linePaths = series
    .map(([key, label, color]) => {
      const values = points.map((point) => Number(point[key] || 0));
      const max = Math.max(1, ...values);
      const path = values
        .map((value, index) => {
          const x = xFor(index);
          const y = padding.top + innerHeight - (value / max) * innerHeight;
          return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(" ");
      const latest = values.at(-1) || 0;
      return { key, label, color, path, latest };
    })
    .filter((line) => line.path);

  const firstTime = points[0]?.timestamp ? formatTime(points[0].timestamp) : "";
  const lastTime = points.at(-1)?.timestamp ? formatTime(points.at(-1).timestamp) : "";

  return `
    <div class="trend-wrap">
      <svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="趋势图">
        <defs>
          <linearGradient id="gridFade" x1="0" x2="1">
            <stop offset="0%" stop-color="rgba(130,255,157,0.16)" />
            <stop offset="100%" stop-color="rgba(117,234,255,0.06)" />
          </linearGradient>
        </defs>
        ${[0, 1, 2, 3].map((i) => `<line x1="${padding.left}" x2="${width - padding.right}" y1="${padding.top + (innerHeight / 3) * i}" y2="${padding.top + (innerHeight / 3) * i}" />`).join("")}
        ${linePaths.map((line) => `<path d="${line.path}" stroke="${line.color}" />`).join("")}
        <text x="${padding.left}" y="${height - 10}">${escapeHtml(firstTime)}</text>
        <text x="${width - padding.right}" y="${height - 10}" text-anchor="end">${escapeHtml(lastTime)}</text>
      </svg>
      <div class="trend-legend">
        ${linePaths
          .map(
            (line) => `
              <span><i style="background:${line.color}"></i>${escapeHtml(line.label)} <strong>${formatCompactNumber(line.latest)}</strong></span>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderPieChart(counts) {
  const entries = Object.entries(counts)
    .filter(([, value]) => Number(value || 0) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 6);
  const total = entries.reduce((sum, [, value]) => sum + Number(value || 0), 0);
  if (!total) return `<div class="empty small-empty">暂无分类占比</div>`;

  const colors = ["#82ff9d", "#75eaff", "#ffe16f", "#ff9f6e", "#ff706d", "#bca8ff"];
  let offset = 0;
  const slices = entries.map(([label, value], index) => {
    const count = Number(value || 0);
    const percent = count / total;
    const segment = `${percent * 100} ${100 - percent * 100}`;
    const slice = `<circle r="15.9" cx="18" cy="18" stroke="${colors[index % colors.length]}" stroke-dasharray="${segment}" stroke-dashoffset="${-offset}" />`;
    offset += percent * 100;
    return { label, count, percent, color: colors[index % colors.length], slice };
  });

  return `
    <div class="pie-wrap">
      <svg class="pie-svg" viewBox="-3 -3 42 42" role="img" aria-label="分类饼图">
        <circle class="pie-bg" r="15.9" cx="18" cy="18" />
        ${slices.map((slice) => slice.slice).join("")}
      </svg>
      <div class="pie-legend">
        ${slices
          .map(
            (slice) => `
              <span title="${escapeHtml(`${slice.label} ${formatCompactNumber(slice.count)} · ${Math.round(slice.percent * 100)}%`)}">
                <i style="background:${slice.color}"></i>
                <em class="pie-label">${escapeHtml(slice.label)}</em>
                <strong>${formatCompactNumber(slice.count)} · ${Math.round(slice.percent * 100)}%</strong>
              </span>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderDistributions(analysis) {
  const total = analysis.totals.marketCount || 1;
  const sections = [
    ["状态分布", analysis.distributions.status],
    ["时间窗口", analysis.distributions.time],
    ["类别分布", analysis.distributions.category],
    ["结算币种", analysis.distributions.collateral],
    ["Outcome 数量", analysis.distributions.outcomeCount]
  ];

  els.distributions.innerHTML = sections.map(([title, rows]) => renderDistribution(title, rows, total)).join("");
}

function renderDistribution(title, rows, total) {
  const visible = rows.slice(0, 8);
  return `
    <article class="distribution-card">
      <h3>${escapeHtml(title)}</h3>
      <div class="bar-list">
        ${
          visible.length
            ? visible
                .map((row) => {
                  const percent = Math.round((row.count / total) * 100);
                  return `
                    <div class="bar-row">
                      <span>${escapeHtml(row.label)}</span>
                      <strong>${row.count}</strong>
                      <i style="--bar:${Math.max(3, percent)}%"></i>
                    </div>
                  `;
                })
                .join("")
            : `<div class="empty">暂无分布数据</div>`
        }
      </div>
    </article>
  `;
}

function renderFlags(flags) {
  const sections = [
    ["少数人主导", "成交量高但单市场交易者少，容易被单钱包影响。", flags.thinLiquidity, renderMarketFlag],
    ["Outcome 集中", "最大 Outcome 市值占比超过 65%。", flags.concentratedOutcome, (market) => renderMarketFlag(market, `集中度 ${formatPercent((market.concentration || 0) * 100, 0)}`)],
    ["新标的有资金", "30 分钟内创建且已有成交或交易者。", flags.newWithFlow, renderMarketFlag],
    ["临近结束", "60 分钟内结束，需要关注最终成交和赔率变化。", flags.endingSoon, (market) => renderMarketFlag(market, `${formatCountdown(market.minutesToEnd)}后结束`)],
    ["已有异动", "当前快照已触发异动信号。", flags.hotAlerts, renderMarketFlag],
    ["高赔率 Outcome", "赔率高且已经有成交量。", flags.highPayoutOutcomes, renderOutcomeFlag]
  ];

  els.flags.innerHTML = sections
    .map(([title, description, rows, renderer]) => `
      <article class="flag-card">
        <div class="flag-head">
          <h3>${escapeHtml(title)}</h3>
          <span>${rows.length}</span>
        </div>
        <p>${escapeHtml(description)}</p>
        <div class="flag-list">
          ${
            rows.length
              ? rows.slice(0, 6).map(renderer).join("")
              : `<div class="empty small-empty">暂无命中</div>`
          }
        </div>
      </article>
    `)
    .join("");
}

function renderRankings(rankings) {
  const sections = [
    ["成交量 Top", rankings.volume, ["成交量", "单市场交易者", "市值"], (market) => [money(market.volumeNumber), formatCompactNumber(market.tradersNumber), money(market.marketCapNumber)]],
    ["市值 Top", rankings.marketCap, ["市值", "成交量", "评分"], (market) => [money(market.marketCapNumber), money(market.volumeNumber), trimScore(market.scoreNumber)]],
    ["单市场交易者 Top", rankings.traders, ["交易者", "成交量", "评分"], (market) => [formatCompactNumber(market.tradersNumber), money(market.volumeNumber), trimScore(market.scoreNumber)]],
    ["评分 Top", rankings.score, ["评分", "成交量", "单市场交易者"], (market) => [trimScore(market.scoreNumber), money(market.volumeNumber), formatCompactNumber(market.tradersNumber)]],
    ["赔率 Top Outcome", rankings.payoutOutcomes, ["赔率", "成交量", "市值"], (outcome) => [String(outcome.payoutNumber), money(outcome.volumeNumber), money(outcome.marketCapNumber)], true],
    ["活跃 Outcome", rankings.activeOutcomes, ["成交量", "市值", "赔率"], (outcome) => [money(outcome.volumeNumber), money(outcome.marketCapNumber), String(outcome.payoutNumber)], true]
  ];

  els.rankings.innerHTML = sections.map(renderRankingTable).join("");
}

function renderRankingTable([title, rows, headers, valueGetter, isOutcome = false]) {
  return `
    <article class="ranking-card">
      <h3>${escapeHtml(title)}</h3>
      <div class="data-table">
        <div class="data-row data-head">
          <span>标的</span>
          ${headers.map((header) => `<span>${escapeHtml(header)}</span>`).join("")}
        </div>
        ${
          rows.length
            ? rows
                .slice(0, 10)
                .map((row, index) => {
                  const market = isOutcome ? row.market : row;
                  const values = valueGetter(row);
                  const titleText = isOutcome ? `${row.name || "Outcome"} · ${market.question || ""}` : market.question || market.address || "Market";
                  return `
                    <a class="data-row" href="${escapeHtml(marketUrl(market))}" target="_blank" rel="noreferrer">
                      <span><em>#${index + 1}</em>${escapeHtml(titleText)}</span>
                      ${values.map((value) => `<strong>${escapeHtml(value)}</strong>`).join("")}
                    </a>
                  `;
                })
                .join("")
            : `<div class="empty small-empty">暂无排行数据</div>`
        }
      </div>
    </article>
  `;
}

function renderMarketFlag(market, extra = "") {
  return `
    <a class="flag-item" href="${escapeHtml(marketUrl(market))}" target="_blank" rel="noreferrer">
      <strong>${escapeHtml(market.question || market.address || "Market")}</strong>
      <span>${money(market.volumeNumber)} 成交 · ${money(market.marketCapNumber)} 市值 · ${formatCompactNumber(market.tradersNumber)} 人${extra ? ` · ${escapeHtml(extra)}` : ""}</span>
    </a>
  `;
}

function renderOutcomeFlag(outcome) {
  const market = outcome.market;
  return `
    <a class="flag-item" href="${escapeHtml(marketUrl(market))}" target="_blank" rel="noreferrer">
      <strong>${escapeHtml(outcome.name || "Outcome")}</strong>
      <span>${escapeHtml(market.question || "")} · 赔率 ${outcome.payoutNumber} · ${money(outcome.volumeNumber)} 成交</span>
    </a>
  `;
}

function marketUrl(market) {
  return market.url || `https://www.42.space/event/${market.address || ""}`;
}

function money(value) {
  return `${formatCompactNumber(value)} USDT`;
}

function trimScore(value) {
  return Number(value || 0).toFixed(0);
}

function formatCountdown(minutes) {
  if (!Number.isFinite(minutes)) return "未知时间";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = Math.max(0, Math.floor(minutes % 60));
  if (days > 0) return `${days}天${hours}时`;
  if (hours > 0) return `${hours}时${mins}分`;
  return `${mins}分`;
}

function formatTime(value) {
  if (!value) return "n/a";
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatDateLabel(value) {
  if (!value) return "";
  const parts = dateParts(value);
  return parts ? `${parts.year}/${parts.month}/${parts.day}` : "";
}

function dateKeyFromTimestamp(value) {
  const parts = dateParts(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : String(value || "");
}

function dateParts(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, "0"),
    day: String(date.getDate()).padStart(2, "0")
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

els.refresh.addEventListener("click", () => loadAnalytics());
await loadAnalytics();
