import { loadHoldings, loadCash } from "./csv.js";
import {
  getQuotesBatch,
} from "./api.js";
import {
  fxSymbolsForCurrencies,
  rateFromQuotes,
} from "./fx.js";
import {
  fmtMoney,
  fmtNative,
  fmtSignedMoney,
  fmtSignedPercent,
  fmtRelativeTime,
  changeClass,
} from "./format.js";
import { loadSnapshot } from "./snapshot.js";
import { parseAllSymbols } from "./parse.js";

const VERIFIED_SVG = `<svg class="verified" viewBox="0 0 24 24" aria-label="bought for client" focusable="false"><rect x="3" y="3" width="18" height="18" rx="4" ry="4" fill="#1d9bf0"/><path d="M7.5 12.5l3 3 6-6.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

const EXTERNAL_SVG = `<svg class="link-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42L17.59 5H14V3z" fill="currentColor"/><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7z" fill="currentColor"/></svg>`;

const state = {
  rows: [],          // main holdings, used by All / V / Mike / market tabs
  cash: [],          // { date, amount, currency, usdRate, amountUsd, client }
  bears: [],         // bear-tab-only holdings, NOT counted in "All"
  sort: "value",
  market: "All",
  overviewOpen: false,
  updatedAt: null,
};

const BEAR_TAB = "🐻";

// European holdings collapse into a single tab. Includes UK / Switzerland
// even though they're not in the political EU — the tab is "European
// markets" in spirit, just labelled "EU" for brevity.
const EU_TAB = "EU";
const EU_MARKETS = new Set([
  "Sweden", "UK", "Germany", "Italy", "France", "Netherlands", "Switzerland",
]);


const $ = (id) => document.getElementById(id);

// Derive a public-CDN logo URL from a ticker symbol.
// US stocks (no exchange suffix): Finnhub's static asset CDN has the broadest
// coverage for US-listed companies including small-caps. The URL pattern
// mirrors what Finnhub returns from its /stock/profile2 endpoint and is
// served publicly without auth.
// International stocks (suffix like .TW, .L): FMP's image CDN resolves many
// global tickers by stripping the suffix. Both fall back to the first letter
// via onerror when the image doesn't exist.
function inferLogoUrl(symbol) {
  const base = symbol.split(".")[0].toUpperCase();
  if (!base) return null;
  if (!symbol.includes(".")) {
    return `https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/${encodeURIComponent(base)}.png`;
  }
  return `https://financialmodelingprep.com/image-stock/${encodeURIComponent(base)}.png`;
}

function logoEl(symbol, profile) {
  const wrap = document.createElement("div");
  wrap.className = "logo";
  const url = profile?.logo || inferLogoUrl(symbol);
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = `${symbol} logo`;
    img.loading = "lazy";
    img.onerror = () => {
      wrap.textContent = symbol.charAt(0);
      img.remove();
    };
    wrap.appendChild(img);
  } else {
    wrap.textContent = symbol.charAt(0);
  }
  return wrap;
}

function uniqueCurrencies() {
  const out = new Set();
  for (const r of state.rows) if (r.holding.currency) out.add(r.holding.currency);
  for (const r of state.bears) if (r.holding.currency) out.add(r.holding.currency);
  for (const c of state.cash) if (c.currency) out.add(c.currency);
  out.delete("USD");
  return [...out];
}

function applyFxRates(rates) {
  if (!rates) return;
  const enrich = (h) => {
    if (h.currency === "USD") return;
    const rate = rates[h.currency];
    if (isFinite(rate) && rate > 0) {
      h.usdRate = rate;
      h.totalCostUsd = h.totalCostNative * rate;
    }
  };
  for (const r of state.rows) enrich(r.holding);
  for (const r of state.bears) enrich(r.holding);
  for (const c of state.cash) {
    if (isFinite(c.usdRate) && c.usdRate > 0) continue; // CSV had explicit rate
    const rate = rates[c.currency];
    if (isFinite(rate) && rate > 0) {
      c.usdRate = rate;
      c.amountUsd = c.amount * rate;
    }
  }
}

function rowMetrics(row) {
  const { holding, quote } = row;
  if (!quote || !isFinite(quote.c) || quote.c <= 0) {
    return { hasQuote: false };
  }
  const priceNative = quote.c;
  const mvNative = priceNative * holding.shares;
  const mvUsd = mvNative * holding.usdRate;
  const totalReturnUsd = mvUsd - holding.totalCostUsd;
  const totalReturnPct = (totalReturnUsd / holding.totalCostUsd) * 100;
  const dayChangeNative = (quote.d ?? 0) * holding.shares;
  const dayChangeUsd = dayChangeNative * holding.usdRate;
  return {
    hasQuote: true,
    priceNative,
    mvNative,
    mvUsd,
    totalReturnUsd,
    totalReturnPct,
    dayChangeNative,
    dayChangeUsd,
    dpDay: quote.dp,
  };
}

function renderRow(row) {
  const { holding, quote, profile } = row;
  const m = rowMetrics(row);

  const a = document.createElement("div");
  a.className = "row";
  a.dataset.symbol = holding.symbol;
  a.tabIndex = 0;
  a.setAttribute("role", "link");

  a.appendChild(logoEl(holding.symbol, profile));

  const meta = document.createElement("div");
  meta.className = "meta";

  const symbolLine = document.createElement("div");
  symbolLine.className = "symbol-line";
  const sym = document.createElement("span");
  sym.className = "symbol";
  sym.textContent = holding.symbol;
  symbolLine.appendChild(sym);
  if (profile && profile.name) {
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = profile.name;
    symbolLine.appendChild(name);
  }
  if (holding.client) {
    const verified = document.createElement("span");
    verified.className = "verified-wrap";
    verified.innerHTML = VERIFIED_SVG;
    symbolLine.appendChild(verified);
  }

  const quoteBtn = document.createElement("a");
  quoteBtn.className = "quote-btn";
  quoteBtn.href = `stock.html?symbol=${encodeURIComponent(holding.symbol)}`;
  quoteBtn.textContent = "Detailed Quote";
  symbolLine.appendChild(quoteBtn);

  if (holding.link) {
    const link = document.createElement("a");
    link.className = "link-btn";
    link.href = holding.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = "Open external page";
    link.setAttribute("aria-label", `Open external page for ${holding.symbol}`);
    link.innerHTML = EXTERNAL_SVG;
    symbolLine.appendChild(link);
  }
  meta.appendChild(symbolLine);

  const sub = document.createElement("div");
  sub.className = "sub";
  sub.append(
    `${holding.shares} sh · cost ${fmtNative(holding.unitCost, holding.currency)}`,
  );
  if (holding.platform) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = holding.platform;
    sub.appendChild(chip);
  }
  if (holding.market && holding.market !== "US") {
    const chip = document.createElement("span");
    chip.className = "chip muted";
    chip.textContent = holding.market;
    sub.appendChild(chip);
  }
  meta.appendChild(sub);

  a.appendChild(meta);

  const right = document.createElement("div");
  right.className = "right";

  if (m.hasQuote) {
    const priceEl = document.createElement("div");
    priceEl.className = "price";
    priceEl.textContent = fmtNative(m.priceNative, holding.currency);

    const dayEl = document.createElement("div");
    dayEl.className = `ch ${changeClass(m.dayChangeUsd)}`;
    dayEl.textContent = `${fmtSignedPercent(m.dpDay)} ${quote?.extendedLabel?.toLowerCase() ?? "today"}`;

    const mvLine = document.createElement("div");
    mvLine.className = "mv";
    const isUsd = holding.currency === "USD";
    const usdPart = `${isUsd ? "" : "≈ "}${fmtMoney(m.mvUsd)}`;
    const returnSpan =
      `<span class="${changeClass(m.totalReturnUsd)}">` +
      `${fmtSignedMoney(m.totalReturnUsd)} (${fmtSignedPercent(m.totalReturnPct)})</span>`;
    mvLine.innerHTML = `${usdPart} · ${returnSpan}`;

    right.append(priceEl, dayEl, mvLine);
  } else {
    const priceEl = document.createElement("div");
    priceEl.className = "price";
    priceEl.textContent = "—";
    const dayEl = document.createElement("div");
    dayEl.className = "ch muted";
    dayEl.textContent = "no quote";
    const mvEl = document.createElement("div");
    mvEl.className = "mv";
    mvEl.textContent = `cost ${fmtMoney(holding.totalCostUsd)}`;
    right.append(priceEl, dayEl, mvEl);
  }

  a.appendChild(right);
  return a;
}

function renderCashRow(cash) {
  const a = document.createElement("div");
  a.className = "row cash-row";

  const logo = document.createElement("div");
  logo.className = "logo cash-logo";
  logo.textContent = "$";
  a.appendChild(logo);

  const meta = document.createElement("div");
  meta.className = "meta";

  const symbolLine = document.createElement("div");
  symbolLine.className = "symbol-line";
  const sym = document.createElement("span");
  sym.className = "symbol";
  sym.textContent = "Cash";
  symbolLine.appendChild(sym);
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = cash.currency;
  symbolLine.appendChild(name);
  meta.appendChild(symbolLine);

  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = "Available cash";
  meta.appendChild(sub);

  a.appendChild(meta);

  const right = document.createElement("div");
  right.className = "right";
  const priceEl = document.createElement("div");
  priceEl.className = "price";
  priceEl.textContent = fmtNative(cash.amount, cash.currency);
  right.appendChild(priceEl);
  if (cash.currency !== "USD") {
    const mvLine = document.createElement("div");
    mvLine.className = "mv";
    mvLine.textContent = `≈ ${fmtMoney(cash.amountUsd)}`;
    right.appendChild(mvLine);
  }
  a.appendChild(right);
  return a;
}

function sortRows(rows, sort) {
  const copy = [...rows];
  copy.sort((a, b) => {
    const aM = rowMetrics(a);
    const bM = rowMetrics(b);
    if (sort === "value") {
      return (bM.mvUsd ?? 0) - (aM.mvUsd ?? 0);
    }
    if (sort === "change") {
      return (bM.totalReturnPct ?? -Infinity) - (aM.totalReturnPct ?? -Infinity);
    }
    return a.holding.symbol.localeCompare(b.holding.symbol);
  });
  return copy;
}

function filteredRows() {
  if (state.market === BEAR_TAB) return state.bears;
  if (state.market === "All") return state.rows;
  if (state.market === "V") return state.rows.filter((r) => r.holding.client);
  if (state.market === "Mike") return state.rows.filter((r) => !r.holding.client);
  if (state.market === EU_TAB) return state.rows.filter((r) => EU_MARKETS.has(r.holding.market));
  return state.rows.filter((r) => r.holding.market === state.market);
}

function filteredCash() {
  if (state.market === BEAR_TAB) return [];   // bear bucket has no cash
  if (state.market === "All") return state.cash;
  if (state.market === "V") return state.cash.filter((c) => c.client);
  if (state.market === "Mike") return state.cash.filter((c) => !c.client);
  // Market-specific tabs (US, Taiwan, etc.) don't carry a cash bucket — cash
  // isn't tied to an exchange.
  return [];
}

// Roll multiple CSV cash entries into one display row per currency.
function consolidateCash(entries) {
  const byCurrency = new Map();
  for (const c of entries) {
    const cur = byCurrency.get(c.currency) || {
      currency: c.currency,
      usdRate: c.usdRate,
      amount: 0,
      amountUsd: 0,
    };
    cur.amount += c.amount;
    cur.amountUsd += c.amountUsd;
    byCurrency.set(c.currency, cur);
  }
  return [...byCurrency.values()].sort((a, b) => b.amountUsd - a.amountUsd);
}

function renderHoldings() {
  const list = $("holdings");
  list.innerHTML = "";
  const sorted = sortRows(filteredRows(), state.sort);
  const cashRows = consolidateCash(filteredCash());

  if (!sorted.length && !cashRows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = `No ${state.market} holdings.`;
    list.appendChild(empty);
    return;
  }
  // Cash sits at the top of the list.
  for (const cash of cashRows) {
    list.appendChild(renderCashRow(cash));
  }
  for (const row of sorted) {
    list.appendChild(renderRow(row));
  }
}

function renderTabs() {
  // Holdings subtotals (state.rows only — bears are tracked separately).
  const groups = new Map();
  let totalHoldingsUsd = 0;
  let clientHoldingsUsd = 0;
  let nonClientHoldingsUsd = 0;
  let hasClient = false;
  let hasNonClient = false;
  for (const r of state.rows) {
    const m = rowMetrics(r);
    const usd = m.hasQuote ? m.mvUsd : r.holding.totalCostUsd;
    totalHoldingsUsd += usd;
    const k = EU_MARKETS.has(r.holding.market) ? EU_TAB : r.holding.market;
    groups.set(k, (groups.get(k) || 0) + usd);
    if (r.holding.client) { hasClient = true; clientHoldingsUsd += usd; }
    else { hasNonClient = true; nonClientHoldingsUsd += usd; }
  }

  // Cash subtotals.
  let totalCashUsd = 0, clientCashUsd = 0, nonClientCashUsd = 0;
  for (const c of state.cash) {
    totalCashUsd += c.amountUsd;
    if (c.client) clientCashUsd += c.amountUsd;
    else nonClientCashUsd += c.amountUsd;
  }

  // Bear subtotal — completely separate, NOT included in "All" / V / Mike.
  let bearUsd = 0;
  for (const r of state.bears) {
    const m = rowMetrics(r);
    bearUsd += m.hasQuote ? m.mvUsd : r.holding.totalCostUsd;
  }

  const totalUsd = totalHoldingsUsd + totalCashUsd;
  const clientUsd = clientHoldingsUsd + clientCashUsd;
  const nonClientUsd = nonClientHoldingsUsd + nonClientCashUsd;

  // Sort markets by descending USD value, but pin EU last so it sits
  // immediately to the left of the bear tab.
  const marketKeys = [...groups.keys()].filter((k) => k !== EU_TAB);
  marketKeys.sort((a, b) => groups.get(b) - groups.get(a));
  if (groups.has(EU_TAB)) marketKeys.push(EU_TAB);
  const markets = marketKeys;
  const tabs = ["All"];
  if (hasClient || clientCashUsd > 0) tabs.push("V");
  if (hasNonClient || nonClientCashUsd > 0) tabs.push("Mike");
  tabs.push(...markets);
  if (state.bears.length) tabs.push(BEAR_TAB);

  const tabsEl = $("tabs");
  tabsEl.innerHTML = "";
  for (const t of tabs) {
    const btn = document.createElement("button");
    btn.className = "tab" + (state.market === t ? " active" : "");
    if (t === "V") btn.classList.add("tab-client");
    btn.dataset.market = t;
    const value =
      t === "All" ? totalUsd
      : t === "V" ? clientUsd
      : t === "Mike" ? nonClientUsd
      : t === BEAR_TAB ? bearUsd
      : groups.get(t);
    btn.innerHTML =
      `<span class="t-label">${t}${t === "V" ? VERIFIED_SVG : ""}</span>` +
      `<span class="t-value">${fmtMoney(value)}</span>`;
    tabsEl.appendChild(btn);
  }
}

function renderSummary() {
  // Summary follows the active tab — totals are scoped to whatever subset of
  // holdings is currently filtered into the list below.
  const rows = filteredRows();

  const labelEl = document.querySelector(".summary .label");
  if (labelEl) {
    labelEl.textContent =
      state.market === "All"
        ? "Portfolio value"
        : `Portfolio value · ${state.market}`;
  }

  let totalCostUsd = 0;
  let totalValueUsd = 0;
  let dayChangeUsd = 0;
  let havePrice = false;

  for (const r of rows) {
    totalCostUsd += r.holding.totalCostUsd;
    const m = rowMetrics(r);
    if (m.hasQuote) {
      havePrice = true;
      totalValueUsd += m.mvUsd;
      dayChangeUsd += m.dayChangeUsd;
    } else {
      totalValueUsd += r.holding.totalCostUsd;
    }
  }

  // Cash counts as both cost and value at 1:1 — it doesn't appreciate so it
  // contributes 0 to dayChange / totalChange.
  for (const c of filteredCash()) {
    totalCostUsd += c.amountUsd;
    totalValueUsd += c.amountUsd;
  }

  const totalChangeUsd = totalValueUsd - totalCostUsd;
  const totalPct = totalCostUsd > 0 ? (totalChangeUsd / totalCostUsd) * 100 : 0;
  const dayPctBase = totalValueUsd - dayChangeUsd;
  const dayPct = dayPctBase > 0 ? (dayChangeUsd / dayPctBase) * 100 : 0;

  const valueEl = $("total-value");
  valueEl.textContent = fmtMoney(totalValueUsd);
  valueEl.classList.remove("skeleton");

  const dayEl = $("day-change");
  if (havePrice) {
    dayEl.textContent =
      `${fmtSignedMoney(dayChangeUsd)} (${fmtSignedPercent(dayPct)})`;
    dayEl.className = changeClass(dayChangeUsd);
  } else {
    dayEl.textContent = "—";
    dayEl.className = "muted";
  }

  const totalEl = $("total-change");
  if (havePrice) {
    totalEl.textContent =
      `${fmtSignedMoney(totalChangeUsd)} (${fmtSignedPercent(totalPct)})`;
    totalEl.className = changeClass(totalChangeUsd);
  } else {
    totalEl.textContent = "—";
    totalEl.className = "muted";
  }

  $("cost-basis").textContent = fmtMoney(totalCostUsd);
}

function renderUpdatedAt() {
  const el = $("updated-at");
  if (!el) return;
  if (!state.updatedAt) {
    el.textContent = "";
    el.title = "";
    return;
  }
  el.textContent = `Updated ${fmtRelativeTime(state.updatedAt)}`;
  el.title = new Date(state.updatedAt).toLocaleString();
}

// Combine duplicate-symbol rows into one position. Holdings list still shows
// every CSV row separately (so platform-level cost basis is preserved) — the
// aggregation only affects the overview bar chart.
function aggregateBySymbol(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const m = rowMetrics(r);
    const usd = m.hasQuote ? m.mvUsd : r.holding.totalCostUsd;
    if (!isFinite(usd) || usd <= 0) continue;
    const key = r.holding.symbol;
    const cur = byKey.get(key) || { label: key, usd: 0, costUsd: 0, kind: "stock" };
    cur.usd += usd;
    if (isFinite(r.holding.totalCostUsd)) cur.costUsd += r.holding.totalCostUsd;
    byKey.set(key, cur);
  }
  return [...byKey.values()];
}

function shortLabel(label) {
  if (label.startsWith("Cash")) return "Cash";
  // Keep up to the first 6 chars before any exchange suffix (e.g. 6488.TWO → 6488).
  const base = label.split(".")[0];
  return base.length > 6 ? base.slice(0, 6) : base;
}

function escapeText(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderOverview() {
  const panel = $("overview");
  if (!panel) return;
  if (!state.overviewOpen || state.market === BEAR_TAB) {
    panel.hidden = true;
    panel.innerHTML = "";
    panel.classList.remove("has-highlight");
    return;
  }

  // 1) Aggregate same-symbol rows + add one bar per cash currency.
  const items = aggregateBySymbol(filteredRows());
  for (const c of consolidateCash(filteredCash())) {
    if (isFinite(c.amountUsd) && c.amountUsd > 0) {
      // Cash never has a P/L, so cost === value → neutral dot in the legend.
      items.push({
        label: `Cash (${c.currency})`,
        usd: c.amountUsd,
        costUsd: c.amountUsd,
        kind: "cash",
      });
    }
  }
  items.sort((a, b) => b.usd - a.usd); // largest left, smallest right
  const total = items.reduce((s, x) => s + x.usd, 0);

  if (!items.length || total <= 0) {
    panel.hidden = false;
    panel.classList.remove("has-highlight");
    panel.innerHTML = `<div class="overview-empty">No positions to display.</div>`;
    return;
  }

  // 2) Layout — SVG viewBox auto-scales to the card width.
  const W = 600, H = 260;
  const PAD_T = 8, PAD_B = 36;
  const innerH = H - PAD_T - PAD_B;
  const n = items.length;
  const minGap = 6, idealBar = 44;
  const totalGapMax = Math.max(0, (n - 1) * minGap);
  const barW = Math.max(14, Math.min(idealBar, (W - totalGapMax) / n));
  const gap = n > 1 ? (W - barW * n) / (n - 1) : 0;
  const maxUsd = items[0].usd;

  // 3) Bars.
  const bars = items.map((it, i) => {
    const h = (it.usd / maxUsd) * innerH;
    const x = i * (barW + gap);
    const y = PAD_T + (innerH - h);
    const pct = (it.usd / total) * 100;
    return (
      `<g data-idx="${i}" class="bar-group">` +
        `<rect class="bar" x="${x}" y="${y}" width="${barW}" height="${h}" rx="3"/>` +
        `<text class="bar-label" x="${x + barW / 2}" y="${H - 14}" text-anchor="middle">` +
          escapeText(shortLabel(it.label)) +
        `</text>` +
        `<title>${escapeText(it.label)} — ${fmtMoney(it.usd)} (${pct.toFixed(1)}%)</title>` +
      `</g>`
    );
  }).join("");

  // 4) Header — Robinhood-style label-over-price hierarchy.
  const tabName = state.market === "All" ? "All positions" : state.market;
  const header =
    `<div class="overview-header">` +
      `<div class="overview-tab">${escapeText(tabName)}</div>` +
      `<div class="overview-total">${fmtMoney(total)}</div>` +
    `</div>`;

  // 5) Sorted legend list — gives precise USD + % per position and reuses
  // the same data-idx so hovering it lights up the matching bar. Each row
  // also gets a P/L dot (green up, red down, gray neutral for cash).
  const legend = items.map((it, i) => {
    const pct = (it.usd / total) * 100;
    const ret = isFinite(it.costUsd) ? it.usd - it.costUsd : 0;
    const cls = it.kind === "cash" || ret === 0 ? "neutral" : ret > 0 ? "up" : "down";
    return (
      `<li data-idx="${i}">` +
        `<span class="ret-dot ${cls}"></span>` +
        `<span class="lbl">${escapeText(it.label)}</span>` +
        `<span class="val">${fmtMoney(it.usd)}</span>` +
        `<span class="pct">${pct.toFixed(1)}%</span>` +
      `</li>`
    );
  }).join("");

  panel.hidden = false;
  panel.classList.remove("has-highlight");
  panel.innerHTML =
    header +
    `<svg class="overview-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Position breakdown by symbol">` +
      bars +
    `</svg>` +
    `<ol class="overview-legend">${legend}</ol>`;
  // Hover wiring lives in bindOverview() — attached once, survives innerHTML
  // rewrites here.
}

function rerender() {
  renderTabs();
  renderHoldings();
  renderSummary();
  renderUpdatedAt();
  renderOverview();
}

/* -------- live API path (Refresh button only) -------- */

async function loadAllLive(force = true) {
  setRefreshing(true);
  try {
    const allRowsList = [...state.rows, ...state.bears];
    const allHoldings = allRowsList.map((r) => r.holding);

    // Batch ALL stock symbols (main + bears) + FX symbols through Yahoo
    // Finance in one call. Extended-hours prices come back for stocks
    // and the meta also covers FX, so a single request refreshes everything.
    const stockSymbols = [...new Set(allHoldings.map((h) => h.symbol))];
    const fxSyms = fxSymbolsForCurrencies(uniqueCurrencies());
    const quotes = await getQuotesBatch([...stockSymbols, ...fxSyms], { force });

    // Pull FX rates out of the same response and refresh holdings/cash USD.
    const rates = { USD: 1 };
    for (const cur of uniqueCurrencies()) rates[cur] = rateFromQuotes(cur, quotes);
    applyFxRates(rates);

    // Build profiles from the Yahoo quote — same approach as the snapshot path.
    // Logo URLs are inferred via inferLogoUrl (Finnhub CDN for US, FMP for
    // international); no extra API call needed just to show an icon.
    const enrich = (r) => {
      const holding = r.holding;
      const quote = quotes[holding.symbol] || null;
      const profile = quote
        ? {
            name: quote.name,
            logo: inferLogoUrl(holding.symbol),
            exchange: quote.exchange,
            currency: quote.currency,
            marketCap: quote.marketCap,
          }
        : null;
      return { holding, quote, profile };
    };
    state.rows = state.rows.map(enrich);
    state.bears = state.bears.map(enrich);
    state.updatedAt = new Date().toISOString();
    rerender();
  } finally {
    setRefreshing(false);
  }
}

function setRefreshing(on) {
  const btn = $("refresh");
  const icon = $("refresh-icon");
  if (on) {
    btn.disabled = true;
    icon.outerHTML = '<span class="spin" id="refresh-icon"></span>';
  } else {
    btn.disabled = false;
    const cur = $("refresh-icon");
    if (cur) cur.outerHTML = '<span id="refresh-icon">↻</span>';
  }
}

/* -------- manual Yahoo Finance parse path (Parse Data button) -------- */

async function loadAllParse() {
  setParsing(true);
  try {
    const stockSymbols = [
      ...new Set([
        ...state.rows.map((r) => r.holding.symbol),
        ...state.bears.map((r) => r.holding.symbol),
      ]),
    ];
    const fxSyms = fxSymbolsForCurrencies(uniqueCurrencies());
    const symbols = [...stockSymbols, ...fxSyms];
    showBanner(`Parsing 0/${symbols.length} from Yahoo Finance…`, "info");
    const lastFailure = { sym: null, attempts: [] };
    const quotes = await parseAllSymbols(symbols, ({ done, total, sym, ok, source, attempts }) => {
      const tag = ok ? `✓ ${source || ""}`.trim() : "✗";
      showBanner(`Parsing ${done}/${total} from Yahoo Finance — ${sym} ${tag}`, "info");
      if (!ok) {
        lastFailure.sym = sym;
        lastFailure.attempts = attempts || [];
      }
    });

    // Apply FX first so cost/value totals are correct even if some stocks fail.
    const rates = { USD: 1 };
    for (const cur of uniqueCurrencies()) rates[cur] = rateFromQuotes(cur, quotes);
    applyFxRates(rates);

    const matched = new Set();
    const enrich = (r) => {
      const q = quotes[r.holding.symbol];
      if (q) {
        matched.add(r.holding.symbol);
        return { ...r, quote: q };
      }
      return r;
    };
    state.rows = state.rows.map(enrich);
    state.bears = state.bears.map(enrich);
    const okCount = matched.size;
    state.updatedAt = new Date().toISOString();
    rerender();

    if (okCount === stockSymbols.length) {
      showBanner(`Parsed all ${okCount} symbols from Yahoo Finance ✓`, "info");
      setTimeout(() => {
        const el = $("banner");
        if (el) el.hidden = true;
      }, 4000);
    } else if (okCount === 0) {
      // Total failure — surface the last symbol's proxy attempts so the user
      // can see what's blocked (especially useful on mobile where they don't
      // have easy access to DevTools console).
      const detail = lastFailure.attempts.length
        ? ` Last (${lastFailure.sym}): ${lastFailure.attempts.slice(0, 3).join(" | ")}`
        : "";
      showBanner(
        `Parsed 0/${stockSymbols.length} — all CORS proxies blocked.${detail}`,
      );
    } else {
      showBanner(
        `Parsed ${okCount}/${stockSymbols.length}. Some symbols blocked — try again or use Refresh.`,
      );
    }
  } finally {
    setParsing(false);
  }
}

function setParsing(on) {
  const btn = $("parse");
  const icon = $("parse-icon");
  if (!btn) return;
  btn.disabled = on;
  if (on) {
    if (icon) icon.outerHTML = '<span class="spin" id="parse-icon"></span>';
  } else {
    const cur = $("parse-icon");
    if (cur) cur.outerHTML = '<span id="parse-icon">⚡</span>';
  }
}

function showBanner(message, kind = "warn") {
  const el = $("banner");
  el.hidden = false;
  el.className = `banner ${kind === "info" ? "banner-info" : ""}`.trim();
  el.textContent = message;
}

function bindSort() {
  const wrap = $("sort");
  wrap.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-sort]");
    if (!btn) return;
    state.sort = btn.dataset.sort;
    wrap.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b === btn),
    );
    renderHoldings();
  });
}

function bindTabs() {
  $("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-market]");
    if (!btn) return;
    state.market = btn.dataset.market;
    if (state.market === BEAR_TAB) {
      // Overview doesn't apply on bear tab — collapse it visually too.
      state.overviewOpen = false;
      $("holdings-title")?.classList.remove("open");
    }
    renderTabs();
    renderHoldings();
    renderSummary();
    renderOverview();
  });
}

function bindOverview() {
  const title = $("holdings-title");
  if (title) {
    title.addEventListener("click", () => {
      if (state.market === BEAR_TAB) return;   // disabled on 🐻 tab
      state.overviewOpen = !state.overviewOpen;
      title.classList.toggle("open", state.overviewOpen);
      renderOverview();
    });
  }

  // Delegated bidirectional hover — bar ↔ legend row, both keyed on data-idx.
  // Attached once; `renderOverview()` rewrites innerHTML but the panel node
  // (and these listeners) stay live across renders.
  const panel = $("overview");
  if (!panel) return;
  panel.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-idx]");
    if (!el) return;
    const idx = el.dataset.idx;
    panel.classList.add("has-highlight");
    panel.querySelectorAll("[data-idx]").forEach((n) => {
      n.classList.toggle("highlighted", n.dataset.idx === idx);
    });
  });
  panel.addEventListener("mouseleave", () => {
    panel.classList.remove("has-highlight");
    panel.querySelectorAll(".highlighted").forEach((n) => n.classList.remove("highlighted"));
  });
}

function bindRefresh() {
  $("refresh").addEventListener("click", () => loadAllLive(true));
}

function bindParse() {
  const btn = $("parse");
  if (btn) btn.addEventListener("click", loadAllParse);
}

function bindRowNavigation() {
  const list = $("holdings");
  // Clicks on inline buttons (Detailed Quote, external link) navigate via
  // their own <a href>; let them do their job and don't double-trigger the
  // row's promote-to-stock.html behavior.
  const isInnerControl = (el) =>
    el && (el.closest(".link-btn") || el.closest(".quote-btn"));

  list.addEventListener("click", (e) => {
    if (isInnerControl(e.target)) return;
    const row = e.target.closest(".row");
    if (!row || !row.dataset.symbol) return;
    window.location.href = `stock.html?symbol=${encodeURIComponent(row.dataset.symbol)}`;
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (isInnerControl(e.target)) return;
    const row = e.target.closest(".row");
    if (!row || !row.dataset.symbol) return;
    e.preventDefault();
    window.location.href = `stock.html?symbol=${encodeURIComponent(row.dataset.symbol)}`;
  });
}

/* -------- snapshot path (page load) -------- */

function applySnapshot(snapshot) {
  state.updatedAt = snapshot.updatedAt || null;
  // FX rates from the cron snapshot — no extra API call on page load.
  if (snapshot.fxRates) applyFxRates(snapshot.fxRates);
  const fillFromSnapshot = (rows) => {
    for (const r of rows) {
      const sym = r.holding.symbol;
      const q = snapshot.quotes?.[sym] || null;
      const p = snapshot.profiles?.[sym] || null;
      if (q) r.quote = q;
      if (p) {
        r.profile = p;
      } else if (q && q.name) {
        // Synthesize a minimal profile from quote when the full profile is
        // absent (international rows store quote-only).
        r.profile = { name: q.name, logo: null, exchange: q.exchange, currency: q.currency };
      }
    }
  };
  fillFromSnapshot(state.rows);
  fillFromSnapshot(state.bears);
}

async function main() {
  bindSort();
  bindTabs();
  bindRefresh();
  bindParse();
  bindOverview();
  bindRowNavigation();

  let holdings;
  try {
    holdings = await loadHoldings();
  } catch (e) {
    showBanner(`Could not load holdings.csv — ${e.message}`);
    return;
  }

  // Cash is optional; treat any failure as "no cash entries".
  const cash = await loadCash().catch((e) => {
    console.warn("Cash CSV load failed:", e.message);
    return [];
  });
  state.cash = cash;

  // Bear-tab holdings are also optional (file may not exist).
  const bears = await loadHoldings("data/bear_holding.csv").catch(() => []);
  state.bears = bears.map((h) => ({ holding: h, quote: null, profile: null }));

  if (!holdings.length && !cash.length && !bears.length) {
    $("empty").hidden = false;
    $("total-value").textContent = fmtMoney(0);
    $("total-value").classList.remove("skeleton");
    return;
  }

  state.rows = holdings.map((h) => ({ holding: h, quote: null, profile: null }));
  rerender();

  const snapshot = await loadSnapshot();
  if (snapshot) {
    applySnapshot(snapshot);
    rerender();
  } else {
    // No snapshot yet (first deploy or Action hasn't run) — fall back to live.
    showBanner(
      "No snapshot found. The hourly cron may not have run yet — fetching live now.",
      "info",
    );
    await loadAllLive(false);
  }
}

main();
