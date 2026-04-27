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
  const symbols = rows
    .map((r) => (r.symbol || "").trim().toUpperCase())
    .filter(Boolean);
  if (!symbols.length) {
    console.error("No symbols in holdings.csv");
    process.exit(1);
  }

  console.log(`Refreshing ${symbols.length} symbols via Yahoo Finance`);

  const quotes = {};
  const profiles = {};
  const metrics = {};

  try {
    const raw = await rapidGet("/market/v2/get-quotes", {
      region: "US",
      symbols: symbols.join(","),
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
  } catch (e) {
    console.error("Batch quote failed:", e.message);
    process.exit(1);
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
