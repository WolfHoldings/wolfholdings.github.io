// Loads data/snapshot.json — the cron-refreshed cache of quotes/profiles/metrics
// produced by .github/workflows/refresh-quotes.yml. Visitors render from this
// without spending API quota; only the manual Refresh button hits live APIs.
//
// Shape:
// {
//   "updatedAt": "2026-04-27T19:00:00.000Z",
//   "quotes":   { SYMBOL: { c, d, dp, o, h, l, pc, currency, name, ... }, ... },
//   "profiles": { SYMBOL: { name, logo, sector, ... }, ... },
//   "metrics":  { SYMBOL: { peTTM, fiftyTwoWeekHigh, ... }, ... }
// }
export async function loadSnapshot(path = "data/snapshot.json") {
  try {
    const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-cache" });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.quotes) return null;
    return data;
  } catch {
    return null;
  }
}
