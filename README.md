# wolfholdings.github.io

Personal portfolio tracker — a static GitHub Pages site that reads my holdings
from a CSV and renders live quotes, fundamentals, multi-currency totals, and
historical line charts for both US and international stocks. No backend, no
build step.

Live site: <https://wolfholdings.github.io/>

## How quotes refresh

Two paths feed data into the page:

| Path                              | When                                           | Cost                          |
|-----------------------------------|------------------------------------------------|-------------------------------|
| **Snapshot** (`data/snapshot.json`) | Auto-refreshed every 3 hours by GitHub Actions | Server-side; visitors pay nothing |
| **Live API** (Refresh button)     | When *you* click Refresh                       | Hits Finnhub / RapidAPI from browser |

Visitors loading the page never call any quote API directly — they read the
already-committed snapshot. The "Updated 2 hours ago" pill next to the
Refresh button shows snapshot freshness, with the exact timestamp on hover.

This setup keeps the RapidAPI free quota (500/month) safe even if multiple
people visit:

- Cron runs: 8/day × ~30 days = **~240 RapidAPI requests/month** (1 batched
  intl quote per run). Well under the 500 ceiling.
- Each manual Refresh click costs 1 batched intl quote + N Finnhub quotes.

### Setting up the cron (one-time)

Required for the auto-refresh to work after you clone or fork:

1. **Add GitHub Actions Secrets** (Repo → Settings → Secrets and variables → Actions → New repository secret):
   - `FINNHUB_API_KEY`  — your Finnhub key (same value that's in `js/config.js`)
   - `RAPIDAPI_KEY`     — your RapidAPI key
2. **Allow Actions to write** (Repo → Settings → Actions → General → Workflow permissions): set to "Read and write permissions". Already required to commit the snapshot file back.
3. The workflow at [.github/workflows/refresh-quotes.yml](.github/workflows/refresh-quotes.yml) runs on:
   - cron `0 */3 * * *` (every 3 hours)
   - any push that touches `data/holdings.csv` (so adding/removing holdings refreshes immediately)
   - manual trigger (Repo → Actions → Refresh quotes snapshot → Run workflow)

`scripts/refresh.mjs` is the script the Action runs — it reads the CSV, calls
the same APIs the browser would, and writes `data/snapshot.json`.

## Data sources

| Asset class                | Provider                                                 | Free tier             |
|----------------------------|----------------------------------------------------------|-----------------------|
| US stock quotes/profile/metric | [Finnhub](https://finnhub.io)                          | 60 calls/min          |
| International stock quotes | [apidojo Yahoo Finance via RapidAPI](https://rapidapi.com/apidojo/api/yahoo-finance1) | 500/month |
| Historical chart (all)     | apidojo Yahoo Finance via RapidAPI                       | 500/month             |

Browser-side keys live in [js/config.js](js/config.js) — visible in source, but
both providers explicitly support browser usage of free-tier keys, and rate
limiting is the protection. Server-side, the same keys are read from GitHub
Actions Secrets so they're not exposed in the workflow file.

## Updating holdings

Edit [data/holdings.csv](data/holdings.csv). Schema:

```csv
symbol,unit_cost,shares,currency,usd_rate,market,client,platform,note
FLY,27.70,37,USD,1,US,true,Robinhood,
2330.TW,950.00,200,TWD,0.031,Taiwan,true,Yuanta,TSMC
IQE.L,28.50,1500,GBp,0.0125,UK,false,IBKR,quoted in pence
```

Required: `symbol`, `unit_cost`, `shares`. Optional with sensible defaults:

- `currency` → `USD`
- `usd_rate` → `1` for USD, otherwise required
- `market` → inferred from the suffix (`.TW`/`.TWO`→Taiwan, `.L`→UK,
  `.DE`→Germany, `.ST`→Sweden, `.HK`→Hong Kong, `.T`→Japan, etc.)
- `client` → `false`. Set to `true` for shares held on behalf of a client.
  Marked with a blue verified-checkmark in the UI; a separate **Client** tab
  filters to those holdings.
- `platform`, `note` → blank

### Currency notes

- `unit_cost` is in the **native currency** of the listing, not USD.
- `usd_rate` is the multiplier from native to USD (e.g. `1 TWD = 0.031 USD`).
  Update it when you want totals to reflect a fresher FX rate.
- **London Stock Exchange quotes most stocks in pence (`GBp`)**, not pounds.
  Yahoo reports London prices in `GBp` natively, so as long as the CSV is in
  pence the live price will line up. Use `usd_rate = GBP-to-USD ÷ 100`
  (e.g. `0.0125` for 1 GBP = $1.25).

## How the UI works

- **Portfolio total** is always in USD (sum of `price × shares × usd_rate`).
- **Per-row price** is shown in native currency; USD market value and USD
  total return appear beneath it (with `≈` prefix when converted).
- **Tabs** above the holdings list filter by group:
  - `All` — everything
  - `Client` — only `client=true` rows (shown right after All if any exist)
  - per-market tabs — US, Taiwan, UK, Germany, Sweden, …
  - each tab shows the USD subtotal for that group
- **Verified checkmark** appears next to the company name on every
  client-owned row, both on the list and the detail page.
- **Detail page** (`stock.html?symbol=…`) — Robinhood-style line chart with
  timeframe buttons (1D / 1W / 1M / 3M / 1Y / 5Y), position info in both
  native and USD, company info, and key statistics.

## Local development

The page uses `fetch` to load CSV/JSON, so it must be served over HTTP (not
opened as `file://`):

```bash
python -m http.server 8000
# open http://localhost:8000
```

To regenerate the snapshot locally:

```bash
FINNHUB_API_KEY=... RAPIDAPI_KEY=... node scripts/refresh.mjs
```

## Deploying

`git push` to `main`. GitHub Pages auto-publishes the repo root since this is
a user-page repo (`<user>.github.io`). The first push also kicks off the cron
workflow because the workflow's `push` trigger watches the holdings file.
