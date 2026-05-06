// Shared session-selection policy for US 24-hour trading.
//
// Drives three call sites that must stay consistent:
//   - js/api.js          (browser Refresh button, RapidAPI apidojo quotes)
//   - js/parse.js        (browser Parse Data button, Yahoo /v8/finance/chart)
//   - scripts/refresh.mjs(every-3h GitHub Actions cron, RapidAPI apidojo)
//
// Field names match what both Yahoo endpoints expose, so the same rules apply
// whether the input is a get-quotes result or a chart-meta object.

export const SESSION_RULES = [
  {
    states: ["OVERNIGHT"],
    priceKey: "overnightMarketPrice",
    changeKey: "overnightMarketChange",
    pctKey: "overnightMarketChangePercent",
    label: "Overnight",
  },
  {
    states: ["POST", "POSTPOST"],
    priceKey: "postMarketPrice",
    changeKey: "postMarketChange",
    pctKey: "postMarketChangePercent",
    label: "After hours",
  },
  {
    states: ["PRE", "PREPRE"],
    priceKey: "preMarketPrice",
    changeKey: "preMarketChange",
    pctKey: "preMarketChangePercent",
    label: "Pre-market",
  },
];

function fnum(x) {
  if (x == null) return NaN;
  const n = typeof x === "number" ? x : parseFloat(x);
  return Number.isFinite(n) ? n : NaN;
}

// Returns the session-aware price + label for an extended session, or null
// when no extended session applies (caller falls back to regular-session math).
export function pickSession(raw) {
  const ms = raw?.marketState || null;
  for (const rule of SESSION_RULES) {
    if (!rule.states.includes(ms)) continue;
    const price = fnum(raw[rule.priceKey]);
    if (price > 0) {
      return {
        marketState: ms,
        label: rule.label,
        price,
        change: fnum(raw[rule.changeKey]),
        pct: fnum(raw[rule.pctKey]),
      };
    }
  }
  return null;
}
