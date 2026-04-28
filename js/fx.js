// Currency → USD conversion rates, sourced from Yahoo Finance FX symbols
// (e.g. `TWDUSD=X` returns the value of 1 TWD in USD).
//
// Rates are fetched via the same `getQuotesBatch` plumbing used for stock
// quotes — that means the existing localStorage SWR cache and rate limiter
// in api.js apply automatically, and on the Refresh path FX symbols can be
// bundled into the same batch as stock symbols (no extra HTTP call).

import { getQuotesBatch } from "./api.js";

// Native currency → Yahoo Finance FX symbol + multiplier on the fetched rate.
// `multiplier` is for sub-units (e.g. London quotes UK stocks in pence: GBp).
const CURRENCY_FX = {
  TWD: { symbol: "TWDUSD=X", multiplier: 1 },
  EUR: { symbol: "EURUSD=X", multiplier: 1 },
  SEK: { symbol: "SEKUSD=X", multiplier: 1 },
  NOK: { symbol: "NOKUSD=X", multiplier: 1 },
  DKK: { symbol: "DKKUSD=X", multiplier: 1 },
  GBP: { symbol: "GBPUSD=X", multiplier: 1 },
  GBp: { symbol: "GBPUSD=X", multiplier: 0.01 }, // pence
  GBX: { symbol: "GBPUSD=X", multiplier: 0.01 }, // alt pence ticker
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

export function fxSymbolsForCurrencies(currencies) {
  const out = new Set();
  for (const cur of currencies) {
    if (!cur || cur === "USD") continue;
    const m = CURRENCY_FX[cur];
    if (m) out.add(m.symbol);
  }
  return [...out];
}

export function rateFromQuotes(currency, quotesBySymbol) {
  if (!currency || currency === "USD") return 1;
  const m = CURRENCY_FX[currency];
  if (!m) return NaN;
  const q = quotesBySymbol?.[m.symbol];
  if (!q || !isFinite(q.c)) return NaN;
  return q.c * m.multiplier;
}

/**
 * Fetch USD-conversion rates for a list of native currencies.
 * Returns `{ USD: 1, TWD: 0.031, ... }`. Missing rates come back as NaN.
 */
export async function getUsdRates(currencies, opts = {}) {
  const rates = { USD: 1 };
  const fxSyms = fxSymbolsForCurrencies(currencies);
  if (!fxSyms.length) return rates;
  const quotes = await getQuotesBatch(fxSyms, opts);
  for (const cur of currencies) {
    if (cur === "USD") continue;
    rates[cur] = rateFromQuotes(cur, quotes);
  }
  return rates;
}
