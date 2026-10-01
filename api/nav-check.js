// api/nav-check.js  (plain Vercel Serverless Function — no framework needed)
//
// RUNS: via 4 separate GitHub Actions schedules, each calling this same
// endpoint with a different ?group=1..4 query param (added 2026-09-25 when
// the watchlist grew from 86 to 353 funds — one run covering all of them
// risked exceeding the function's time limit, so it's now split into 4
// batches of ~88 funds each, staggered through the day). If no ?group is
// given, it defaults to running ALL funds (useful for manual full re-runs
// like the FT stale-cache fix earlier).
//
// WHAT THIS DOES
//   1. Fetches current NAV for every fund in the selected group — tries
//      CEFdata.com FIRST, falls back to CEFConnect if CEFdata doesn't have
//      it yet.
//   2. Appends today's NAV to a running history table (one row per fund per day).
//   3. Recomputes each fund's 52-week NAV high/low from that history.
//   4. Grabs the MARKET-PRICE 52-week high/low from Yahoo's chart endpoint.
//   5. NEW (2026-09-25): fetches CEFConnect's "Category:" field for each
//      fund and buckets it into a simple assetClass tag (Bond, Preferred,
//      Convertible, Equity, or Mixed) — this is the "do they own bonds or
//      preferred stock" signal, without needing a full per-sponsor holdings
//      scraper for every new fund.
//
// THE HONEST PART, READ BEFORE TRUSTING THE NAV 52W NUMBERS:
// Nobody publishes "52-week NAV high/low" for closed-end funds as a ready
// field. NAV history has to be built from daily snapshots — it becomes a
// genuine trailing-365-day range only after ~12 months. Fields are named
// navHigh52w_partial / navLow52w_partial for this reason.
//
// STALE-CACHE RETRY GUARD (added 2026-09-25): cefdata.com can serve a page
// that parses successfully but contains an OLD cached NAV value. If the
// fetched value exactly matches what was already saved from a PRIOR day,
// wait a few seconds and try that one fund again before trusting it.
//
// REAL NAV DATES (2026-10-01): navAsOf used to be "the day this job ran"
// (UTC), so every fund looked like it had today's NAV even when CEFConnect
// still had yesterday's. Now NAV, price, discount AND the NAV date come from
// CEFConnect's own daily-pricing feed (one request returns every fund), the
// history is saved under the REAL NAV date, and a NAV is never replaced by
// an older one. checkedAt records when the job ran.
//
// STORAGE: uses Vercel KV — npm install @vercel/kv

import { kv } from "@vercel/kv";

const CEFDATA_BASE = "https://cefdata.com/funds/";
const CEFCONNECT_BASE = "https://www.cefconnect.com/fund/";
const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";

async function fetchText(url, timeoutMs = 20000) {
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
  if (/too many requests/i.test(html) || /temporary rate limit/i.test(html)) {
    return null;
  }
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

// Extracts CEFConnect's "Category:" text and buckets it into a simple
// assetClass tag. Loose regex on purpose — CEFConnect's basics table cell
// structure isn't documented, so this matches whatever text sits between
// "Category:" and the following "Ticker:" label, tags and all, then strips
// tags before classifying.
function parseAssetClass(html) {
  const m = html.match(/Category:[\s\S]{0,20}?([\s\S]{0,200}?)Ticker:/);
  if (!m) return { categoryRaw: null, assetClass: null };
  const raw = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const c = raw.toLowerCase();
  let assetClass = "Mixed";
  if (/preferred/.test(c)) assetClass = "Preferred";
  else if (/convertible/.test(c)) assetClass = "Convertible";
  else if (/fixed income|bond|municipal|loan|high yield|government|mortgage/.test(c)) assetClass = "Bond";
  else if (/equity|growth|utility|real estate|reit|healthcare|technology|energy|commodit|world|global/.test(c)) assetClass = "Equity";
  return { categoryRaw: raw || null, assetClass };
}

async function fetchMarketPrice52wRange(ticker) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const yahooTicker = ticker.replace(/\./g, "-");
    const res = await fetch(`${YAHOO_CHART_BASE}${encodeURIComponent(yahooTicker)}?range=1y&interval=1d`, {
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

// ---- CEFConnect daily-pricing feed: every fund's NAV, price, discount and NAV date in ONE request ----
const CEFCONNECT_DAILY = "https://www.cefconnect.com/api/v3/DailyPricing?props=Ticker,NAV,LastUpdated,Price,Discount";
let bulkPromise = null;
function getBulkPricing() {
  if (!bulkPromise) {
    bulkPromise = (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        const res = await fetch(CEFCONNECT_DAILY, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://www.cefconnect.com/"
          },
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = await res.json();
        const map = {};
        for (const r of rows || []) {
          if (!r || !r.Ticker || typeof r.NAV !== "number") continue;
          map[String(r.Ticker).toUpperCase()] = {
            nav: +r.NAV.toFixed(4),
            sharePrice: typeof r.Price === "number" ? +r.Price.toFixed(4) : null,
            premDisc: typeof r.Discount === "number" ? r.Discount : null,
            date: typeof r.LastUpdated === "string" ? r.LastUpdated.slice(0, 10) : null
          };
        }
        return map;
      } catch (e) {
        console.error("[nav-check] CEFConnect daily-pricing feed failed:", e.message);
        return {};
      }
    })();
  }
  return bulkPromise;
}
// "As of 9/30/2026" on a CEFConnect fund page → "2026-09-30"
function parseAsOfDate(html) {
  const m = html.match(/As of\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

async function getNavHistory(ticker) {
  const raw = await kv.get(`nav-history:${ticker}`);
  return raw || [];
}
async function appendNavHistory(ticker, date, nav, source) {
  const history = await getNavHistory(ticker);
  const filtered = history.filter(h => h.date !== date);
  filtered.push({ date, nav, source });
  filtered.sort((a, b) => a.date.localeCompare(b.date));
  await kv.set(`nav-history:${ticker}`, filtered);
}
async function saveCurrentSnapshot(ticker, row) {
  await kv.set(`nav-current:${ticker}`, row);
}

function compute52wNavRange(history) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 365);
  const recent = history.filter(h => new Date(h.date) >= cutoff);
  if (recent.length === 0) return { high: null, low: null, daysOfHistory: 0 };
  const values = recent.map(h => h.nav);
  return { high: Math.max(...values), low: Math.min(...values), daysOfHistory: recent.length };
}

// Full 353-fund watchlist. Split into 4 groups below for scheduled batch runs.
const WATCHLIST = [
  "USA", "UTG", "UTF", "DNP", "BUI", "MEGI", "GLU", "DPG", "ERH", "PEO",
  "BGR", "NXG", "EMO", "BCX", "RQI", "RNP", "RFI", "JRS", "JRI", "AWP",
  "THW", "THQ", "HQH", "HQL", "BMEZ", "BME", "PDX", "GNT", "GGN", "BCV",
  "TY", "STK", "ETO", "LGI", "BST", "BSTZ", "GDV", "NIE", "CCD", "AIO",
  "RMT", "RVT", "NCZ", "AVK", "ECAT", "NBXG", "BCAT", "ETB", "SPXX", "JCE",
  "RIV", "ETG", "AGD", "NFJ", "BTX", "ETY", "CHI", "GLQ", "ETV", "ETW",
  "ETJ", "ADX", "ASG", "AOD", "EOI", "FT", "CHW", "GAB", "EOS", "EXG",
  "CSQ", "CPZ", "NMAI", "BOE", "CLM", "CRF", "CHY", "FFA", "ACV", "QQQX",
  "BTO", "SCD", "CII", "NCV", "CGO", "STEW",
  "HIX", "NMZ", "ACP", "TEI", "MMU", "NAD", "FSCO", "JQC", "JFR", "PHK",
  "NDMO", "PPT", "NZF", "VGM", "MMT", "GOF", "BPRE", "BTT", "RLTY", "NUV",
  "NMCO", "PML", "FPF", "JPC", "NVG", "NBB", "IGD", "NPFD", "ERC", "CIK",
  "NEA", "DHY", "VKI", "BGT", "DSU", "HGLB", "CEF", "IIM", "FTF", "MUC",
  "VGI", "PDI", "PCQ", "BDJ", "FRA", "EFR", "EARN", "FFC", "IGA", "GHY",
  "BBN", "WIW", "NAC", "NKX", "OIA", "BGB", "KIO", "IDE", "PFL", "KTF",
  "BIT", "GGT", "PTY", "EVT", "MMD", "EAD", "PDT", "GLO", "DLY", "DSL",
  "EVV", "MFM", "VVR", "IQI", "EMD", "MCN", "ZTR", "OPP", "MUJ", "CCIF",
  "BGY", "MHD", "MGF", "DFP", "FSSL", "EDF", "LDP", "PTA", "FTHY", "SWZ",
  "BLW", "NHS", "EOD", "MUA", "HPS", "EFT", "VMO", "IFN", "DXYZ", "MQY",
  "BKT", "BGX", "HFRO", "JLS", "VKQ", "NRK", "PFN", "PSUS", "RA", "MHF",
  "ARDC", "EVN", "SPE", "BGH", "RMM", "HTD", "EIM", "HYT", "NAN", "PFD",
  "ASGI", "KF", "EHI", "LEO", "HYI", "ECF", "PDO", "BHK", "MCI", "EIC",
  "AWF", "DBL", "VBF", "PCM", "EVF", "FLC", "EVG", "RSF", "AEF", "IAE",
  "WDI", "GUG", "ISD", "FAX", "VLT", "NPCT", "RVI", "RFMZ", "GLV", "TDF",
  "PSF", "VCV", "EDD", "PGP", "JGH", "PCN", "MYI", "DMB", "GUT", "DHF",
  "EOT", "GDL", "NXP", "CET", "HPI", "TPZ", "EMF", "RCS", "IIF", "DMA",
  "HIO", "CFND", "PAXS", "BTZ", "IGR", "DSM", "SCOP", "FINS", "BRW", "NXDT",
  "SPMC", "NAZ", "DMO", "GBAB", "GDO", "BWG", "AFB", "WIA", "TWN", "ECC",
  "RVII", "MXF", "GCV", "RGT", "GRX", "HPF", "GGZ", "PCF", "VTN", "NBH",
  "JHI", "NRO", "ASA", "DTF", "TSI", "MYN", "NMS", "MSD", "PGZ", "MIY",
  "PFO", "JOF", "TBLD", "JMM", "JHS", "PAI", "IGI", "ETX", "FMN", "WEA",
  "FMY", "FOF", "VPV", "EEA", "FUND", "GAM", "GF", "GRF", "HEQ", "HERZ",
  "IAF", "XFLT", "SOR", "SABA", "CEV", "PWRL", "BANX", "NMT", "NNY", "BOT",
  "PNI", "PMO", "NPV", "PIM", "NSLR", "BMN", "NUW", "OCCI", "PMM", "SDHY",
  "NMI", "BSL", "MIN", "SBI", "BHV", "CEE", "MPA", "MPV", "RCG", "RMMZ",
  "RMI", "CAF", "NCA", "NIM", "RFM", "MXE", "IHD"
];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Splits WATCHLIST into 4 roughly-equal groups by taking every 4th ticker
// (interleaved rather than sliced in blocks, so each group gets a similar
// mix of "usually fast" and "usually slow" sources rather than one group
// getting unlucky).
function getGroup(groupNum) {
  if (!groupNum) return WATCHLIST; // no group specified = run everything (manual full re-run)
  const idx = parseInt(groupNum, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx > 3) return WATCHLIST;
  return WATCHLIST.filter((_, i) => i % 4 === idx);
}

async function fetchNavOnce(ticker, needAssetClass) {
  let nav = null, source = null, sharePrice = null, premDisc = null, date = null;
  let categoryRaw = null, assetClass = null;

  // 1) CEFConnect daily-pricing feed (fast, includes the real NAV date)
  const bulk = (await getBulkPricing())[ticker];
  if (bulk && bulk.nav) {
    ({ nav, sharePrice, premDisc, date } = bulk);
    source = "cefconnect";
  }

  // 2) CEFConnect fund page — fallback for NAV, and the only place with the Category field
  if (!nav || needAssetClass) {
    try {
      const html = await fetchText(`${CEFCONNECT_BASE}${ticker}`);
      if (!nav) {
        const overview = parseCefConnectOverview(html);
        if (overview) {
          nav = overview.nav; sharePrice = overview.sharePrice; premDisc = overview.premiumDiscountPct;
          date = parseAsOfDate(html); source = "cefconnect-page";
        }
      }
      const ac = parseAssetClass(html);
      categoryRaw = ac.categoryRaw; assetClass = ac.assetClass;
    } catch { /* not fatal */ }
  }

  // 3) CEFdata as a last resort (its data also carries a date)
  if (!nav) {
    try {
      const html = await fetchText(`${CEFDATA_BASE}${ticker.toLowerCase()}`);
      const overview = parseCefDataOverview(html);
      if (overview) {
        nav = overview.nav; sharePrice = overview.sharePrice; premDisc = overview.premiumDiscountPct;
        date = overview.date; source = "cefdata";
      }
    } catch { /* nothing else to try */ }
  }

  if (!nav) return null;
  return { nav, sharePrice, premDisc, source, date, categoryRaw, assetClass };
}

async function checkOneNav(ticker) {
  const previous = await kv.get(`nav-current:${ticker}`);
  const checkedAt = new Date().toISOString();

  const result = await fetchNavOnce(ticker, !previous?.assetClass);
  if (!result) return { ticker, ok: false, error: "no NAV found on any source" };

  const { nav, sharePrice, premDisc, source, categoryRaw, assetClass } = result;
  // The NAV's own date. If a source gave none, keep the previous date when the NAV is unchanged.
  let navAsOf = result.date || (previous?.checkedAt && previous.nav === nav ? previous.navAsOf : null) || checkedAt.slice(0, 10);

  // Never replace a newer NAV with an older one (e.g. a source that hasn't updated yet).
  // (Only trusts dates written by this version — older rows were labelled with the run date.)
  if (previous?.checkedAt && previous?.navAsOf && navAsOf < previous.navAsOf) {
    await kv.set(`nav-current:${ticker}`, { ...previous, checkedAt });
    return { ticker, ok: true, kept: "previous (source had an older NAV)", ...previous, checkedAt };
  }

  await appendNavHistory(ticker, navAsOf, nav, source);
  const history = await getNavHistory(ticker);
  const navRange = compute52wNavRange(history);
  const priceRange = await fetchMarketPrice52wRange(ticker);

  const snapshot = {
    ticker,
    nav,
    sharePrice,
    premiumDiscountPct: premDisc,
    navAsOf,
    checkedAt,
    source,
    navHigh52w_partial: navRange.high,
    navLow52w_partial: navRange.low,
    navHistoryDays: navRange.daysOfHistory,
    priceHigh52w: priceRange?.high ?? null,
    priceLow52w: priceRange?.low ?? null,
    assetClass: assetClass ?? previous?.assetClass ?? null,
    categoryRaw: categoryRaw ?? previous?.categoryRaw ?? null
  };
  await saveCurrentSnapshot(ticker, snapshot);
  return { ticker, ok: true, ...snapshot };
}

async function runNavCheck(groupTickers) {
  const batches = chunk(groupTickers, 6);
  const results = [];
  for (const batch of batches) {
    const batchResults = await Promise.all(batch.map(ticker => checkOneNav(ticker)));
    results.push(...batchResults);
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

export default async function handler(req, res) {
  const groupTickers = getGroup(req.query.group);
  const results = await runNavCheck(groupTickers);
  const bulkCount = Object.keys(await getBulkPricing()).length;
  const failed = results.filter(r => !r.ok).length;
  const dates = {};
  results.forEach(r => { if (r.navAsOf) dates[r.navAsOf] = (dates[r.navAsOf] || 0) + 1; });
  res.status(200).json({ ok: true, group: req.query.group || "all", checked: results.length, failed, cefconnectFeedFunds: bulkCount, navDates: dates, results });
}
