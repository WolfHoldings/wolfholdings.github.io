// js/parse.js
//
// Manual fallback for fetching stock quotes when the RapidAPI quota is
// exhausted. Reads Yahoo Finance's unauthenticated v8 chart endpoint
// through a chain of public CORS proxies (the endpoint itself does not
// send Access-Control-Allow-Origin, so direct browser fetch fails).
//
// Returns quotes in the same shape as `normalizeApidojoQuote` in api.js,
// so the existing render pipeline consumes them without changes.

const ENDPOINT = (sym) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
  `?interval=1d&range=1d&includePrePost=true`;

const PROXIES = [
  null, // direct first — succeeds in browser extensions / dev envs
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
  (u) => `https://cors.x2u.in/${u}`,
  (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
];

function safeHost(u) {
  try { return new URL(u).host; } catch { return u.slice(0, 30); }
}

async function fetchJsonViaAnyProxy(url, timeoutMs = 8000) {
  const attempts = [];
  for (const wrap of PROXIES) {
    const target = wrap ? wrap(url) : url;
    const name = wrap ? safeHost(target) : "direct";
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
        attempts.push(`${name}: HTTP ${res.status}`);
        continue;
      }
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      let j;
      if (ct.includes("json")) {
        j = await res.json();
      } else {
        // Some proxies (allorigins/raw) drop the JSON content-type or wrap
        // the body. Try parsing the text anyway; a Cloudflare HTML challenge
        // will throw and fall through.
        const text = await res.text();
        try { j = JSON.parse(text); } catch {
          attempts.push(`${name}: not-JSON (${text.slice(0, 40)})`);
          continue;
        }
      }
      if (!j?.chart || j.chart.error) {
        attempts.push(`${name}: chart-${j?.chart?.error?.code || "missing"}`);
        continue;
      }
      return { json: j, proxy: name, attempts };
    } catch (e) {
      attempts.push(`${name}: ${e.name || "Error"}`);
    }
  }
  return { json: null, proxy: null, attempts };
}

function normalizeYahooChartMeta(meta) {
  if (!meta) return null;
  const reg = +meta.regularMarketPrice;
  const pc = +(meta.chartPreviousClose ?? meta.previousClose);
  if (!isFinite(reg)) return null;

  // Match the extended-hours rules used by api.js / refresh.mjs.
  let c = reg;
  let d = isFinite(pc) ? reg - pc : 0;
  let dp = isFinite(pc) && pc !== 0 ? (d / pc) * 100 : 0;
  let extendedLabel = null;

  const ms = meta.marketState || null;
  const post = +meta.postMarketPrice;
  const pre = +meta.preMarketPrice;

  if ((ms === "POST" || ms === "POSTPOST") && isFinite(post) && post > 0) {
    c = post;
    d = post - reg;
    dp = reg ? (d / reg) * 100 : 0;
    extendedLabel = "After hours";
  } else if ((ms === "PRE" || ms === "PREPRE") && isFinite(pre) && pre > 0) {
    c = pre;
    d = isFinite(pc) ? pre - pc : 0;
    dp = isFinite(pc) && pc !== 0 ? (d / pc) * 100 : 0;
    extendedLabel = "Pre-market";
  }

  return {
    c,
    d,
    dp,
    pc: isFinite(pc) ? pc : NaN,
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
    marketState: ms,
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
      const got = await fetchJsonViaAnyProxy(ENDPOINT(sym));
      const meta = got?.json?.chart?.result?.[0]?.meta;
      const norm = meta ? normalizeYahooChartMeta(meta) : null;
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
