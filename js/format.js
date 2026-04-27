/* =========================================================================
 * Currency-aware formatting.
 *
 * Most currencies use Intl.NumberFormat. London pence ("GBp") isn't a real
 * ISO code, so we hand-format it. ISO codes returned by Twelve Data and
 * Finnhub map cleanly to NumberFormat via { style: "currency", currency }.
 * ========================================================================= */

const CURRENCY_LABELS = {
  USD: "$",
  TWD: "NT$",
  EUR: "€",
  GBP: "£",
  SEK: "kr",
  HKD: "HK$",
  JPY: "¥",
  CHF: "CHF",
  CAD: "C$",
  AUD: "A$",
  KRW: "₩",
  CNY: "¥",
};

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

const num2 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const num0 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const num4 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

function nativeFormatter(currency) {
  // Cache built formatters on the function object.
  nativeFormatter.cache ||= new Map();
  if (nativeFormatter.cache.has(currency)) return nativeFormatter.cache.get(currency);
  let fmt;
  try {
    fmt = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: currency === "JPY" || currency === "KRW" ? 0 : 2,
      maximumFractionDigits: currency === "JPY" || currency === "KRW" ? 0 : 2,
    });
  } catch {
    fmt = num2;
  }
  nativeFormatter.cache.set(currency, fmt);
  return fmt;
}

export function fmtMoney(n) {
  if (n == null || !isFinite(n)) return "—";
  return usdFmt.format(n);
}

export function fmtMoneyCompact(n) {
  if (n == null || !isFinite(n)) return "—";
  return usdCompact.format(n);
}

export function fmtNative(n, currency) {
  if (n == null || !isFinite(n)) return "—";
  if (!currency || currency === "USD") return usdFmt.format(n);
  if (currency === "GBp") return `${num2.format(n)}p`;
  // Some currencies have no ISO code Intl knows; fall back to our label map.
  try {
    return nativeFormatter(currency).format(n);
  } catch {
    const label = CURRENCY_LABELS[currency] || currency + " ";
    return `${label}${num2.format(n)}`;
  }
}

export function fmtNumber(n, frac = 2) {
  if (n == null || !isFinite(n)) return "—";
  return frac === 4 ? num4.format(n) : frac === 0 ? num0.format(n) : num2.format(n);
}

export function fmtSignedMoney(n) {
  if (n == null || !isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return sign + usdFmt.format(Math.abs(n));
}

export function fmtSignedNative(n, currency) {
  if (n == null || !isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return sign + fmtNative(Math.abs(n), currency);
}

export function fmtSignedPercent(n) {
  if (n == null || !isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${num2.format(Math.abs(n))}%`;
}

export function changeClass(n) {
  if (n == null || !isFinite(n) || n === 0) return "neutral";
  return n > 0 ? "up" : "down";
}

export function fmtShares(n) {
  if (n == null || !isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : num4.format(n);
}

const TIME_UNITS = [
  ["year",   31536000],
  ["month",  2592000],
  ["week",   604800],
  ["day",    86400],
  ["hour",   3600],
  ["minute", 60],
];

export function fmtRelativeTime(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return "—";
  const diff = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (diff < 30) return "just now";
  for (const [label, seconds] of TIME_UNITS) {
    const v = Math.floor(diff / seconds);
    if (v >= 1) return `${v} ${label}${v > 1 ? "s" : ""} ago`;
  }
  return `${diff} seconds ago`;
}
