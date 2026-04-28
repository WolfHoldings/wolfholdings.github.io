import { loadHoldings } from "./csv.js";
import { loadSnapshot } from "./snapshot.js";
import {
  getQuote,
  getProfile,
  getMetric,
  getCandles,
  timeframeToRange,
} from "./api.js";
import {
  fmtMoney,
  fmtMoneyCompact,
  fmtNative,
  fmtNumber,
  fmtSignedMoney,
  fmtSignedNative,
  fmtSignedPercent,
  fmtShares,
  changeClass,
} from "./format.js";

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(window.location.search);
const symbol = (params.get("symbol") || "").toUpperCase();

const state = {
  symbol,
  holding: null,
  quote: null,
  profile: null,
  metric: null,
  timeframe: "1M",
  chart: null,
  series: null,
};

if (!symbol) {
  document.title = "Stock — Wolf Holdings";
  showBanner("No symbol supplied. Use stock.html?symbol=ADBE");
} else {
  document.title = `${symbol} — Wolf Holdings`;
  $("symbol-tag").textContent = symbol;
  main();
}

function showBanner(message) {
  const el = $("banner");
  el.hidden = false;
  el.textContent = message;
}

function effectiveCurrency() {
  return (
    state.holding?.currency ||
    state.quote?.currency ||
    state.profile?.currency ||
    "USD"
  );
}

function setLogo(profile) {
  const wrap = $("logo");
  wrap.classList.remove("skeleton");
  wrap.innerHTML = "";
  if (profile && profile.logo) {
    const img = document.createElement("img");
    img.src = profile.logo;
    img.alt = `${state.symbol} logo`;
    img.onerror = () => {
      wrap.textContent = state.symbol.charAt(0);
      img.remove();
    };
    wrap.appendChild(img);
  } else {
    wrap.textContent = state.symbol.charAt(0);
  }
}

function renderHeader() {
  const { quote, profile, holding } = state;
  setLogo(profile);

  const company = $("company");
  company.classList.remove("skeleton");
  company.textContent = profile?.name || state.symbol;

  const linkEl = $("company-link");
  if (linkEl) {
    if (holding && holding.link) {
      linkEl.href = holding.link;
      linkEl.hidden = false;
      linkEl.setAttribute("aria-label", `Open external page for ${state.symbol}`);
    } else {
      // Fallback: build a Yahoo Finance link from the symbol when the page is
      // visited directly without the symbol being in the CSV.
      linkEl.href = `https://au.finance.yahoo.com/quote/${encodeURIComponent(state.symbol)}/`;
      linkEl.hidden = false;
    }
  }

  const currency = effectiveCurrency();

  const priceEl = $("price");
  priceEl.classList.remove("skeleton");
  if (quote && isFinite(quote.c) && quote.c > 0) {
    priceEl.textContent = fmtNative(quote.c, currency);
    const ch = $("change");
    const chText = $("change-text");
    chText.textContent =
      `${fmtSignedNative(quote.d, currency)} (${fmtSignedPercent(quote.dp)})`;
    ch.className = `change ${changeClass(quote.d)}`;
    $("change-tag").textContent = state.quote?.extendedLabel ?? "Today";

    // USD equivalent for non-USD symbols.
    const usdEl = $("price-usd");
    if (currency !== "USD" && holding && isFinite(holding.usdRate)) {
      usdEl.hidden = false;
      usdEl.textContent = `≈ ${fmtMoney(quote.c * holding.usdRate)} USD`;
    } else {
      usdEl.hidden = true;
    }
  } else {
    priceEl.textContent = "—";
    $("change-text").textContent = "Quote unavailable";
    $("change").className = "change muted";
  }
}

function renderPosition() {
  if (!state.holding) {
    $("position").hidden = true;
    return;
  }
  const h = state.holding;
  const q = state.quote;
  const cur = h.currency;

  const items = [];
  items.push(["Shares", fmtShares(h.shares)]);
  items.push(["Avg cost", fmtNative(h.unitCost, cur)]);
  items.push([
    "Total cost",
    cur === "USD"
      ? fmtMoney(h.totalCostUsd)
      : `${fmtNative(h.totalCostNative, cur)} <span class="muted">≈ ${fmtMoney(h.totalCostUsd)}</span>`,
  ]);

  if (q && isFinite(q.c) && q.c > 0) {
    const mvNative = q.c * h.shares;
    const mvUsd = mvNative * h.usdRate;
    const change = mvUsd - h.totalCostUsd;
    const pct = (change / h.totalCostUsd) * 100;
    items.push([
      "Market value",
      cur === "USD"
        ? fmtMoney(mvUsd)
        : `${fmtNative(mvNative, cur)} <span class="muted">≈ ${fmtMoney(mvUsd)}</span>`,
    ]);
    items.push([
      "Total return (USD)",
      `<span class="${changeClass(change)}">` +
        `${fmtSignedMoney(change)} (${fmtSignedPercent(pct)})</span>`,
    ]);
    items.push([
      "Today's P/L (USD)",
      `<span class="${changeClass(q.d)}">` +
        `${fmtSignedMoney((q.d ?? 0) * h.shares * h.usdRate)} (${fmtSignedPercent(q.dp)})</span>`,
    ]);
  }

  if (h.platform) items.push(["Platform", h.platform]);
  if (h.market && h.market !== "US") items.push(["Market", h.market]);
  if (cur !== "USD" && isFinite(h.usdRate)) {
    items.push(["FX rate", `1 ${cur} = ${fmtNumber(h.usdRate, 4)} USD`]);
  }
  if (h.note) items.push(["Note", h.note]);

  const wrap = $("position-kv");
  wrap.innerHTML = items
    .map(
      ([k, v]) =>
        `<div class="item"><span class="k">${k}</span><span class="v">${v}</span></div>`,
    )
    .join("");
  $("position").hidden = false;
}

function renderAbout() {
  const p = state.profile;
  const q = state.quote;
  if (!p && !q) return;
  const body = $("about-body");
  const parts = [];

  const sector = p?.sector || p?.industry;
  const country = p?.country;
  const exchange = p?.exchange || q?.exchange;
  const headerBits = [sector, country, exchange].filter(Boolean);
  if (headerBits.length) {
    parts.push(`<p><strong>${headerBits.join(" · ")}</strong></p>`);
  }
  if (p?.ipo) parts.push(`<p class="muted">IPO: ${p.ipo}</p>`);

  const links = [];
  if (p?.weburl) links.push(`<a class="pill" href="${p.weburl}" target="_blank" rel="noopener">Website ↗</a>`);
  if (p?.ticker) links.push(`<span class="pill">${p.ticker}</span>`);
  const cur = effectiveCurrency();
  if (cur) links.push(`<span class="pill">${cur}</span>`);
  if (links.length) parts.push(`<div class="links">${links.join("")}</div>`);

  if (!parts.length) {
    $("about").hidden = true;
    return;
  }
  body.innerHTML = parts.join("");
  $("about").hidden = false;
}

function renderStats() {
  const m = state.metric;
  const p = state.profile;
  const q = state.quote;
  if (!m && !p && !q) return;
  const cur = effectiveCurrency();

  const items = [];
  if (p && isFinite(p.marketCap) && p.marketCap > 0) {
    items.push(["Market cap", fmtMoneyCompact(p.marketCap)]);
  }
  if (m) {
    if (isFinite(m.peTTM)) items.push(["P/E (TTM)", fmtNumber(m.peTTM)]);
    if (isFinite(m.pbAnnual)) items.push(["P/B", fmtNumber(m.pbAnnual)]);
    if (isFinite(m.fiftyTwoWeekHigh))
      items.push(["52w high", fmtNative(m.fiftyTwoWeekHigh, cur)]);
    if (isFinite(m.fiftyTwoWeekLow))
      items.push(["52w low", fmtNative(m.fiftyTwoWeekLow, cur)]);
    if (isFinite(m.divYield)) items.push(["Dividend yield", `${fmtNumber(m.divYield)}%`]);
    if (isFinite(m.beta)) items.push(["Beta", fmtNumber(m.beta)]);
    if (isFinite(m.eps)) items.push(["EPS (TTM)", fmtNumber(m.eps)]);
    if (isFinite(m.volume)) items.push(["Volume", fmtNumber(m.volume, 0)]);
    if (isFinite(m.averageVolume)) items.push(["Avg volume", fmtNumber(m.averageVolume, 0)]);
  }
  if (q) {
    if (isFinite(q.o)) items.push(["Open", fmtNative(q.o, cur)]);
    if (isFinite(q.h)) items.push(["Day high", fmtNative(q.h, cur)]);
    if (isFinite(q.l)) items.push(["Day low", fmtNative(q.l, cur)]);
    if (isFinite(q.pc)) items.push(["Prev close", fmtNative(q.pc, cur)]);
  }

  if (!items.length) {
    $("stats").hidden = true;
    return;
  }
  $("stats-kv").innerHTML = items
    .map(
      ([k, v]) =>
        `<div class="item"><span class="k">${k}</span><span class="v">${v}</span></div>`,
    )
    .join("");
  $("stats").hidden = false;
}

/* ------------------------- chart ------------------------- */

function ensureChart() {
  if (state.chart) return state.chart;
  const container = $("chart");
  const chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight || 320,
    layout: {
      background: { color: "transparent" },
      textColor: "#9a9aa0",
      fontFamily: "Inter, sans-serif",
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { color: "rgba(255,255,255,0.04)" },
    },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: false, secondsVisible: false },
    crosshair: {
      vertLine: { color: "rgba(255,255,255,0.2)", labelBackgroundColor: "#232326" },
      horzLine: { color: "rgba(255,255,255,0.2)", labelBackgroundColor: "#232326" },
    },
    handleScroll: false,
    handleScale: false,
  });
  state.chart = chart;
  window.addEventListener("resize", () => {
    chart.applyOptions({ width: container.clientWidth });
  });
  return chart;
}

function setSeries(points, isUp) {
  const chart = ensureChart();
  if (state.series) {
    chart.removeSeries(state.series);
    state.series = null;
  }
  const series = chart.addAreaSeries({
    lineColor: isUp ? "#00c805" : "#ff5000",
    topColor: isUp ? "rgba(0, 200, 5, 0.30)" : "rgba(255, 80, 0, 0.30)",
    bottomColor: isUp ? "rgba(0, 200, 5, 0.0)" : "rgba(255, 80, 0, 0.0)",
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
  });
  series.setData(points);
  state.series = series;
  chart.timeScale().fitContent();
}

function clearChartOverlay() {
  const container = $("chart");
  const existing = container.querySelector(".chart-empty");
  if (existing) existing.remove();
}

function setChartOverlay(message) {
  const chart = ensureChart();
  if (state.series) {
    chart.removeSeries(state.series);
    state.series = null;
  }
  clearChartOverlay();
  const container = $("chart");
  container.style.position = "relative";
  const empty = document.createElement("div");
  empty.className = "chart-empty empty";
  empty.style.position = "absolute";
  empty.style.inset = "0";
  empty.style.display = "flex";
  empty.style.alignItems = "center";
  empty.style.justifyContent = "center";
  empty.textContent = message;
  container.appendChild(empty);
}

function setActiveTimeframe(tf, isUp) {
  state.timeframe = tf;
  const buttons = $("timeframes").querySelectorAll("button");
  buttons.forEach((b) => {
    b.classList.toggle("active", b.dataset.tf === tf);
    b.classList.toggle("down-active", b.dataset.tf === tf && isUp === false);
  });
}

async function loadChart(tf) {
  const { range, interval } = timeframeToRange(tf);
  setActiveTimeframe(tf);

  let result;
  try {
    const r = await getCandles(state.symbol, range, interval);
    result = r.value;
  } catch (e) {
    console.warn("Candle fetch failed:", e.message);
    setChartOverlay("Chart data unavailable.");
    return;
  }

  if (!result || !result.points || result.points.length < 2) {
    setChartOverlay("No data for this period.");
    return;
  }

  const points = result.points;
  const isUp = points[points.length - 1].value >= points[0].value;
  clearChartOverlay();
  setSeries(points, isUp);
  setActiveTimeframe(tf, isUp);
}

function bindTimeframes() {
  $("timeframes").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tf]");
    if (!btn) return;
    loadChart(btn.dataset.tf);
  });
}

/* ------------------------- main ------------------------- */

async function main() {
  bindTimeframes();
  ensureChart();

  // Load CSV in parallel so we can decorate position info if the symbol is held.
  const csvPromise = loadHoldings().catch(() => []);
  // Pull FX rates out of the cron-refreshed snapshot — no extra API call here.
  const snapshotPromise = loadSnapshot().catch(() => null);

  const onUpdate = () => {
    Promise.all([
      getQuote(state.symbol),
      getProfile(state.symbol),
      getMetric(state.symbol),
    ])
      .then(([q, p, m]) => {
        state.quote = q.value;
        state.profile = p.value;
        state.metric = m.value;
        renderHeader();
        renderPosition();
        renderAbout();
        renderStats();
      })
      .catch(() => {});
  };

  try {
    const [quote, profile, metric, holdings, snapshot] = await Promise.all([
      getQuote(state.symbol, { onUpdate }),
      getProfile(state.symbol, { onUpdate }),
      getMetric(state.symbol, { onUpdate }),
      csvPromise,
      snapshotPromise,
    ]);
    state.quote = quote.value;
    state.profile = profile.value;
    state.metric = metric.value;
    state.holding = holdings.find((h) => h.symbol === state.symbol) || null;

    // Fill in the holding's USD rate from the snapshot (cron-written) so
    // P/L and "≈ $X USD" line up. No live FX call on stock-page load —
    // FX only refreshes via cron / Refresh / Parse Data on the index page.
    if (state.holding && state.holding.currency !== "USD") {
      const rate = snapshot?.fxRates?.[state.holding.currency];
      if (isFinite(rate) && rate > 0) {
        state.holding.usdRate = rate;
        state.holding.totalCostUsd = state.holding.totalCostNative * rate;
      }
    }
  } catch (e) {
    showBanner(`Failed to load ${state.symbol}: ${e.message}`);
  }

  renderHeader();
  renderPosition();
  renderAbout();
  renderStats();
  loadChart(state.timeframe);
}
