// api/nav-check.js  (plain Vercel Serverless Function — no framework needed)
//
// RUNS: 11:00am daily (see vercel.json in api-cron-holdings-check.js)
//
// WHAT THIS DOES
//   1. Fetches current NAV for every fund — tries CEFdata.com FIRST (per your
//      note that it publishes faster than CEFConnect some days), falls back
//      to CEFConnect if CEFdata doesn't have it yet.
//   2. Appends today's NAV to a running history table (one row per fund per day).
//   3. Recomputes each fund's 52-week NAV high/low from that history.
//   4. Also grabs the MARKET-PRICE 52-week high/low from Yahoo's chart
//      endpoint — this one's free and instant since every stock quote API
//      already tracks it; it's just not the same thing as NAV.
//
// THE HONEST PART, READ BEFORE TRUSTING THE NAV 52W NUMBERS:
// Nobody publishes "52-week NAV high/low" for closed-end funds as a ready
// field — I checked. Market-price 52w range is standard (every broker shows
// it), but NAV history has to be built from daily snapshots. That means:
//   - Day 1 after this job goes live: navHigh52w == navLow52w == today's NAV
//     (there's only one data point).
//   - It gets MORE accurate every day as history accumulates.
//   - It becomes a genuine trailing-365-day range only after ~12 months.
// The stored fields below are named navHigh52w_partial / navLow52w_partial
// until the history table has >= 365 rows for that fund, at which point you
// can rename them with confidence. Don't present these as a true 52-week
// range to anyone before that point without the same caveat.
//
// CEFDATA.COM CAVEAT
// Like CEFConnect, this is scraping an undocumented page — I haven't verified
// its exact HTML structure the way I did for CEFConnect, so treat
// parseCefDataNav() as a first draft to test and adjust, not a guarantee.
//
// STORAGE: uses Vercel KV, same as holdings-check.js — turn it on once in
// your Vercel dashboard's Storage tab (Create Database → KV) and both files
// share it automatically. Run: npm install @vercel/kv

import { kv } from "@vercel/kv";

const CEFDATA_BASE = "https://cefdata.com/funds/";      // verify exact path per fund before relying on this
const CEFCONNECT_BASE = "https://www.cefconnect.com/fund/";
const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/"; // same endpoint used by api-quote-proxy.js

async function fetchText(url, timeoutMs = 20000) {
  // Same per-request timeout fix as holdings-check.js — see comment there.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.google.com/",
        "Cache-Control": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "cross-site"
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseCefDataOverview(html) {
  // CONFIRMED WORKING (2026-09-11) against real cefdata.com output. This
  // matches an internal data structure embedded in the page's JavaScript
  // framework payload (not a documented API) — a sequence of raw volume
  // number, then quoted date/price/nav/discount strings in that exact order:
  //   3616192,"2026-09-10","5.85","6.66","-12.1621621621621621216"
  // This is fragile in the sense that it depends on cefdata.com's internal
  // data format staying the same shape — if it ever stops matching, that's
  // the likely reason, not a logic bug.
  const m = html.match(/\d+,"(\d{4}-\d{2}-\d{2})","(\d+\.\d+)","(\d+\.\d+)","(-?\d+\.\d+)"/);
  if (!m) return null;
  return {
    date: m[1],
    sharePrice: parseFloat(m[2]),
    nav: parseFloat(m[3]),
    premiumDiscountPct: parseFloat(m[4])
  };
}

function parseCefConnectOverview(html) {
  const m = html.match(/Current[\s\S]{0,300}?\$([\d,]+\.\d{2})[\s\S]{0,100}?\$([\d,]+\.\d{2})[\s\S]{0,100}?(-?\d+\.\d{2})%/);
  if (!m) return null;
  return {
    sharePrice: parseFloat(m[1].replace(/,/g, "")),
    nav: parseFloat(m[2].replace(/,/g, "")),
    premiumDiscountPct: parseFloat(m[3])
  };
}

async function fetchMarketPrice52wRange(ticker) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${YAHOO_CHART_BASE}${encodeURIComponent(ticker)}?range=1y&interval=1d`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal
    });
    clearTimeout(timer);
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    return meta ? { high: meta.fiftyTwoWeekHigh ?? null, low: meta.fiftyTwoWeekLow ?? null } : null;
  } catch {
    return null;
  }
}

// --- real Vercel KV storage (was a stub — now actually persists) ---
async function getNavHistory(ticker) {
  // Stored as a sorted-by-date list under one key per fund. For 86 funds at
  // one entry/day this stays small for years — no need for a heavier DB.
  const raw = await kv.get(`nav-history:${ticker}`);
  return raw || []; // shape: [{ date: "2026-09-08", nav: 26.62 }, ...]
}
async function appendNavHistory(ticker, date, nav, source) {
  const history = await getNavHistory(ticker);
  // Replace today's entry if this ticker was already checked today (avoids
  // duplicate rows if the job is ever re-run manually the same day).
  const filtered = history.filter(h => h.date !== date);
  filtered.push({ date, nav, source });
  filtered.sort((a, b) => a.date.localeCompare(b.date));
  await kv.set(`nav-history:${ticker}`, filtered);
  console.log(`[nav-check] ${ticker}: NAV $${nav} on ${date} (source: ${source}), history now ${filtered.length} days`);
}
async function saveCurrentSnapshot(ticker, row) {
  await kv.set(`nav-current:${ticker}`, row);
  console.log(`[nav-check] ${ticker}: saved current snapshot`);
}

function compute52wNavRange(history) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 365);
  const recent = history.filter(h => new Date(h.date) >= cutoff);
  if (recent.length === 0) return { high: null, low: null, daysOfHistory: 0 };
  const values = recent.map(h => h.nav);
  return { high: Math.max(...values), low: Math.min(...values), daysOfHistory: recent.length };
}

const WATCHLIST = [
  "USA", "UTG", "UTF", "DNP", "BUI", "MEGI", "GLU", "DPG", "ERH", "PEO",
  "BGR", "NXG", "EMO", "BCX", "RQI", "RNP", "RFI", "JRS", "JRI", "AWP",
  "THW", "THQ", "HQH", "HQL", "BMEZ", "BME", "PDX", "GNT", "GGN", "BCV",
  "TY", "STK", "ETO", "LGI", "BST", "BSTZ", "GDV", "NIE", "CCD", "AIO",
  "RMT", "RVT", "NCZ", "AVK", "ECAT", "NBXG", "BCAT", "ETB", "SPXX", "JCE",
  "RIV", "ETG", "AGD", "NFJ", "BTX", "ETY", "CHI", "GLQ", "ETV", "ETW",
  "ETJ", "ADX", "ASG", "AOD", "EOI", "FT", "CHW", "GAB", "EOS", "EXG",
  "CSQ", "CPZ", "NMAI", "BOE", "CLM", "CRF", "CHY", "FFA", "ACV", "QQQX",
  "BTO", "SCD", "CII", "NCV", "CGO", "STEW"
];

async function checkOneNav(ticker) {
  let nav = null, source = null, sharePrice = null, premDisc = null;

  // Try CEFdata first, per your preference for speed.
  try {
    const url = `${CEFDATA_BASE}${ticker.toLowerCase()}`;
    const html = await fetchText(url);
    const overview = parseCefDataOverview(html);
    if (overview) {
      nav = overview.nav;
      sharePrice = overview.sharePrice;
      premDisc = overview.premiumDiscountPct;
      source = "cefdata";
    }
  } catch { /* fall through to CEFConnect */ }

  // Fall back to CEFConnect if CEFdata didn't have it yet today.
  if (!nav) {
    try {
      const html = await fetchText(`${CEFCONNECT_BASE}${ticker}`);
      const overview = parseCefConnectOverview(html);
      if (overview) {
        nav = overview.nav;
        sharePrice = overview.sharePrice;
        premDisc = overview.premiumDiscountPct;
        source = "cefconnect";
      }
    } catch (err) {
      return { ticker, ok: false, error: err.message };
    }
  }

  if (!nav) return { ticker, ok: false, error: "no NAV found on either source" };

  const today = new Date().toISOString().slice(0, 10);
  await appendNavHistory(ticker, today, nav, source); // this now includes today's entry when read back

  const history = await getNavHistory(ticker);
  const navRange = compute52wNavRange(history);
  const priceRange = await fetchMarketPrice52wRange(ticker);

  const snapshot = {
    ticker,
    nav,
    sharePrice,
    premiumDiscountPct: premDisc,
    navAsOf: today,
    source,
    navHigh52w_partial: navRange.high,
    navLow52w_partial: navRange.low,
    navHistoryDays: navRange.daysOfHistory,
    priceHigh52w: priceRange?.high ?? null,
    priceLow52w: priceRange?.low ?? null
  };
  await saveCurrentSnapshot(ticker, snapshot);
  return { ticker, ok: true, ...snapshot };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function runNavCheck() {
  // Batches of 15, same reasoning as holdings-check.js — avoids looking like
  // abusive traffic to cefdata.com/CEFConnect at full 86-at-once scale.
  const batches = chunk(WATCHLIST, 15);
  const results = [];
  for (const batch of batches) {
    const batchResults = await Promise.all(batch.map(ticker => checkOneNav(ticker)));
    results.push(...batchResults);
  }
  return results;
}

export default async function handler(req, res) {
  const results = await runNavCheck();
  res.status(200).json({ ok: true, checked: results.length, results });
}
