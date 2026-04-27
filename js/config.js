// API configuration. This file is served publicly as part of the GitHub Pages
// site, so values here are visible in source. Free-tier keys are designed for
// browser use and rate limiting is the protection.

// Finnhub — used for US stocks. Free tier: 60 calls/minute.
// Sign up at https://finnhub.io/register.
export const FINNHUB_API_KEY = "d7nfhk1r01qppri4mah0d7nfhk1r01qppri4mahg";
export const FINNHUB_RATE_LIMIT_PER_MIN = 60;

// RapidAPI Yahoo Finance (apidojo) — used for international stocks (.TW, .L,
// .DE, .ST, .HK, .T, etc.). Free tier: 500 requests/month, batch-friendly,
// direct CORS support.
// Subscribe at https://rapidapi.com/apidojo/api/yahoo-finance1
export const RAPIDAPI_KEY = "85a86400aemshbe3cc3b29bf318dp104fdfjsnf3220b71a4a9";
export const RAPIDAPI_HOST = "apidojo-yahoo-finance-v1.p.rapidapi.com";

// Conservative pacing. RapidAPI's hard ceiling is monthly, but spacing requests
// keeps the headroom obvious.
export const RAPIDAPI_RATE_LIMIT_PER_MIN = 30;
