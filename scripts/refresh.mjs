// scripts/refresh.mjs
//
// Run by .github/workflows/refresh-quotes.yml every 3 hours. Reads
// data/holdings.csv, hits the same providers the browser does (Finnhub for US,
// apidojo Yahoo via RapidAPI for international), and writes data/snapshot.json.
//
// Secrets:
//   FINNHUB_API_KEY  (GitHub Secret)
//   RAPIDAPI_KEY     (GitHub Secret)
//
// Node 20+ — uses built-in fetch.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = "apidojo-yahoo-finance-v1.p.rapidapi.com";

if (!FINNHUB_KEY) {
  console.error("Missing FINNHUB_API_KEY env var");
  process.exit(1);
}
if (!RAPIDAPI_KEY) {
  console.error("Missing RAPIDAPI_KEY env var");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isInternational(symbol) {
  return /\.[A-Z]{1,3}$/.test(symbol);
}

function parseCSV(text) {
  // Hand-roll a tiny CSV parser. Holdings file has no quoted fields, so a
  // simple split on comma per line is correct. Header row is required.
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row = {};
    headers.forEach((h, i) => (row[h] = (cols[i] ?? "").trim()));
    return row;
  });
}

function num(x) {
  if (x == null) return NaN;
  if (typeof x === "number") return x;
  const n = parseFloat(x);
  return isFinite(n) ? n : NaN;
}

/* ---------- Finnhub ---------- */

async function finnhubGet(endpoint, params) {
  const url = new URL(`https://finnhub.io/api/v1${endpoint}`);
  url.searchParams.set("token", FINNHUB_KEY);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Finnhub ${endpoint} ${r.status}`);
  return r.json();
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

/* ---------- apidojo Yahoo via RapidAPI ---------- */

async function rapidGet(endpoint, params) {
  const url = new URL(`https://${RAPIDAPI_HOST}${endpoint}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const r = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": RAPIDAPI_KEY,
      "X-RapidAPI-Host": RAPIDAPI_HOST,
    },
  });
  if (!r.ok) throw new Error(`RapidAPI ${endpoint} ${r.status}`);
  return r.json();
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

function profileFromApidojo(quote) {
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

function metricFromApidojo(quote) {
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

/* ---------- main ---------- */

async function main() {
  const csvText = readFileSync("data/holdings.csv", "utf-8");
  const rows = parseCSV(csvText);
  const symbols = rows
    .map((r) => (r.symbol || "").trim().toUpperCase())
    .filter(Boolean);
  if (!symbols.length) {
    console.error("No symbols in holdings.csv");
    process.exit(1);
  }

  const usSymbols = symbols.filter((s) => !isInternational(s));
  const intlSymbols = symbols.filter(isInternational);

  console.log(`Refreshing ${symbols.length} symbols (${usSymbols.length} US, ${intlSymbols.length} intl)`);

  const quotes = {};
  const profiles = {};
  const metrics = {};

  // US: Finnhub /quote, /stock/profile2, /stock/metric per symbol.
  for (const sym of usSymbols) {
    try {
      const [q, p, m] = await Promise.all([
        finnhubGet("/quote", { symbol: sym }),
        finnhubGet("/stock/profile2", { symbol: sym }),
        finnhubGet("/stock/metric", { symbol: sym, metric: "all" }),
      ]);
      const nq = normalizeFinnhubQuote(q);
      const np = normalizeFinnhubProfile(p);
      const nm = normalizeFinnhubMetric(m);
      if (nq) quotes[sym] = nq;
      if (np) profiles[sym] = np;
      if (nm) metrics[sym] = nm;
      console.log(`  ${sym}: $${nq?.c ?? "?"} (${nq?.dp?.toFixed?.(2) ?? "?"}%)`);
    } catch (e) {
      console.warn(`  ${sym} failed:`, e.message);
    }
    // Tiny pause to be polite — Finnhub free is 60/min, this stays well under.
    await sleep(75);
  }

  // International: one batch call to apidojo for all symbols.
  if (intlSymbols.length) {
    try {
      const r = await rapidGet("/market/v2/get-quotes", {
        region: "US",
        symbols: intlSymbols.join(","),
      });
      const results = r?.quoteResponse?.result || [];
      for (const result of results) {
        const sym = result.symbol;
        const nq = normalizeApidojoQuote(result);
        if (nq) {
          quotes[sym] = nq;
          profiles[sym] = profileFromApidojo(nq);
          metrics[sym] = metricFromApidojo(nq);
          console.log(`  ${sym}: ${nq.currency} ${nq.c} (${nq.dp.toFixed(2)}%)`);
        }
      }
      const got = new Set(results.map((r) => r.symbol));
      for (const sym of intlSymbols) {
        if (!got.has(sym)) console.warn(`  ${sym} missing from response`);
      }
    } catch (e) {
      console.error(`Intl batch failed:`, e.message);
    }
  }

  const snapshot = {
    updatedAt: new Date().toISOString(),
    quotes,
    profiles,
    metrics,
  };

  const out = "data/snapshot.json";
  if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`Wrote ${out} with ${Object.keys(quotes).length} quotes`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
