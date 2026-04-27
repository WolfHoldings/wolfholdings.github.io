import {
  FINNHUB_API_KEY,
  FINNHUB_RATE_LIMIT_PER_MIN,
  RAPIDAPI_KEY,
  RAPIDAPI_HOST,
  RAPIDAPI_RATE_LIMIT_PER_MIN,
} from "./config.js";

/* =========================================================================
 * Symbol routing
 *
 * US stocks (no suffix) -> Finnhub.
 * International stocks (with a Yahoo-style suffix like .TW) -> apidojo Yahoo
 * Finance via RapidAPI (CORS-enabled, batch-capable).
 * ========================================================================= */

export function isInternational(symbol) {
  return /\.[A-Z]{1,3}$/.test(symbol);
}

/* =========================================================================
 * Sliding-window rate limiter
 * ========================================================================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeLimiter(capPerMin) {
  const log = [];
  const waiters = [];
  const WINDOW = 60_000;

  function pump() {
    const now = Date.now();
    while (log.length && now - log[0] > WINDOW) log.shift();
    while (waiters.length && log.length < capPerMin) {
      log.push(Date.now());
      waiters.shift()();
    }
  }

  return function acquire() {
    pump();
    if (log.length < capPerMin) {
      log.push(Date.now());
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const checkin = () => {
        pump();
        if (log.length < capPerMin) {
          log.push(Date.now());
          resolve();
        } else {
          const oldest = log[0] || Date.now();
          const wait = WINDOW - (Date.now() - oldest) + 50;
          setTimeout(checkin, Math.max(wait, 100));
        }
      };
      waiters.push(checkin);
      checkin();
    });
  };
}

const finnhubLimiter = makeLimiter(FINNHUB_RATE_LIMIT_PER_MIN);
const rapidLimiter = makeLimiter(RAPIDAPI_RATE_LIMIT_PER_MIN);

/* =========================================================================
 * localStorage SWR cache
 * ========================================================================= */

const STORAGE_PREFIX = "wh:v4:";

function cacheKey(provider, endpoint, params) {
  const p = Object.entries(params || {})
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${STORAGE_PREFIX}${provider}:${endpoint}${p ? "?" + p : ""}`;
}

function readEntry(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeEntry(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ value, at: Date.now() }));
  } catch {}
}

/* =========================================================================
 * Finnhub raw client
 * ========================================================================= */

const FINNHUB_BASE = "https://finnhub.io/api/v1";

async function finnhubFetch(endpoint, params, attempt = 0) {
  const url = new URL(FINNHUB_BASE + endpoint);
  url.searchParams.set("token", FINNHUB_API_KEY);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  await finnhubLimiter();
  const res = await fetch(url.toString());
  if (res.status === 429 && attempt < 2) {
    await sleep(1500 * (attempt + 1));
    return finnhubFetch(endpoint, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`Finnhub ${endpoint} ${res.status}`);
  return res.json();
}

/* =========================================================================
 * RapidAPI Yahoo (apidojo) raw client
 *
 * Endpoint: /market/v2/get-quotes?region=US&symbols=AAPL,2330.TW,IQE.L
 * Returns:  { quoteResponse: { result: [ {symbol, regularMarketPrice, ...} ] } }
 * One call -> all symbols. Counts as 1 request against the 500/mo quota.
 * ========================================================================= */

const RAPID_BASE = `https://${RAPIDAPI_HOST}`;

async function rapidFetch(endpoint, params, attempt = 0) {
  const url = new URL(RAPID_BASE + endpoint);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  await rapidLimiter();
  const res = await fetch(url.toString(), {
    headers: {
      "X-RapidAPI-Key": RAPIDAPI_KEY,
      "X-RapidAPI-Host": RAPIDAPI_HOST,
    },
  });
  if (res.status === 429 && attempt < 2) {
    await sleep(2000 * (attempt + 1));
    return rapidFetch(endpoint, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`RapidAPI ${endpoint} ${res.status}`);
  return res.json();
}

/* =========================================================================
 * Normalized response shapes
 * ========================================================================= */

function num(x) {
  if (x == null) return NaN;
  if (typeof x === "number") return x;
  const n = parseFloat(x);
  return isFinite(n) ? n : NaN;
}

function normalizeFinnhubQuote(raw) {
  if (!raw || !isFinite(raw.c)) return null;
  return {
    c: raw.c,
    d: raw.d,
    dp: raw.dp,
    o: raw.o,
    h: raw.h,
    l: raw.l,
    pc: raw.pc,
    currency: "USD",
    name: null,
    exchange: null,
  };
}

function normalizeApidojoQuote(r) {
  if (!r) return null;
  const c = num(r.regularMarketPrice);
  const pc = num(r.regularMarketPreviousClose);
  if (!isFinite(c)) return null;
  const d = num(r.regularMarketChange);
  const dp = num(r.regularMarketChangePercent);
  return {
    c,
    d: isFinite(d) ? d : c - pc,
    dp: isFinite(dp) ? dp : isFinite(pc) && pc !== 0 ? ((c - pc) / pc) * 100 : 0,
    o: num(r.regularMarketOpen),
    h: num(r.regularMarketDayHigh),
    l: num(r.regularMarketDayLow),
    pc,
    currency: r.currency || null,
    name: r.shortName || r.longName || null,
    exchange: r.fullExchangeName || r.exchange || null,
    fiftyTwoWeekHigh: num(r.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(r.fiftyTwoWeekLow),
    volume: num(r.regularMarketVolume),
    averageVolume: num(r.averageDailyVolume3Month ?? r.averageDailyVolume10Day),
    marketCap: num(r.marketCap),
    peTTM: num(r.trailingPE),
    eps: num(r.epsTrailingTwelveMonths),
    divYield: num(r.trailingAnnualDividendYield),
  };
}

function normalizeFinnhubProfile(raw) {
  if (!raw || !raw.name) return null;
  return {
    name: raw.name,
    logo: raw.logo || null,
    sector: raw.finnhubIndustry || null,
    industry: raw.finnhubIndustry || null,
    country: raw.country || null,
    exchange: raw.exchange || null,
    weburl: raw.weburl || null,
    currency: raw.currency || "USD",
    marketCap: num(raw.marketCapitalization) * 1_000_000,
    ipo: raw.ipo || null,
    ticker: raw.ticker || null,
  };
}

function profileFromApidojoQuote(quote) {
  if (!quote) return null;
  return {
    name: quote.name,
    logo: null,
    sector: null,
    industry: null,
    country: null,
    exchange: quote.exchange,
    weburl: null,
    currency: quote.currency,
    marketCap: quote.marketCap,
    ipo: null,
    ticker: null,
  };
}

function normalizeFinnhubMetric(raw) {
  if (!raw || !raw.metric) return null;
  const m = raw.metric;
  return {
    peTTM: num(m.peTTM),
    pbAnnual: num(m.pbAnnual ?? m.pbQuarterly),
    fiftyTwoWeekHigh: num(m["52WeekHigh"]),
    fiftyTwoWeekLow: num(m["52WeekLow"]),
    divYield: num(m.dividendYieldIndicatedAnnual),
    beta: num(m.beta),
    eps: num(m.epsTTM),
  };
}

function metricFromApidojoQuote(quote) {
  if (!quote) return null;
  return {
    peTTM: quote.peTTM,
    pbAnnual: NaN,
    fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
    divYield: isFinite(quote.divYield) ? quote.divYield * 100 : NaN,
    beta: NaN,
    eps: quote.eps,
    volume: quote.volume,
    averageVolume: quote.averageVolume,
  };
}

/* =========================================================================
 * Cached, normalized public API
 * ========================================================================= */

const QUOTE_TTL = 60;
const PROFILE_TTL = 24 * 3600;
const METRIC_TTL = 24 * 3600;

async function cached(key, ttlSec, opts, fetcher) {
  const { force = false, onUpdate } = opts || {};
  const entry = readEntry(key);
  const now = Date.now();
  const fresh = entry && now - entry.at < ttlSec * 1000;

  if (entry && fresh && !force) {
    return { value: entry.value, fresh: true, stale: false };
  }
  if (entry && !force) {
    fetcher()
      .then((value) => {
        writeEntry(key, value);
        if (onUpdate) onUpdate(value);
      })
      .catch((e) => console.warn(`SWR refresh ${key} failed:`, e.message));
    return { value: entry.value, fresh: false, stale: true };
  }
  const value = await fetcher();
  writeEntry(key, value);
  return { value, fresh: true, stale: false };
}

export async function getQuote(symbol, opts) {
  if (isInternational(symbol)) {
    const key = cacheKey("yh", "/quote", { symbol });
    return cached(key, QUOTE_TTL, opts, async () => {
      const raw = await rapidFetch("/market/v2/get-quotes", {
        region: "US",
        symbols: symbol,
      });
      const result = raw?.quoteResponse?.result?.[0];
      return normalizeApidojoQuote(result);
    });
  }
  const key = cacheKey("fh", "/quote", { symbol });
  return cached(key, QUOTE_TTL, opts, async () => {
    const raw = await finnhubFetch("/quote", { symbol });
    return normalizeFinnhubQuote(raw);
  });
}

/**
 * Batch international quotes. apidojo's /market/v2/get-quotes accepts
 * comma-separated symbols across exchanges in a single call -> 1 request.
 *
 * Cache is checked per-symbol; only stale/missing symbols hit the API.
 */
export async function getQuotesBatch(symbols, opts = {}) {
  const out = {};
  const stale = [];

  for (const sym of symbols) {
    const key = cacheKey("yh", "/quote", { symbol: sym });
    const entry = readEntry(key);
    const now = Date.now();
    const fresh = entry && now - entry.at < QUOTE_TTL * 1000;
    if (entry) out[sym] = entry.value;
    if (!entry || !fresh || opts.force) stale.push(sym);
  }

  if (!stale.length) return out;

  try {
    const raw = await rapidFetch("/market/v2/get-quotes", {
      region: "US",
      symbols: stale.join(","),
    });
    const results = raw?.quoteResponse?.result || [];
    const bySym = new Map(results.map((r) => [r.symbol, r]));
    for (const sym of stale) {
      const r = bySym.get(sym);
      const norm = r ? normalizeApidojoQuote(r) : null;
      if (norm) {
        out[sym] = norm;
        const key = cacheKey("yh", "/quote", { symbol: sym });
        writeEntry(key, norm);
      }
    }
  } catch (e) {
    console.warn("Batch quote failed:", e.message);
  }

  return out;
}

export async function getProfile(symbol, opts) {
  if (isInternational(symbol)) {
    const q = await getQuote(symbol, opts);
    return { value: profileFromApidojoQuote(q.value), fresh: q.fresh, stale: q.stale };
  }
  const key = cacheKey("fh", "/stock/profile2", { symbol });
  return cached(key, PROFILE_TTL, opts, async () => {
    const raw = await finnhubFetch("/stock/profile2", { symbol });
    return normalizeFinnhubProfile(raw);
  });
}

export async function getMetric(symbol, opts) {
  if (isInternational(symbol)) {
    const q = await getQuote(symbol, opts);
    return { value: metricFromApidojoQuote(q.value), fresh: q.fresh, stale: q.stale };
  }
  const key = cacheKey("fh", "/stock/metric", { symbol, metric: "all" });
  return cached(key, METRIC_TTL, opts, async () => {
    const raw = await finnhubFetch("/stock/metric", { symbol, metric: "all" });
    return normalizeFinnhubMetric(raw);
  });
}

/* =========================================================================
 * Historical candles (used by the stock detail chart)
 *
 * apidojo /stock/v3/get-chart returns Yahoo's standard chart payload:
 *   chart.result[0].timestamp = [unix, ...]
 *   chart.result[0].indicators.quote[0] = { close: [...], open, high, low, volume }
 *
 * Both US and international symbols use this endpoint (Finnhub /stock/candle
 * is paid). Cache TTLs are tuned by interval to protect the 500/mo quota.
 * ========================================================================= */

export function timeframeToRange(tf) {
  switch (tf) {
    case "1D":  return { range: "1d",  interval: "5m"  };
    case "1W":  return { range: "5d",  interval: "15m" };
    case "1M":  return { range: "1mo", interval: "1d"  };
    case "3M":  return { range: "3mo", interval: "1d"  };
    case "1Y":  return { range: "1y",  interval: "1d"  };
    case "5Y":  return { range: "5y",  interval: "1wk" };
    default:    return { range: "1mo", interval: "1d"  };
  }
}

function candleTtlSec(interval) {
  if (interval.endsWith("m")) return 5 * 60;        // intraday: 5 min
  if (interval === "1d") return 60 * 60;            // daily:    1 hr
  return 24 * 60 * 60;                              // weekly+: 24 hr
}

export async function getCandles(symbol, range, interval, opts) {
  const key = cacheKey("yh", "/stock/v3/get-chart", { symbol, range, interval });
  return cached(key, candleTtlSec(interval), opts, async () => {
    const raw = await rapidFetch("/stock/v3/get-chart", {
      symbol,
      range,
      interval,
      region: "US",
    });
    const result = raw?.chart?.result?.[0];
    if (!result) return null;
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const closes = q.close || [];
    // Drop any null gaps (Yahoo sometimes returns null for thin sessions).
    const points = [];
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] == null || !isFinite(closes[i])) continue;
      points.push({ time: ts[i], value: +closes[i] });
    }
    return {
      points,
      currency: result.meta?.currency || null,
      symbol: result.meta?.symbol || symbol,
    };
  });
}
