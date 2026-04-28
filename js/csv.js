// Loads data/holdings.csv and parses it via PapaParse (loaded globally from CDN
// in the HTML). Schema:
//   symbol,unit_cost,shares,currency,market,client,platform,note,link
// All fields after symbol/unit_cost/shares are optional and have inferred
// defaults. Numeric fields are coerced; rows with bad numerics are dropped.
//
// USD conversion is no longer in the CSV — rates are fetched from Yahoo
// Finance FX symbols at runtime (see js/fx.js). Rows for non-USD currencies
// are returned with `usdRate: NaN` and `totalCostUsd: NaN`; the caller
// must apply rates before rendering totals.
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
      // Yahoo preserves case for some intl currency codes (e.g. GBp = pence
      // on London). Symbol itself is uppercased — currency is not.
      const currency = (row.currency || "USD").trim() || "USD";
      const market = (row.market || "").trim() || inferMarket(symbol);
      const link = (row.link || "").trim() || defaultLink(symbol);
      return {
        symbol,
        unitCost: parseFloat(row.unit_cost),
        shares: parseFloat(row.shares),
        currency,
        usdRate: currency === "USD" ? 1 : NaN, // filled in later by fx.js
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
        h.shares > 0,
    )
    .map((h) => ({
      ...h,
      totalCostNative: h.unitCost * h.shares,
      totalCostUsd: isFinite(h.usdRate)
        ? h.unitCost * h.shares * h.usdRate
        : NaN,
    }));
}

// Loads data/cash.csv. Schema:
//   date,amount,currency,is_client_cash[,usd_rate]
// usd_rate is optional; defaults to 1 for USD entries, NaN otherwise (which
// causes the row to be filtered out — non-USD cash needs an explicit rate).
export async function loadCash(path = "data/cash.csv") {
  let res;
  try {
    res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-cache" });
  } catch {
    return [];
  }
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`Failed to load cash.csv (${res.status})`);
  }
  const text = await res.text();

  const parsed = window.Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });

  return parsed.data
    .map((row) => {
      const currency = (row.currency || "USD").trim() || "USD";
      const amount = parseFloat(row.amount);
      const usdRateRaw = parseFloat(row.usd_rate);
      const usdRate = isFinite(usdRateRaw) && usdRateRaw > 0
        ? usdRateRaw
        : currency === "USD" ? 1 : NaN;
      return {
        date: (row.date || "").trim(),
        amount,
        currency,
        usdRate,
        amountUsd: amount * usdRate,
        client: parseBool(row.is_client_cash),
      };
    })
    .filter((c) => isFinite(c.amount) && c.amount > 0 && isFinite(c.amountUsd));
}
