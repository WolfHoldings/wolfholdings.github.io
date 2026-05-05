// Cloudflare Worker — proxies Yahoo Finance v8 chart endpoint with CORS so the
// static GitHub Pages site can read quotes from the browser. Deploy with
// `wrangler deploy` from this directory.

const ALLOWED_ORIGINS = new Set([
  "https://wolfholdings.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

const UPSTREAM_HOST = "query1.finance.yahoo.com";

function corsHeaders(origin) {
  return ALLOWED_ORIGINS.has(origin)
    ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" }
    : { "Access-Control-Allow-Origin": "*" };
}

export default {
  async fetch(request) {
    const cors = corsHeaders(request.headers.get("Origin") || "");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const symbol = url.searchParams.get("symbol");
    if (!symbol) {
      return new Response("missing symbol", { status: 400, headers: cors });
    }

    const upstream = new URL(
      `https://${UPSTREAM_HOST}/v8/finance/chart/${encodeURIComponent(symbol)}`,
    );
    upstream.searchParams.set("interval", url.searchParams.get("interval") || "1d");
    upstream.searchParams.set("range", url.searchParams.get("range") || "1d");
    upstream.searchParams.set("includePrePost", "true");

    const res = await fetch(upstream, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; WolfHoldingsProxy/1.0)",
        "Accept": "application/json",
      },
      cf: { cacheTtl: 30, cacheEverything: true },
    });

    return new Response(res.body, {
      status: res.status,
      headers: {
        ...cors,
        "Content-Type": res.headers.get("content-type") || "application/json",
        "Cache-Control": "public, max-age=30",
      },
    });
  },
};
