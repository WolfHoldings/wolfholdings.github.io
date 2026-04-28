// scripts/refresh.mjs
//
// Run by .github/workflows/refresh-quotes.yml every 3 hours. Reads
// data/holdings.csv, fetches all symbols in a single Yahoo Finance batch call
// via RapidAPI, and writes data/snapshot.json.
//
// Secrets:
//   RAPIDAPI_KEY  (GitHub Secret)
//
// Node 20+ — uses built-in fetch.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = "apidojo-yahoo-finance-v1.p.rapidapi.com";

if (!RAPIDAPI_KEY) {
  console.error("Missing RAPIDAPI_KEY env var");
  process.exit(1);
}

// Native currency → Yahoo FX symbol + multiplier. Mirrors js/fx.js so the
// cron and the browser stay consistent. Add more currencies as holdings.csv
// expands.
const CURRENCY_FX = {
  TWD: { symbol: "TWDUSD=X", multiplier: 1 },
  EUR: { symbol: "EURUSD=X", multiplier: 1 },
  SEK: { symbol: "SEKUSD=X", multiplier: 1 },
  NOK: { symbol: "NOKUSD=X", multiplier: 1 },
  DKK: { symbol: "DKKUSD=X", multiplier: 1 },
  GBP: { symbol: "GBPUSD=X", multiplier: 1 },
  GBp: { symbol: "GBPUSD=X", multiplier: 0.01 },
  GBX: { symbol: "GBPUSD=X", multiplier: 0.01 },
  JPY: { symbol: "JPYUSD=X", multiplier: 1 },
  HKD: { symbol: "HKDUSD=X", multiplier: 1 },
  CAD: { symbol: "CADUSD=X", multiplier: 1 },
  AUD: { symbol: "AUDUSD=X", multiplier: 1 },
  CHF: { symbol: "CHFUSD=X", multiplier: 1 },
  CNY: { symbol: "CNYUSD=X", multiplier: 1 },
  SGD: { symbol: "SGDUSD=X", multiplier: 1 },
  KRW: { symbol: "KRWUSD=X", multiplier: 1 },
  NZD: { symbol: "NZDUSD=X", multiplier: 1 },
};

function parseCSV(text) {
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
  const regPrice = num(r.regularMarketPrice);
  const pc = num(r.regularMarketPreviousClose);
  if (!isFinite(regPrice)) return null;

  const marketState = r.marketState || null;
  let c = regPrice;
  let d = num(r.regularMarketChange);
  let dp = num(r.regularMarketChangePercent);
  let extendedLabel = null;

  if (marketState === "POST" || marketState === "POSTPOST") {
    const pp = num(r.postMarketPrice);
    if (isFinite(pp) && pp > 0) {
      c = pp; d = num(r.postMarketChange); dp = num(r.postMarketChangePercent);
      extendedLabel = "After hours";
    }
  } else if (marketState === "PRE" || marketState === "PREPRE") {
    const pp = num(r.preMarketPrice);
    if (isFinite(pp) && pp > 0) {
      c = pp; d = num(r.preMarketChange); dp = num(r.preMarketChangePercent);
      extendedLabel = "Pre-market";
    }
  }

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
    marketState,
    extendedLabel,
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

  // Bear-tab CSV is optional; a missing file is fine (the tab just won't show).
  let bearRows = [];
  try {
    const bearText = readFileSync("data/bear_holding.csv", "utf-8");
    bearRows = parseCSV(bearText);
  } catch {
    bearRows = [];
  }

  const allRows = [...rows, ...bearRows];
  const symbols = [
    ...new Set(
      allRows.map((r) => (r.symbol || "").trim().toUpperCase()).filter(Boolean),
    ),
  ];
  if (!symbols.length) {
    console.error("No symbols in holdings.csv or bear_holding.csv");
    process.exit(1);
  }

  // Discover non-USD currencies in both CSVs + map to Yahoo FX symbols.
  // Bundling FX into the same batch keeps this cron at one HTTP call total.
  const currencies = [...new Set(allRows.map((r) => (r.currency || "USD").trim()))]
    .filter((c) => c && c !== "USD");
  const fxSymbolByCurrency = new Map();
  for (const cur of currencies) {
    const m = CURRENCY_FX[cur];
    if (m) fxSymbolByCurrency.set(cur, m);
  }
  const fxSymbols = [...new Set([...fxSymbolByCurrency.values()].map((m) => m.symbol))];

  const allSymbols = [...symbols, ...fxSymbols];
  console.log(
    `Refreshing ${symbols.length} stock symbols + ${fxSymbols.length} FX symbols via Yahoo Finance`,
  );

  const quotes = {};
  const profiles = {};
  const metrics = {};
  const fxRates = { USD: 1 };

  try {
    const raw = await rapidGet("/market/v2/get-quotes", {
      region: "US",
      symbols: allSymbols.join(","),
    });
    const results = raw?.quoteResponse?.result || [];
    const bySym = new Map(results.map((res) => [res.symbol, res]));

    for (const sym of symbols) {
      const result = bySym.get(sym);
      if (!result) {
        console.warn(`  ${sym}: missing from response`);
        continue;
      }
      const nq = normalizeApidojoQuote(result);
      if (!nq) {
        console.warn(`  ${sym}: could not normalize quote`);
        continue;
      }
      quotes[sym] = nq;
      profiles[sym] = profileFromApidojo(nq);
      metrics[sym] = metricFromApidojo(nq);
      const label = nq.extendedLabel ? ` [${nq.extendedLabel}]` : "";
      console.log(`  ${sym}: ${nq.currency} ${nq.c} (${nq.dp?.toFixed(2) ?? "?"}%)${label}`);
    }

    // Extract FX rates per native currency.
    for (const [cur, m] of fxSymbolByCurrency) {
      const fxResult = bySym.get(m.symbol);
      const price = fxResult ? Number(fxResult.regularMarketPrice) : NaN;
      if (isFinite(price) && price > 0) {
        fxRates[cur] = price * m.multiplier;
        console.log(`  FX ${cur} via ${m.symbol}: 1 ${cur} = ${fxRates[cur]} USD`);
      } else {
        console.warn(`  FX ${cur} (${m.symbol}): missing or invalid price`);
      }
    }
  } catch (e) {
    console.error("Batch quote failed:", e.message);
    process.exit(1);
  }

  const snapshot = {
    updatedAt: new Date().toISOString(),
    quotes,
    profiles,
    metrics,
    fxRates,
  };

  const out = "data/snapshot.json";
  if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(
    `Wrote ${out} with ${Object.keys(quotes).length} quotes + ${Object.keys(fxRates).length - 1} FX rates`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
