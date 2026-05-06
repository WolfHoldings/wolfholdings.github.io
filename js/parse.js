// js/parse.js
//
// Manual fallback for fetching stock quotes when the RapidAPI quota is
// exhausted. Reads Yahoo Finance's unauthenticated v8 chart endpoint via a
// self-hosted Cloudflare Worker (see /worker) that adds CORS headers, with
// one public CORS proxy as defense-in-depth if the Worker is down.
//
// Returns quotes in the same shape as `normalizeApidojoQuote` in api.js,
// so the existing render pipeline consumes them without changes.
//
// Note: Yahoo's chart `meta` does NOT carry `marketState` / `preMarketPrice` /
// `postMarketPrice` — those live only on the apidojo /get-quotes endpoint used
// by api.js. To support pre / regular / post sessions here we request 1-minute
// candles (which include extended-hours bars when `includePrePost=true`) and
// derive the session from the latest candle's timestamp vs the meta's
// `currentTradingPeriod` windows.

// Deployed Cloudflare Worker — see worker/README.md to (re)deploy.
const WORKER_BASE = "https://wolfholdings-yahoo-proxy.wolfholdings-yahoo-proxy.workers.dev";

const YAHOO_DIRECT = (sym) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
  `?interval=1m&range=1d&includePrePost=true`;

// Each entry builds a fully-formed request URL from a symbol. The Worker is
// tried first; the public proxy only runs if the Worker errors out.
const SOURCES = [
  { name: "worker", url: (sym) => `${WORKER_BASE}/?symbol=${encodeURIComponent(sym)}&interval=1m&range=1d` },
  { name: "cors.lol", url: (sym) => `https://api.cors.lol/?url=${encodeURIComponent(YAHOO_DIRECT(sym))}` },
];

async function fetchYahooChart(sym, timeoutMs = 8000) {
  const attempts = [];
  for (const src of SOURCES) {
    const target = src.url(sym);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(target, {
        signal: ctrl.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "follow",
      });
      clearTimeout(t);
      if (!res.ok) {
        attempts.push(`${src.name}: HTTP ${res.status}`);
        continue;
      }
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      let j;
      if (ct.includes("json")) {
        j = await res.json();
      } else {
        const text = await res.text();
        try { j = JSON.parse(text); } catch {
          attempts.push(`${src.name}: not-JSON (${text.slice(0, 40)})`);
          continue;
        }
      }
      if (!j?.chart || j.chart.error) {
        attempts.push(`${src.name}: chart-${j?.chart?.error?.code || "missing"}`);
        continue;
      }
      return { json: j, proxy: src.name, attempts };
    } catch (e) {
      attempts.push(`${src.name}: ${e.name || "Error"}`);
    }
  }
  return { json: null, proxy: null, attempts };
}

function inWindow(w, t) {
  if (!w) return false;
  const start = +w.start, end = +w.end;
  return Number.isFinite(start) && Number.isFinite(end) && t >= start && t < end;
}

function normalizeYahooChartResult(r) {
  if (!r) return null;
  const meta = r.meta;
  if (!meta) return null;
  const ts = r.timestamp || [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  const period = meta.currentTradingPeriod || {};
  const pc = +(meta.chartPreviousClose ?? meta.previousClose);

  // Walk back from the end to find the most recent non-null close.
  let latestIdx = -1;
  for (let i = ts.length - 1; i >= 0; i--) {
    if (Number.isFinite(closes[i])) { latestIdx = i; break; }
  }

  let c, latestTs;
  if (latestIdx >= 0) {
    c = +closes[latestIdx];
    latestTs = +ts[latestIdx];
  } else {
    // No candles at all — fall back to whatever the meta carries so the row
    // is still populated with the previous close.
    c = +meta.regularMarketPrice;
    latestTs = +meta.regularMarketTime || 0;
    if (!Number.isFinite(c) && Number.isFinite(pc)) c = pc;
  }
  if (!Number.isFinite(c)) return null;

  // Determine session from where the latest candle falls.
  let marketState = null;
  let extendedLabel = null;
  let baseline = pc;

  if (inWindow(period.pre, latestTs)) {
    marketState = "PRE";
    extendedLabel = "Pre-market";
  } else if (inWindow(period.regular, latestTs)) {
    marketState = "REGULAR";
  } else if (inWindow(period.post, latestTs)) {
    marketState = "POST";
    extendedLabel = "After hours";
    // After-hours change is measured against today's regular session close,
    // i.e. the last candle that closed before regular.end.
    const regEnd = +period.regular?.end;
    if (Number.isFinite(regEnd)) {
      for (let i = ts.length - 1; i >= 0; i--) {
        if (Number.isFinite(closes[i]) && +ts[i] < regEnd) { baseline = +closes[i]; break; }
      }
    }
  } else {
    // Latest candle is outside today's pre/regular/post windows. If wall-clock
    // time is between today's post.end and tomorrow's pre.start, we're in the
    // overnight ATS window — Yahoo doesn't return overnight candles, so c is
    // the last after-hours close, but the user-visible label should reflect
    // that the regular sessions have all wrapped.
    const postEnd = +period.post?.end;
    const preStart = +period.pre?.start;
    const nowSec = Date.now() / 1000;
    if (Number.isFinite(postEnd) && nowSec > postEnd) {
      marketState = "OVERNIGHT";
      extendedLabel = "Overnight";
    } else if (Number.isFinite(preStart) && nowSec < preStart) {
      // Before today's pre opens — show previous close, no extended label.
      marketState = "CLOSED";
    }
  }

  const d = Number.isFinite(baseline) ? c - baseline : 0;
  const dp = Number.isFinite(baseline) && baseline !== 0 ? (d / baseline) * 100 : 0;

  return {
    c,
    d,
    dp,
    pc: Number.isFinite(pc) ? pc : NaN,
    o: NaN,
    h: NaN,
    l: NaN,
    currency: meta.currency || null,
    name: meta.shortName || meta.longName || meta.symbol || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    fiftyTwoWeekHigh: NaN,
    fiftyTwoWeekLow: NaN,
    volume: NaN,
    averageVolume: NaN,
    marketCap: NaN,
    peTTM: NaN,
    eps: NaN,
    divYield: NaN,
    marketState,
    extendedLabel,
  };
}

export async function parseAllSymbols(symbols, onProgress) {
  const out = {};
  const queue = [...symbols];
  let done = 0;

  async function worker() {
    while (queue.length) {
      const sym = queue.shift();
      const got = await fetchYahooChart(sym);
      const result = got?.json?.chart?.result?.[0];
      const norm = result ? normalizeYahooChartResult(result) : null;
      if (norm) norm.__source = got.proxy;
      out[sym] = norm;
      done++;
      if (!norm) {
        console.warn(`[parse] ${sym} failed:`, got.attempts.join(" | "));
      } else {
        console.log(`[parse] ${sym} ok via ${got.proxy} (after ${got.attempts.length} fallback${got.attempts.length === 1 ? "" : "s"})`);
      }
      if (onProgress) {
        onProgress({
          done,
          total: symbols.length,
          sym,
          ok: !!norm,
          source: got?.proxy || null,
          attempts: got?.attempts || [],
        });
      }
      // Throttle ~300 ms to dodge Cloudflare 429s on shared proxy IPs.
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // 3 concurrent workers — quick enough (~1.5 s for 11 symbols),
  // gentle enough to not get rate-limited.
  await Promise.all([worker(), worker(), worker()]);
  return out;
}
