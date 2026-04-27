// Loads data/holdings.csv and parses it via PapaParse (loaded globally from CDN
// in the HTML). Schema:
//   symbol,unit_cost,shares,currency,usd_rate,market,platform,note
// All fields after symbol/unit_cost/shares are optional and have inferred
// defaults. Numeric fields are coerced; rows with bad numerics are dropped.
const SUFFIX_TO_MARKET = {
  TW:  "Taiwan",
  TWO: "Taiwan",   // Taipei Exchange (smaller-cap board)
  ST:  "Sweden",
  L:   "UK",
  DE:  "Germany",
  HK:  "Hong Kong",
  T:   "Japan",
  PA:  "France",
  AS:  "Netherlands",
  MI:  "Italy",
  AX:  "Australia",
  TO:  "Canada",
  V:   "Canada",
  SS:  "China",
  SZ:  "China",
  SW:  "Switzerland",
  KS:  "South Korea",
};

function parseBool(s) {
  return /^(true|yes|y|1)$/i.test((s || "").trim());
}

function defaultLink(symbol) {
  return `https://au.finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`;
}

function inferMarket(symbol) {
  const m = symbol.match(/\.([A-Z]{1,3})$/);
  if (!m) return "US";
  return SUFFIX_TO_MARKET[m[1]] || m[1];
}

export async function loadHoldings(path = "data/holdings.csv") {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load holdings.csv (${res.status})`);
  const text = await res.text();

  const parsed = window.Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });

  if (parsed.errors && parsed.errors.length) {
    console.warn("CSV parse warnings:", parsed.errors);
  }

  return parsed.data
    .map((row) => {
      const symbol = (row.symbol || "").trim().toUpperCase();
      // Yahoo / Twelve Data preserve case for some intl tickers (e.g.
      // GBp on London). Symbol itself is uppercased — currency is not.
      const currency = (row.currency || "USD").trim() || "USD";
      const usdRate = parseFloat(row.usd_rate);
      const market = (row.market || "").trim() || inferMarket(symbol);
      const link = (row.link || "").trim() || defaultLink(symbol);
      return {
        symbol,
        unitCost: parseFloat(row.unit_cost),
        shares: parseFloat(row.shares),
        currency,
        usdRate: isFinite(usdRate) && usdRate > 0
          ? usdRate
          : currency === "USD" ? 1 : NaN,
        market,
        client: parseBool(row.client),
        platform: (row.platform || "").trim(),
        note: (row.note || "").trim(),
        link,
      };
    })
    .filter(
      (h) =>
        h.symbol &&
        isFinite(h.unitCost) &&
        isFinite(h.shares) &&
        h.shares > 0 &&
        isFinite(h.usdRate),
    )
    .map((h) => ({
      ...h,
      totalCostNative: h.unitCost * h.shares,
      totalCostUsd: h.unitCost * h.shares * h.usdRate,
    }));
}
