# Yahoo Finance proxy (Cloudflare Worker)

Tiny CORS proxy in front of `query1.finance.yahoo.com/v8/finance/chart/`. The
GitHub Pages site can't call Yahoo directly because Yahoo doesn't send
`Access-Control-Allow-Origin`; this Worker forwards the request from
Cloudflare's edge and adds the CORS headers.

## Deploy

```sh
npm i -g wrangler
wrangler login
wrangler deploy
```

`wrangler deploy` prints a URL like
`https://wolfholdings-yahoo-proxy.<account>.workers.dev`. Paste it into the
`WORKER_BASE` constant at the top of [`../js/parse.js`](../js/parse.js), commit,
and push — GitHub Pages will pick it up on the next build.

## Smoke test

```sh
curl 'https://wolfholdings-yahoo-proxy.<account>.workers.dev/?symbol=AAPL' | head -c 200
# → {"chart":{"result":[{"meta":{...

curl -I -H 'Origin: https://wolfholdings.github.io' \
  'https://wolfholdings-yahoo-proxy.<account>.workers.dev/?symbol=AAPL'
# → Access-Control-Allow-Origin: https://wolfholdings.github.io
```

## Capacity

Cloudflare Workers free plan = 100,000 requests/day, 10 ms CPU per request.
Expected steady-state load is well under 1% of that (≤10 manual Parse Data
clicks × ≤50 symbols = ≤500 req/day).

## Allowed origins

Edit `ALLOWED_ORIGINS` in [`yahoo-proxy.js`](yahoo-proxy.js) when adding new
deploy targets (custom domain, preview environments, etc.). Unknown origins
still get `Access-Control-Allow-Origin: *` so they aren't hard-blocked.
