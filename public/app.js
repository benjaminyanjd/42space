const els = {
  healthDot: document.querySelector("#health-dot"),
  healthText: document.querySelector("#health-text"),
  lastUpdated: document.querySelector("#last-updated"),
  nextRefresh: document.querySelector("#next-refresh"),
  notifyStatus: document.querySelector("#notify-status"),
  enableAlerts: document.querySelector("#enable-alerts"),
  toastHost: document.querySelector("#toast-host"),
  error: document.querySelector("#error"),
  keyword: document.querySelector("#keyword"),
  status: document.querySelector("#status"),
  category: document.querySelector("#category"),
  timeType: document.querySelector("#time-type"),
  alerts: document.querySelector("#alerts"),
  alertCount: document.querySelector("#alert-count"),
  profitSummary: document.querySelector("#profit-summary"),
  profitLeaderboard: document.querySelector("#profit-leaderboard"),
  refreshProfitLeaderboard: document.querySelector("#refresh-profit-leaderboard"),
  profitMonitorCount: document.querySelector("#profit-monitor-count"),
  profitMonitorStatus: document.querySelector("#profit-monitor-status"),
  profitMonitorFeed: document.querySelector("#profit-monitor-feed"),
  refreshProfitMonitor: document.querySelector("#refresh-profit-monitor"),
  markets: document.querySelector("#markets"),
  marketCount: document.querySelector("#market-count"),
  quickButtons: [...document.querySelectorAll("[data-quick]")],
  profitLeaderboardJump: document.querySelector("#radar-profit-leaderboard"),
  radar: {
    all: document.querySelector("#radar-all"),
    alerts: document.querySelector("#radar-alerts"),
    new: document.querySelector("#radar-new"),
    ending: document.querySelector("#radar-ending"),
    profitWallets: document.querySelector("#radar-profit-wallets")
  }
};

const APP_BASE = window.location.pathname.startsWith("/42event") ? "/42event" : "";
const apiPath = (path) => `${APP_BASE}${path}`;

let snapshot = null;
let quickFilter = "all";
let nextRefreshAt = 0;
let firstSnapshotLoaded = false;
let browserAlertsEnabled = localStorage.getItem("fortytwoBrowserAlerts") === "1";
let soundAlertsEnabled = localStorage.getItem("fortytwoSoundAlerts") === "1";
let audioContext = null;
let alertSoundActiveUntil = 0;
let titleFlashTimer = null;
const originalTitle = document.title;
const knownAlertIds = new Set();
const ALERT_FEED_STORAGE_KEY = "fortytwoAlertFeed";
const ALERT_FEED_LIMIT = 500;
let alertFeed = loadStoredAlertFeed();
const PROFIT_MONITOR_KNOWN_KEY = "fortytwoProfitWalletKnownPositions";
const PROFIT_MONITOR_FEED_KEY = "fortytwoProfitWalletActivity";
const PROFIT_MONITOR_FEED_LIMIT = 300;
let profitMonitorKnown = loadStoredSet(PROFIT_MONITOR_KNOWN_KEY);
let profitMonitorFeed = loadStoredProfitMonitorFeed();
let profitMonitorLoading = false;
let profitMonitorLastScanAt = null;
let profitLeaderboard = null;
let profitLeaderboardLoading = false;
let profitLeaderboardError = "";
let marketsRenderedOnce = false;
const customSelects = new Map();

for (const alert of alertFeed) {
  const key = alertIdentity(alert);
  if (key) knownAlertIds.add(key);
}

async function loadSnapshot() {
  try {
    const response = await fetch(apiPath("/api/snapshot"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    snapshot = await response.json();
    nextRefreshAt = Date.now() + (snapshot.config?.pollSeconds || 5) * 1000;
    handleIncomingAlerts(snapshot.alerts || []);
    render({ preserveMarketsScroll: marketsRenderedOnce });
  } catch (error) {
    els.healthDot.className = "dot bad";
    els.healthText.textContent = "连接失败";
    els.error.classList.remove("hidden");
    els.error.textContent = `看板 API 拉取失败：${error.message}`;
  }
}

function render({ preserveMarketsScroll = false } = {}) {
  if (!snapshot) return;
  renderHealth();
  renderNotifyState();
  renderFilters();
  renderRadar();
  renderAlerts();
  renderProfitWalletMonitor();
  renderProfitLeaderboard();
  renderMarkets({ preserveScroll: preserveMarketsScroll });
}

function renderHealth() {
  els.healthDot.className = `dot ${snapshot.lastError ? "bad" : "good"}`;
  els.healthText.textContent = snapshot.lastError ? "API 异常" : "实时监控中";
  els.lastUpdated.textContent = snapshot.lastUpdatedAt ? `上次更新 ${formatTime(snapshot.lastUpdatedAt)}` : "等待首次更新";
  els.error.classList.toggle("hidden", !snapshot.lastError);
  els.error.textContent = snapshot.lastError || "";
}

function renderNotifyState() {
  if ((!("Notification" in window) || Notification.permission === "denied") && !soundAlertsEnabled) {
    soundAlertsEnabled = true;
    localStorage.setItem("fortytwoSoundAlerts", "1");
  }

  if (!("Notification" in window)) {
    els.notifyStatus.textContent = soundAlertsEnabled
      ? "当前浏览器不支持系统通知；已启用声音和页面内提醒。"
      : "当前浏览器不支持系统通知；可以启用声音和页面内提醒。";
    els.enableAlerts.disabled = false;
    els.enableAlerts.textContent = soundAlertsEnabled ? "测试声音" : "启用声音提醒";
    els.enableAlerts.classList.toggle("enabled", soundAlertsEnabled);
    return;
  }

  if (browserAlertsEnabled && Notification.permission === "granted") {
    els.notifyStatus.textContent = "已启用。新异动会触发浏览器通知和提示音。";
    els.enableAlerts.textContent = "测试提醒";
    els.enableAlerts.classList.add("enabled");
    return;
  }

  if (Notification.permission === "denied") {
    els.notifyStatus.textContent = soundAlertsEnabled
      ? "浏览器弹窗通知权限被拒绝；已改用声音和页面内提醒。要恢复弹窗通知，需要在地址栏/站点设置里重新允许。"
      : "浏览器弹窗通知权限被拒绝；点击可先启用声音和页面内提醒。弹窗通知需要在地址栏/站点设置里重新允许。";
    els.enableAlerts.textContent = soundAlertsEnabled ? "测试声音" : "启用声音提醒";
    els.enableAlerts.classList.toggle("enabled", soundAlertsEnabled);
    return;
  }

  els.notifyStatus.textContent = soundAlertsEnabled
    ? "声音和页面内提醒已启用；点击可继续授权浏览器弹窗通知。"
    : "未启用。点击后授权浏览器通知，并解锁声音提醒。";
  els.enableAlerts.textContent = "启用提醒";
  els.enableAlerts.classList.toggle("enabled", soundAlertsEnabled);
}

function renderFilters() {
  const currentStatus = els.status.value;
  const currentCategory = els.category.value;
  const currentTimeType = els.timeType.value;
  const statuses = new Set();
  const categories = new Set();
  const timeTypes = new Set();

  for (const market of snapshot.markets || []) {
    statuses.add(market.status);
    for (const category of market.categories || []) categories.add(category);
    timeTypes.add(classifyTime(market).key);
  }

  fillSelect(els.status, "全部状态", statuses, currentStatus, statusName);
  fillSelect(els.category, "全部类别", categories, currentCategory);
  fillSelect(els.timeType, "全部时间类型", timeTypes, currentTimeType, timeTypeLabel);
  syncAllCustomSelects();
}

function fillSelect(select, label, values, current, labeler = (value) => value) {
  const sorted = [...values].filter(Boolean).sort();
  select.innerHTML = `<option value="">${label}</option>${sorted
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(labeler(value))}</option>`)
    .join("")}`;
  select.value = sorted.includes(current) ? current : "";
}

function setupCustomSelects() {
  [els.status, els.category, els.timeType].forEach((select) => {
    if (!select || customSelects.has(select)) return;
    select.classList.add("native-select-hidden");

    const shell = document.createElement("div");
    shell.className = "custom-select";
    shell.dataset.selectId = select.id;

    const button = document.createElement("button");
    button.className = "custom-select-button";
    button.type = "button";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");

    const menu = document.createElement("div");
    menu.className = "custom-select-menu";
    menu.setAttribute("role", "listbox");

    shell.append(button, menu);
    select.insertAdjacentElement("afterend", shell);
    customSelects.set(select, { shell, button, menu });

    button.addEventListener("click", () => {
      const willOpen = !shell.classList.contains("open");
      closeCustomSelects();
      if (willOpen) {
        shell.classList.add("open");
        button.setAttribute("aria-expanded", "true");
      }
    });

    menu.addEventListener("click", (event) => {
      const option = event.target.closest("[data-value]");
      if (!option) return;
      select.value = option.dataset.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      syncCustomSelect(select);
      closeCustomSelects();
    });
  });

  syncAllCustomSelects();
}

function syncAllCustomSelects() {
  for (const select of customSelects.keys()) syncCustomSelect(select);
}

function syncCustomSelect(select) {
  const custom = customSelects.get(select);
  if (!custom) return;
  const selectedOption = select.selectedOptions[0] || select.options[0];
  custom.button.innerHTML = `
    <span>${escapeHtml(selectedOption?.textContent || "")}</span>
    <i aria-hidden="true"></i>
  `;
  custom.menu.innerHTML = [...select.options]
    .map((option) => {
      const selected = option.value === select.value;
      return `
        <button class="custom-select-option ${selected ? "selected" : ""}" type="button" role="option" data-value="${escapeHtml(option.value)}" aria-selected="${selected}">
          <span>${escapeHtml(option.textContent || "")}</span>
        </button>
      `;
    })
    .join("");
}

function closeCustomSelects() {
  for (const { shell, button } of customSelects.values()) {
    shell.classList.remove("open");
    button.setAttribute("aria-expanded", "false");
  }
}

function renderRadar() {
  const markets = snapshot.markets || [];
  const counts = {
    all: markets.length,
    alerts: markets.filter((market) => market.hasRecentAlert).length,
    new: markets.filter((market) => classifyTime(market).key === "new").length,
    ending: markets.filter((market) => classifyTime(market).key === "endingSoon").length
  };

  els.radar.all.textContent = counts.all;
  els.radar.alerts.textContent = counts.alerts;
  els.radar.new.textContent = counts.new;
  els.radar.ending.textContent = counts.ending;
  if (els.radar.profitWallets) els.radar.profitWallets.textContent = "进入";

  for (const button of els.quickButtons) {
    button.classList.toggle("active", button.dataset.quick === quickFilter);
  }
}

function renderAlerts() {
  const alerts = alertFeed;
  els.alertCount.textContent = alerts.length;
  if (!alerts.length) {
    els.alerts.innerHTML = `<div class="empty">暂无异动。服务需要至少运行 ${snapshot.config?.alertWindowMinutes || 5} 分钟形成对比基线。</div>`;
    return;
  }

  els.alerts.innerHTML = alerts
    .map((alert) => {
      const subject = alert.outcome ? alert.outcome.name : "Market";
      return `
        <button class="alert ${alertToneClass(alert)}" type="button" data-market-address="${escapeHtml(alert.marketAddress)}">
          <span class="alert-kind">${metricName(alert.metric)}</span>
          <strong>${escapeHtml(subject)}</strong>
          <span>${escapeHtml(alert.question)}</span>
          <em>${formatAlertChange(alert)}</em>
        </button>
      `;
    })
    .join("");
}

function renderProfitWalletMonitor() {
  if (!els.profitMonitorFeed || !els.profitMonitorStatus || !els.profitMonitorCount) return;
  const visibleFeed = validProfitMonitorFeed(profitMonitorFeed);
  els.profitMonitorCount.textContent = visibleFeed.length;
  const knownCount = profitMonitorKnown.size;
  const scanText = profitMonitorLastScanAt ? `上次扫描 ${formatTime(profitMonitorLastScanAt)}` : "等待首次扫描";
  els.profitMonitorStatus.textContent = profitMonitorLoading
    ? `扫描 Top 盈利钱包中... 已有基线 ${knownCount} 个持仓`
    : `${scanText} · 基线 ${knownCount} 个持仓`;

  if (!visibleFeed.length) {
    els.profitMonitorFeed.innerHTML = `<div class="empty">暂无买入/卖出。首次扫描只建立基线，不推旧持仓。</div>`;
    return;
  }

  els.profitMonitorFeed.innerHTML = visibleFeed
    .map((item) => `
      <a class="profit-monitor-item ${item.action === "sell" ? "sell" : "buy"}" href="${escapeHtml(item.url || `https://www.42.space/event/${item.marketAddress}`)}" target="_blank" rel="noreferrer">
        <span class="alert-kind">${escapeHtml(profitMonitorKind(item))}</span>
        <strong>${escapeHtml(item.question || "Unknown market")}</strong>
        <span>${shortAddress(item.wallet || "")} · ${escapeHtml(item.outcomeName || "Outcome")} · ${profitMonitorWalletStats(item)}</span>
        <em>${item.action === "sell" ? "原持仓" : "持仓"} ${formatNumber(item.heldQuantity)} · ${item.action === "sell" ? "原价值" : "价值"} ${formatCompactMoney(item.currentValue)} · ${formatTime(item.detectedAt)}</em>
      </a>
    `)
    .join("");
}

function validProfitMonitorFeed(items) {
  return (items || []).filter((item) => {
    if (!item || !item.id) return false;
    if (item.action !== "sell") return true;
    return (
      Number.isFinite(Number(item.walletRank)) &&
      Number(item.heldQuantity || 0) > 0 &&
      Number(item.currentValue || 0) > 0 &&
      item.question &&
      item.outcomeName
    );
  });
}

function profitMonitorKind(item) {
  const rank = `榜单 #${item.walletRank || "?"}`;
  return item.action === "sell" ? `${rank} 卖出/退出` : `${rank} 新买入`;
}

function profitMonitorWalletStats(item) {
  const pnl = Number(item.walletTotalPnl || 0);
  const roi = Number(item.walletRoi);
  const roiText = Number.isFinite(roi) ? ` / ROI ${roi.toFixed(1)}%` : "";
  return `总盈利 +${formatCompactMoney(pnl)}${roiText}`;
}

function renderMarkets({ preserveScroll = false } = {}) {
  const markets = filteredMarkets();
  els.marketCount.textContent = `${markets.length} 个标的`;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const openedOutcomeDetails = openedOutcomeDetailKeys();

  if (!markets.length) {
    els.markets.innerHTML = `<div class="empty">没有符合筛选条件的标的。</div>`;
    marketsRenderedOnce = true;
    return;
  }

  els.markets.innerHTML = groupMarkets(markets)
    .map((group) => `
      <section class="time-group">
        <div class="time-group-title">
          <div>
            <h3>${escapeHtml(group.label)}</h3>
            <p>${escapeHtml(group.hint)}</p>
          </div>
          <span>${group.markets.length} 个</span>
        </div>
        <div class="market-group-grid">
          ${group.markets.map(renderMarket).join("")}
        </div>
      </section>
    `)
    .join("");
  restoreOpenedOutcomeDetails(openedOutcomeDetails);
  marketsRenderedOnce = true;
  if (preserveScroll) requestAnimationFrame(() => window.scrollTo(scrollX, scrollY));
}

function openedOutcomeDetailKeys() {
  return new Set(
    [...els.markets.querySelectorAll(".market[data-market-address] > details.outcome-details[open]")]
      .map((details) => details.closest(".market")?.dataset.marketAddress?.toLowerCase())
      .filter(Boolean)
  );
}

function restoreOpenedOutcomeDetails(keys) {
  for (const address of keys) {
    const selector = `#${marketDomId(address)} > details.outcome-details`;
    document.querySelector(selector)?.setAttribute("open", "");
  }
}

function renderMarket(market) {
  const time = classifyTime(market);
  const topOutcome = bestOutcome(market);
  const countdownClass = countdownTone(time);
  return `
    <article class="market ${market.hasRecentAlert ? "hot" : ""}" id="${marketDomId(market.address)}" data-market-address="${escapeHtml(market.address)}">
      <div class="market-head">
        <div>
          <div class="row">
            <span class="badge">${escapeHtml(statusName(market.status))}</span>
            <span class="badge time ${countdownClass}">${escapeHtml(time.label)}</span>
            ${market.hasRecentAlert ? `<span class="badge danger">异动</span>` : ""}
            <span class="score">评分 ${market.score}</span>
          </div>
          <h3>${escapeHtml(market.question)}</h3>
        </div>
        <a class="open-link" href="${market.url}" target="_blank" rel="noreferrer">打开 42</a>
      </div>

      <div class="trade-strip">
        <div><span>时间窗口</span><strong class="${countdownClass}">${escapeHtml(time.hint)}</strong></div>
        <div><span>成交量</span><strong>${formatCompactMoney(market.volume)} ${escapeHtml(market.collateralSymbol)}</strong></div>
        <div><span>市值</span><strong>${formatCompactMoney(market.totalMarketCap)} ${escapeHtml(market.collateralSymbol)}</strong></div>
        <div><span>交易者</span><strong>${market.traders}</strong></div>
      </div>

      <div class="opportunity-line">
        <span>最高赔率：<strong>${topOutcome ? `${escapeHtml(topOutcome.name)} · ${formatSmall(topOutcome.payout)}` : "n/a"}</strong></span>
        <span>类别：${escapeHtml((market.categories || []).join(", ") || "n/a")}</span>
      </div>

      <details class="outcome-details">
        <summary>展开 ${market.outcomes.length} 个 Outcome 明细</summary>
        <div class="outcomes">
          ${market.outcomes.map(renderOutcome).join("")}
        </div>
      </details>
    </article>
  `;
}

function renderOutcome(outcome) {
  return `
    <div class="outcome">
      <strong>${escapeHtml(outcome.name)}</strong>
      <span>价格 ${formatSmall(outcome.price)}</span>
      <span>赔率 ${formatSmall(outcome.payout)}</span>
      <span>量 ${formatCompactMoney(outcome.volume)}</span>
      <span>市值 ${formatCompactMoney(outcome.marketCap)}</span>
    </div>
  `;
}

function renderProfitLeaderboard() {
  if (!els.profitLeaderboard || !els.profitSummary) return;

  if (profitLeaderboardLoading && !profitLeaderboard) {
    els.profitSummary.textContent = "正在扫描全市场 holders 和 PnL...";
    els.profitLeaderboard.innerHTML = `<div class="empty">全局榜单计算量较大，通常需要 10-40 秒。</div>`;
    return;
  }

  if (profitLeaderboardError) {
    els.profitSummary.textContent = "榜单拉取失败";
    els.profitLeaderboard.innerHTML = `<div class="empty">盈利榜单失败：${escapeHtml(profitLeaderboardError)}</div>`;
    return;
  }

  const wallets = profitLeaderboard?.wallets || [];
  if (!wallets.length) {
    els.profitSummary.textContent = profitLeaderboard ? "当前 holders 中没有检测到盈利钱包" : "等待数据";
    els.profitLeaderboard.innerHTML = `<div class="empty">暂无盈利钱包榜单。</div>`;
    return;
  }

  els.profitSummary.innerHTML = `
    <span>扫描 <strong>${profitLeaderboard.scannedMarketCount ?? profitLeaderboard.marketCount}</strong> / ${profitLeaderboard.marketCount} 个标的</span>
    <span>上榜 <strong>${wallets.length}</strong> 个钱包</span>
    <span>榜单正收益合计 <strong>${formatCompactMoney(profitLeaderboard.summary?.totalPositivePnl || 0)}</strong></span>
    <span>更新时间 <strong>${formatTime(profitLeaderboard.generatedAt)}</strong></span>
    ${profitLeaderboard.skippedMarketCount ? `<span>限流跳过 <strong>${profitLeaderboard.skippedMarketCount}</strong> 个</span>` : ""}
  `;
  els.profitLeaderboard.innerHTML = wallets.slice(0, 30).map(renderProfitWalletRow).join("");
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
            ? `<button type="button" data-market-address="${escapeHtml(main.marketAddress)}">${escapeHtml(main.question)}</button>
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
    <button class="profit-position-item" type="button" data-market-address="${escapeHtml(position.marketAddress)}">
      <strong>${escapeHtml(position.question)}</strong>
      <span>${escapeHtml(position.outcomeName || position.name || "Outcome")} · +${formatCompactMoney(position.totalPnl)} · ROI ${position.roi === null ? "n/a" : `${position.roi.toFixed(1)}%`}</span>
    </button>
  `;
}

function filteredMarkets() {
  const keyword = els.keyword.value.trim().toLowerCase();
  const status = els.status.value;
  const category = els.category.value;
  const timeType = els.timeType.value;

  return [...(snapshot.markets || [])]
    .filter((market) => quickFilter === "all" || quickFilterMatch(market))
    .filter((market) => !status || market.status === status)
    .filter((market) => !category || (market.categories || []).includes(category))
    .filter((market) => !timeType || classifyTime(market).key === timeType)
    .filter((market) => {
      if (!keyword) return true;
      const text = `${market.question} ${market.address} ${(market.categories || []).join(" ")} ${market.outcomes.map((outcome) => outcome.name).join(" ")}`.toLowerCase();
      return text.includes(keyword);
    })
    .sort((a, b) => Number(b.hasRecentAlert) - Number(a.hasRecentAlert) || b.score - a.score || new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function quickFilterMatch(market) {
  if (quickFilter === "alerts") return market.hasRecentAlert;
  if (quickFilter === "new") return classifyTime(market).key === "new";
  if (quickFilter === "endingSoon") return classifyTime(market).key === "endingSoon";
  if (quickFilter === "crypto") return isCryptoMarket(market);
  return true;
}

function groupMarkets(markets) {
  const order = ["new", "startingSoon", "live", "endingSoon", "waitingResolution", "ended", "other"];
  const map = new Map(order.map((key) => [key, { key, label: timeTypeLabel(key), hint: timeTypeHint(key), markets: [] }]));
  for (const market of markets) {
    const type = classifyTime(market).key;
    if (!map.has(type)) map.set(type, { key: type, label: timeTypeLabel(type), hint: timeTypeHint(type), markets: [] });
    map.get(type).markets.push(market);
  }
  return [...map.values()].filter((group) => group.markets.length);
}

function classifyTime(market) {
  const now = Date.now();
  const status = String(market.status || "").toLowerCase();
  const createdAt = market.createdAt ? new Date(market.createdAt).getTime() : null;
  const startAt = market.startDate ? new Date(market.startDate).getTime() : null;
  const endAt = market.endDate ? new Date(market.endDate).getTime() : null;
  const resolutionAt = market.resolutionTime ? new Date(market.resolutionTime).getTime() : null;
  const ageMinutes = createdAt ? (now - createdAt) / 60000 : Infinity;

  if (ageMinutes >= 0 && ageMinutes <= 30) return { key: "new", label: "新创建", hint: `创建 ${formatDuration(ageMinutes)}` };
  if (["resolved", "finalised", "finalized", "ended", "closed", "cancelled", "canceled"].includes(status)) return { key: "ended", label: "已结束", hint: "交易窗口已结束" };
  if (startAt && now < startAt) {
    const minutes = Math.max(0, Math.round((startAt - now) / 60000));
    return { key: minutes <= 60 ? "startingSoon" : "other", label: minutes <= 60 ? "即将开始" : "未开始", hint: `${formatDuration(minutes)}后开始` };
  }
  if (endAt && now >= endAt) {
    if (resolutionAt && now < resolutionAt) return { key: "waitingResolution", label: "等待结算", hint: `${formatDuration(Math.max(0, Math.round((resolutionAt - now) / 60000)))}后结算` };
    return { key: "ended", label: "已结束", hint: "交易窗口已结束" };
  }
  if (startAt && endAt && now >= startAt && now < endAt) {
    const minutesLeft = Math.round((endAt - now) / 60000);
    return { key: minutesLeft <= 60 ? "endingSoon" : "live", label: minutesLeft <= 60 ? "临近结束" : "进行中", hint: `剩余 ${formatDuration(minutesLeft)}` };
  }
  return { key: "other", label: "未开始 / 其他", hint: "时间信息不完整或距离开始较远" };
}

function timeTypeLabel(key) {
  return { new: "新创建", startingSoon: "即将开始", live: "进行中", endingSoon: "临近结束", waitingResolution: "等待结算", ended: "已结束", other: "未开始 / 其他" }[key] || key;
}

function timeTypeHint(key) {
  return {
    new: "适合看首批资金和赔率分布",
    startingSoon: "开盘前观察是否提前放量",
    live: "主要交易窗口，关注成交和赔率变化",
    endingSoon: "信息差和冲刺交易最集中",
    waitingResolution: "等待结果确认，谨慎追单",
    ended: "交易窗口结束，只做复盘",
    other: "距离交易窗口较远，优先级较低"
  }[key] || "";
}

function statusName(status) {
  return { live: "进行中", not_started: "未开始", ended: "已结束", resolved: "已解决", finalised: "已最终确认" }[status] || status;
}

function metricName(metric) {
  return { newMarket: "新标的上线", startingSoon: "新事件即将上线", totalMarketCap: "市值拉升", marketCap: "Outcome 市值拉升", volume: "成交放量", price: "价格拉升", traders: "交易者增加" }[metric] || metric;
}

function alertToneClass(alert) {
  const metric = alert?.metric;
  if (metric === "newMarket") return "alert-tone-new";
  if (metric === "startingSoon") return "alert-tone-upcoming";
  if (metric === "volume") return "alert-tone-volume";
  if (metric === "totalMarketCap" || metric === "marketCap") return "alert-tone-marketcap";
  if (metric === "traders") return "alert-tone-traders";
  if (metric === "price") return "alert-tone-price";
  if (metric === "test") return "alert-tone-test";
  return "alert-tone-default";
}

function formatAlertChange(alert) {
  if (alert.metric === "newMarket") return `初始市值 ${formatCompactMoney(alert.current)} · ${formatTime(alert.createdAt)}`;
  if (alert.metric === "startingSoon") return `${formatNumber(alert.current)} 分钟后开始 · ${formatTime(alert.startDate || alert.createdAt)}`;
  if (alert.metric === "traders") return `+${formatNumber(alert.changePct)} 人 · ${formatNumber(alert.previous)} → ${formatNumber(alert.current)} · ${formatTime(alert.createdAt)}`;
  const label = { totalMarketCap: "市值", marketCap: "市值", volume: "成交量", price: "价格" }[alert.metric] || "数值";
  const delta = Number(alert.current || 0) - Number(alert.previous || 0);
  const pct = Number.isFinite(alert.changePct) ? `+${alert.changePct.toFixed(1)}%` : "";
  const formatter = alert.metric === "price" ? formatSmall : formatCompactMoney;
  return `${pct} · ${label} +${formatter(delta)} · ${formatter(alert.previous)} → ${formatter(alert.current)} · ${formatTime(alert.createdAt)}`;
}

function isCryptoMarket(market) {
  const text = `${market.question} ${(market.categories || []).join(" ")} ${(market.tags || []).join(" ")}`.toLowerCase();
  return /(crypto|btc|bitcoin|eth|ethereum|bnb|sol|token|binance|coingecko|fdv|market cap|usdt)/.test(text);
}

function bestOutcome(market) {
  return [...(market.outcomes || [])].sort((a, b) => Number(b.payout || 0) - Number(a.payout || 0))[0];
}

function countdownTone(time) {
  const minutes = minutesFromHint(time.hint);
  if (minutes === null) return "";
  if (time.key === "endingSoon" && minutes <= 15) return "urgent";
  if (time.key === "endingSoon" && minutes <= 60) return "warning";
  if (time.key === "startingSoon") return "warning";
  return "";
}

function minutesFromHint(hint) {
  const days = Number(hint.match(/(\d+)\s*天/)?.[1] || 0);
  const hours = Number(hint.match(/(\d+)\s*时/)?.[1] || 0);
  const minutes = Number(hint.match(/(\d+)\s*分/)?.[1] || 0);
  if (!days && !hours && !minutes && !/0\s*分/.test(hint)) return null;
  return days * 1440 + hours * 60 + minutes;
}

function formatDuration(totalMinutes) {
  const safeMinutes = Math.max(0, Math.round(Number(totalMinutes || 0)));
  const days = Math.floor(safeMinutes / 1440);
  const hours = Math.floor((safeMinutes % 1440) / 60);
  const minutes = safeMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}天`);
  if (hours || days) parts.push(`${hours}时`);
  parts.push(`${minutes}分`);
  return parts.join("");
}

function formatNumber(value) {
  const number = Number(value || 0);
  if (Math.abs(number) >= 1000) return number.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(number) >= 1) return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return number.toLocaleString("en-US", { maximumSignificantDigits: 4 });
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

function formatSmall(value) {
  return Number(value || 0).toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

function formatTime(value) {
  if (!value) return "n/a";
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

async function loadProfitLeaderboard() {
  if (profitLeaderboardLoading) return;
  profitLeaderboardLoading = true;
  profitLeaderboardError = "";
  renderProfitLeaderboard();

  try {
    const response = await fetch(apiPath("/api/profit-leaderboard?limit=50&marketLimit=100"), { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    profitLeaderboard = data;
  } catch (error) {
    profitLeaderboardError = error.message;
  } finally {
    profitLeaderboardLoading = false;
    renderProfitLeaderboard();
    if (snapshot) renderRadar();
  }
}

async function loadProfitWalletMonitor({ force = false } = {}) {
  if (!els.profitMonitorFeed || profitMonitorLoading) return;
  profitMonitorLoading = true;
  renderProfitWalletMonitor();

  try {
    const response = await fetch(apiPath(`/api/profit-wallet-monitor${force ? "?force=1" : ""}`), { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    profitMonitorKnown = new Set(Array.from({ length: Number(data.knownPositionCount || 0) }, (_, index) => `server:${index}`));
    const previousIds = new Set(profitMonitorFeed.map((item) => item.id));
    const serverActivities = Array.isArray(data.activities) ? data.activities : [];
    const mergedActivities = new Map(profitMonitorFeed.map((item) => [item.id, item]));
    for (const item of serverActivities) {
      if (item?.id) mergedActivities.set(item.id, item);
    }
    profitMonitorFeed = validProfitMonitorFeed([...mergedActivities.values()])
      .sort((a, b) => new Date(b.detectedAt || 0) - new Date(a.detectedAt || 0))
      .slice(0, PROFIT_MONITOR_FEED_LIMIT);
    saveProfitMonitorFeed();
    const newItems = serverActivities.filter((item) => item?.id && !previousIds.has(item.id));
    if (newItems.length && previousIds.size) {
      const buyCount = newItems.filter((item) => item.action !== "sell").length;
      const sellCount = newItems.filter((item) => item.action === "sell").length;
      const summary = [
        buyCount ? `${buyCount} 个新买入` : "",
        sellCount ? `${sellCount} 个卖出/退出` : ""
      ]
        .filter(Boolean)
        .join("，");
      showPageAlert({
        metric: "test",
        question: `盈利钱包监控：${summary}`,
        marketAddress: newItems[0]?.marketAddress || ""
      });
      if (soundAlertsEnabled) playAlertSound();
    }
    profitMonitorLastScanAt = data.generatedAt || new Date().toISOString();
  } catch (error) {
    els.profitMonitorStatus.textContent = `监控扫描失败：${error.message}`;
  } finally {
    profitMonitorLoading = false;
    renderProfitWalletMonitor();
  }
}

function profitMonitorPositionKey(walletAddress, position) {
  return [
    String(walletAddress || "").toLowerCase(),
    String(position.marketAddress || "").toLowerCase(),
    String(position.tokenId || position.outcomeName || position.name || "").toLowerCase()
  ].join("|");
}

function shortAddress(address) {
  const text = String(address || "");
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function confidenceName(value) {
  return { high: "高置信", medium: "中置信", low: "低置信" }[value] || value;
}

function marketDomId(address) {
  return `market-${String(address || "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

function focusMarket(address) {
  quickFilter = "all";
  els.keyword.value = "";
  els.status.value = "";
  els.category.value = "";
  els.timeType.value = "";
  syncAllCustomSelects();
  renderRadar();
  renderMarkets();

  requestAnimationFrame(() => {
    const card = document.querySelector(`#${marketDomId(address)}`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("focus-pulse");
    setTimeout(() => card.classList.remove("focus-pulse"), 2200);
  });
}

function handleIncomingAlerts(alerts) {
  mergeAlertFeed(alerts);
  if (!firstSnapshotLoaded) {
    for (const alert of alerts) knownAlertIds.add(alertIdentity(alert));
    firstSnapshotLoaded = true;
    return;
  }
  const freshAlerts = [];
  for (const alert of alerts) {
    const key = alertIdentity(alert);
    if (knownAlertIds.has(key)) continue;
    knownAlertIds.add(key);
    freshAlerts.push(alert);
  }
  for (const alert of freshAlerts.reverse()) triggerBrowserAlert(alert);
}

function loadStoredAlertFeed() {
  try {
    const stored = JSON.parse(localStorage.getItem(ALERT_FEED_STORAGE_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter(Boolean).slice(0, ALERT_FEED_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveAlertFeed() {
  try {
    localStorage.setItem(ALERT_FEED_STORAGE_KEY, JSON.stringify(alertFeed.slice(0, ALERT_FEED_LIMIT)));
  } catch {
    // Local persistence is best-effort; the live feed still works in memory.
  }
}

function mergeAlertFeed(alerts) {
  if (!Array.isArray(alerts) || !alerts.length) return;
  const merged = new Map(alertFeed.map((alert) => [alertIdentity(alert), alert]));
  for (const alert of alerts) {
    const key = alertIdentity(alert);
    if (!key) continue;
    merged.set(key, alert);
  }
  alertFeed = [...merged.values()]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, ALERT_FEED_LIMIT);
  saveAlertFeed();
}

function alertIdentity(alert) {
  if (!alert) return "";
  if (alert.id) return alert.id;
  return [alert.marketAddress, alert.metric, alert.outcome?.name || "", alert.createdAt || ""].join("|");
}

function loadStoredSet(key) {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "[]");
    return new Set(Array.isArray(stored) ? stored.filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function saveStoredSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify([...value].slice(-3000)));
  } catch {
    // Local persistence is best-effort; the monitor keeps working in memory.
  }
}

function loadStoredProfitMonitorFeed() {
  try {
    const stored = JSON.parse(localStorage.getItem(PROFIT_MONITOR_FEED_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter(Boolean).slice(0, PROFIT_MONITOR_FEED_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveProfitMonitorFeed() {
  try {
    localStorage.setItem(PROFIT_MONITOR_FEED_KEY, JSON.stringify(profitMonitorFeed.slice(0, PROFIT_MONITOR_FEED_LIMIT)));
  } catch {
    // Local persistence is best-effort; the monitor keeps working in memory.
  }
}

async function enableBrowserAlerts() {
  if (!("Notification" in window) || Notification.permission === "denied") {
    enableSoundFallback();
    return;
  }

  if (Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      browserAlertsEnabled = false;
      localStorage.removeItem("fortytwoBrowserAlerts");
      enableSoundFallback();
      return renderNotifyState();
    }
  }
  browserAlertsEnabled = true;
  soundAlertsEnabled = true;
  localStorage.setItem("fortytwoBrowserAlerts", "1");
  localStorage.setItem("fortytwoSoundAlerts", "1");
  playAlertSound();
  showBrowserNotification({ question: "42 事件战壕提醒已启用", metric: "test", changePct: 0, marketAddress: "" });
  showPageAlert({ question: "浏览器通知和声音提醒已启用", metric: "test", changePct: 0, marketAddress: "" });
  renderNotifyState();
}

function triggerBrowserAlert(alert) {
  if (!browserAlertsEnabled && !soundAlertsEnabled) return;
  if (soundAlertsEnabled) playAlertSound();
  showPageAlert(alert);
  flashTitle(alert);
  if (browserAlertsEnabled && "Notification" in window && Notification.permission === "granted") {
    showBrowserNotification(alert);
  }
}

function enableSoundFallback() {
  browserAlertsEnabled = false;
  soundAlertsEnabled = true;
  localStorage.removeItem("fortytwoBrowserAlerts");
  localStorage.setItem("fortytwoSoundAlerts", "1");
  renderNotifyState();
  showPageAlert({ question: "已启用声音和页面内提醒", metric: "test", changePct: 0, marketAddress: "" });
  playAlertSound();
}

function showBrowserNotification(alert) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const subject = alert.metric === "newMarket" ? "新标的上线" : alert.outcome ? alert.outcome.name : metricName(alert.metric || "test");
  const change =
    alert.metric === "newMarket"
      ? `初始市值 ${formatCompactMoney(alert.current)}`
      : alert.metric === "startingSoon"
        ? `${formatNumber(alert.current)} 分钟后开始`
        : alert.metric === "traders"
          ? `+${alert.changePct}`
          : Number.isFinite(alert.changePct)
            ? `+${alert.changePct.toFixed(1)}%`
            : "已启用";
  try {
    const notification = new Notification("42 事件战壕异动", {
      body: `${subject} · ${change}\n${alert.question}`,
      tag: alert.id || `fortytwo-${Date.now()}`,
      renotify: true
    });
    notification.onclick = () => {
      window.focus();
      if (alert.marketAddress) focusMarket(alert.marketAddress);
      notification.close();
    };
  } catch {
    // Some embedded browsers expose Notification but still reject construction.
  }
}

function showPageAlert(alert) {
  if (!els.toastHost) return;
  const toast = document.createElement("button");
  toast.className = `toast ${alertToneClass(alert)}`;
  toast.type = "button";
  const subject = alert.metric === "newMarket" ? "新标的上线" : alert.outcome ? alert.outcome.name : metricName(alert.metric || "test");
  const change = alert.metric === "test" ? "提醒链路已启用" : formatAlertChange(alert);
  toast.innerHTML = `
    <strong>${escapeHtml(subject)}</strong>
    <span>${escapeHtml(change)}</span>
    <span>${escapeHtml(alert.question || "")}</span>
  `;
  toast.addEventListener("click", () => {
    if (alert.marketAddress) focusMarket(alert.marketAddress);
    toast.remove();
  });
  els.toastHost.prepend(toast);
  while (els.toastHost.children.length > 4) els.toastHost.lastElementChild.remove();
  setTimeout(() => toast.remove(), 12000);
}

function flashTitle(alert) {
  clearInterval(titleFlashTimer);
  let visible = false;
  const title = alert.metric === "newMarket" ? "新标的上线" : metricName(alert.metric || "异动");
  titleFlashTimer = setInterval(() => {
    document.title = visible ? originalTitle : `【42异动】${title}`;
    visible = !visible;
  }, 900);
  setTimeout(() => {
    clearInterval(titleFlashTimer);
    document.title = originalTitle;
  }, 9000);
}

function ensureAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  try {
    if (!audioContext) audioContext = new AudioContextClass();
    if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
    return audioContext;
  } catch {
    return null;
  }
}

function playAlertSound(durationMs = 3000) {
  const nowMs = Date.now();
  if (nowMs < alertSoundActiveUntil) return;

  const ctx = ensureAudioContext();
  if (!ctx) return;
  alertSoundActiveUntil = nowMs + durationMs;

  try {
    const startAt = ctx.currentTime + 0.03;
    const duration = durationMs / 1000;
    const pulseGap = 0.42;
    const toneDuration = 0.16;
    const frequencies = [960, 1280];

    for (let pulseAt = 0; pulseAt < duration; pulseAt += pulseGap) {
      for (const [index, frequency] of frequencies.entries()) {
        const toneAt = startAt + pulseAt + index * toneDuration;
        if (toneAt + toneDuration > startAt + duration) continue;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, toneAt);
        gain.gain.exponentialRampToValueAtTime(0.11, toneAt + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, toneAt + toneDuration);
        gain.connect(ctx.destination);

        const oscillator = ctx.createOscillator();
        oscillator.type = "square";
        oscillator.frequency.setValueAtTime(frequency, toneAt);
        oscillator.connect(gain);
        oscillator.start(toneAt);
        oscillator.stop(toneAt + toneDuration);
      }
    }
  } catch {
    // Audio is best-effort; page and Telegram alerts still work.
    alertSoundActiveUntil = 0;
  }
}

function updateCountdown() {
  if (!nextRefreshAt) return;
  const seconds = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  els.nextRefresh.textContent = `下次刷新 ${seconds}s`;
}

[els.keyword, els.status, els.category, els.timeType].forEach((el) => {
  el.addEventListener("input", renderMarkets);
  el.addEventListener("change", renderMarkets);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".custom-select")) closeCustomSelects();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeCustomSelects();
});

for (const button of els.quickButtons) {
  button.addEventListener("click", () => {
    quickFilter = button.dataset.quick;
    renderRadar();
    renderMarkets();
  });
}

els.enableAlerts.addEventListener("click", enableBrowserAlerts);

els.alerts.addEventListener("click", (event) => {
  const alert = event.target.closest("[data-market-address]");
  if (!alert) return;
  focusMarket(alert.dataset.marketAddress);
});

els.profitLeaderboard?.addEventListener("click", (event) => {
  const target = event.target.closest("[data-market-address]");
  if (!target) return;
  focusMarket(target.dataset.marketAddress);
});

els.refreshProfitLeaderboard?.addEventListener("click", loadProfitLeaderboard);
els.refreshProfitMonitor?.addEventListener("click", () => loadProfitWalletMonitor({ force: true }));

setupCustomSelects();
await loadSnapshot();
renderProfitWalletMonitor();
loadProfitWalletMonitor();
setInterval(loadSnapshot, 5000);
setInterval(loadProfitWalletMonitor, 60000);
setInterval(updateCountdown, 250);
