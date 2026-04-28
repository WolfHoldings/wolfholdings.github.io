import { loadHoldings, loadCash } from "./csv.js";
import {
  getProfile,
  getQuotesBatch,
  isInternational,
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
  updatedAt: null,
};

const BEAR_TAB = "🐻";

const $ = (id) => document.getElementById(id);

function logoEl(symbol, profile) {
  const wrap = document.createElement("div");
  wrap.className = "logo";
  if (profile && profile.logo) {
    const img = document.createElement("img");
    img.src = profile.logo;
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
    const k = r.holding.market;
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

  const markets = [...groups.keys()].sort((a, b) => groups.get(b) - groups.get(a));
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

function rerender() {
  renderTabs();
  renderHoldings();
  renderSummary();
  renderUpdatedAt();
}

/* -------- live API path (Refresh button only) -------- */

async function loadAllLive(force = true) {
  setRefreshing(true);
  try {
    const allRowsList = [...state.rows, ...state.bears];
    const allHoldings = allRowsList.map((r) => r.holding);
    const usHoldings = allHoldings.filter((h) => !isInternational(h.symbol));

    // Batch ALL stock symbols (main + bears) + FX symbols through Yahoo
    // Finance in one call. Extended-hours prices come back for stocks
    // and the meta also covers FX, so a single request refreshes everything.
    const stockSymbols = [...new Set(allHoldings.map((h) => h.symbol))];
    const fxSyms = fxSymbolsForCurrencies(uniqueCurrencies());
    const allSymbols = [...stockSymbols, ...fxSyms];
    const quotesPromise = getQuotesBatch(allSymbols, { force });

    // US company profiles still come from Finnhub (richer: logo, sector, IPO).
    // Cached 24 h so this rarely hits the network on a manual Refresh.
    const usProfilesPromise = Promise.all(
      usHoldings.map((h) =>
        getProfile(h.symbol, { force }).catch(() => ({ value: null })),
      ),
    );

    const [quotes, usProfiles] = await Promise.all([quotesPromise, usProfilesPromise]);

    // Pull FX rates out of the same response and refresh holdings/cash USD.
    const rates = { USD: 1 };
    for (const cur of uniqueCurrencies()) rates[cur] = rateFromQuotes(cur, quotes);
    applyFxRates(rates);

    const usProfileMap = new Map(
      usHoldings.map((h, i) => [h.symbol, usProfiles[i]?.value || null]),
    );

    const enrich = (r) => {
      const holding = r.holding;
      const quote = quotes[holding.symbol] || null;
      const profile = isInternational(holding.symbol)
        ? (quote ? { name: quote.name, logo: null, exchange: quote.exchange, currency: quote.currency } : null)
        : (usProfileMap.get(holding.symbol) || null);
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
    renderTabs();
    renderHoldings();
    renderSummary();
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
