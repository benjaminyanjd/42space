const els = {
  dot: document.querySelector("#profit-dot"),
  status: document.querySelector("#profit-status"),
  updated: document.querySelector("#profit-updated"),
  summary: document.querySelector("#profit-summary"),
  leaderboard: document.querySelector("#profit-leaderboard"),
  refresh: document.querySelector("#refresh-profit-leaderboard")
};

const APP_BASE = window.location.pathname.startsWith("/42event") ? "/42event" : "";
const apiPath = (path) => `${APP_BASE}${path}`;

let loading = false;
let currentLeaderboard = null;
let refreshTimer = null;

async function loadProfitLeaderboard({ silent = false } = {}) {
  if (loading) return;
  loading = true;
  if (!currentLeaderboard && !silent) renderLoading();

  try {
    const response = await fetch(apiPath("/api/profit-leaderboard?limit=50&marketLimit=100"), { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    currentLeaderboard = data;
    renderLeaderboard(data);
  } catch (error) {
    if (!currentLeaderboard) renderError(error);
  } finally {
    loading = false;
  }
}

function renderLoading() {
  els.dot.className = "dot";
  els.status.textContent = "读取中";
  els.updated.textContent = "先取缓存，后台刷新";
  els.summary.textContent = "正在读取盈利钱包榜单...";
  els.leaderboard.innerHTML = `<div class="empty">页面不会等待全市场 holders 扫描完成；有缓存会先显示，后台刷新后自动替换。</div>`;
}

function renderError(error) {
  els.dot.className = "dot bad";
  els.status.textContent = "榜单失败";
  els.updated.textContent = error.message;
  els.summary.textContent = "榜单拉取失败";
  els.leaderboard.innerHTML = `<div class="empty">盈利榜单失败：${escapeHtml(error.message)}</div>`;
}

function renderLeaderboard(data) {
  const wallets = data.wallets || [];
  els.dot.className = `dot ${data.refreshing ? "" : "good"}`;
  els.status.textContent = data.refreshing ? `后台刷新中 · 已显示 ${wallets.length} 个钱包` : `上榜 ${wallets.length} 个钱包`;
  els.updated.textContent = data.stale ? `先显示缓存 ${formatTime(data.generatedAt)}` : `更新 ${formatTime(data.generatedAt)}`;
  scheduleRefreshIfNeeded(data);

  if (!wallets.length) {
    els.summary.textContent = data.refreshing ? "后台正在生成榜单，页面会自动更新。" : "当前 holders 中没有检测到盈利钱包";
    els.leaderboard.innerHTML = `<div class="empty">${data.refreshing ? "榜单后台扫描中，不会阻塞页面；通常 1 分钟内自动出现。" : "暂无盈利钱包榜单。"}</div>`;
    return;
  }

  els.summary.innerHTML = `
    <span>扫描 <strong>${data.scannedMarketCount ?? data.marketCount}</strong> / ${data.marketCount} 个标的</span>
    <span>上榜 <strong>${wallets.length}</strong> 个钱包</span>
    <span>榜单正收益合计 <strong>${formatCompactMoney(data.summary?.totalPositivePnl || 0)}</strong></span>
    <span>更新时间 <strong>${formatTime(data.generatedAt)}</strong></span>
    ${data.refreshing ? `<span>后台刷新 <strong>${data.stale ? "使用缓存中" : "生成中"}</strong></span>` : ""}
    ${data.skippedMarketCount ? `<span>限流跳过 <strong>${data.skippedMarketCount}</strong> 个</span>` : ""}
  `;
  els.leaderboard.innerHTML = wallets.slice(0, 50).map(renderProfitWalletRow).join("");
}

function scheduleRefreshIfNeeded(data) {
  clearTimeout(refreshTimer);
  if (!data.refreshing) return;
  refreshTimer = setTimeout(() => loadProfitLeaderboard({ silent: true }), 10000);
}

function renderProfitWalletRow(wallet, index) {
  const positions = wallet.topPositions || [];
  const main = positions[0];
  return `
    <article class="profit-row">
      <div class="profit-rank">#${index + 1}</div>
      <div class="profit-wallet">
        <a href="https://bscscan.com/address/${wallet.userAddress}" target="_blank" rel="noreferrer">${escapeHtml(wallet.userAddress)}</a>
        <span>${confidenceName(wallet.confidence)} · ${wallet.profitableMarketCount || 0}/${wallet.marketCount || 0} 个盈利标的</span>
      </div>
      <div class="profit-metrics">
        <div><span>总盈利</span><strong>+${formatCompactMoney(wallet.totalPnl)}</strong></div>
        <div><span>ROI</span><strong>${wallet.roi === null ? "n/a" : `${wallet.roi.toFixed(1)}%`}</strong></div>
        <div><span>成本</span><strong>${formatCompactMoney(wallet.costBasis)}</strong></div>
        <div><span>当前价值</span><strong>${formatCompactMoney(wallet.currentValue)}</strong></div>
      </div>
      <div class="profit-position">
        <span>主要盈利标的</span>
        ${
          main
            ? `<a class="profit-market-link" href="${escapeHtml(main.url || `https://www.42.space/event/${main.marketAddress}`)}" target="_blank" rel="noreferrer">${escapeHtml(main.question)}</a>
               <em>${escapeHtml(main.outcomeName || main.name || "Outcome")} · +${formatCompactMoney(main.totalPnl)}</em>`
            : `<em>无可展示标的</em>`
        }
      </div>
      <details class="profit-details">
        <summary>展开 ${positions.length} 个盈利标的</summary>
        <div>
          ${positions.map(renderProfitPosition).join("")}
        </div>
      </details>
    </article>
  `;
}

function renderProfitPosition(position) {
  return `
    <a class="profit-position-item" href="${escapeHtml(position.url || `https://www.42.space/event/${position.marketAddress}`)}" target="_blank" rel="noreferrer">
      <strong>${escapeHtml(position.question)}</strong>
      <span>${escapeHtml(position.outcomeName || position.name || "Outcome")} · +${formatCompactMoney(position.totalPnl)} · ROI ${position.roi === null ? "n/a" : `${position.roi.toFixed(1)}%`}</span>
    </a>
  `;
}

function confidenceName(value) {
  return { high: "高置信", medium: "中置信", low: "低置信" }[value] || value;
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
  return Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function formatTime(value) {
  if (!value) return "n/a";
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

els.refresh.addEventListener("click", () => loadProfitLeaderboard());
await loadProfitLeaderboard();
