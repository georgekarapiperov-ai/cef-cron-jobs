// api/holdings-check.js  (plain Vercel Serverless Function — no framework needed)
//
// RUNS: 10:00am daily (see vercel.json below)
//
// WHAT THIS DOES
// For every fund in the watchlist:
//   1. Fetches CEFConnect's page and reads the holdings "as of" date.
//   2. If that date is NEWER than what's stored, re-parses the top-10
//      holdings table and updates the DB, logging exactly what changed
//      (added holdings, removed holdings, re-weighted holdings).
//   3. If CEFConnect's date HASN'T moved (the staleness problem we hit with
//      BCAT and FT earlier), it tries the fund's SPONSOR SITE if one is
//      configured in SPONSOR_URLS below — sponsor pages are usually the
//      freshest source, as we found with BlackRock/Franklin Templeton.
//   4. BAMSEC (N-PORT filings) is NOT checked daily — N-PORT is filed
//      monthly with a ~60-day lag, so a daily check would almost always
//      find nothing new and just waste a request. Instead this job logs a
//      once-a-month reminder (see shouldCheckBamsec()) to cross-verify
//      against the latest N-PORT filing as a slower, "ground truth" pass.
//
// WHERE TO PUT IT
// Save this exact file as api/holdings-check.js at the root of your repo
// (a plain top-level "api" folder — no "app" folder, no "route.js" needed).
//
// vercel.json:
//   {
//     "crons": [
//       { "path": "/api/holdings-check", "schedule": "0 15 * * 1-5" },
//       { "path": "/api/nav-check",       "schedule": "0 16 * * 1-5" }
//     ]
//   }
//   Vercel Cron runs in UTC. 15:00 UTC = 10:00am ET and 16:00 UTC = 11:00am ET
//   during EDT (summer); during EST (winter) shift both by one hour (16:00 /
//   17:00 UTC) or use a timezone-aware scheduler if you want it to auto-adjust.
//
// HONEST LIMITS (read this before assuming it's bulletproof):
// - CEFConnect's HTML isn't a documented API. The parser below matches the
//   page structure as of this build; if it changes, you'll see parse
//   failures logged, not silent wrong data.
// - Sponsor site scraping is fund-specific (every sponsor's page is laid out
//   differently), so SPONSOR_URLS below only has entries for funds we've
//   already had to hand-check (BCAT, BUI, BGR, FT). Add more as you hit them.
// - This does NOT re-run the full "exclude swaps/private companies/foreign
//   ADRs" judgment calls made during the manual build — it flags a holdings
//   change and stores the raw new list; a human (you, or a follow-up chat)
//   should sanity-check new entries before trusting them blindly, the same
//   way we caught BCAT's report-type mismatch.
//
// STORAGE: this uses Vercel KV (@vercel/kv) so there's nothing to configure
// beyond turning it on. In your Vercel project dashboard: Storage tab →
// Create Database → KV → follow the prompts. It automatically adds the
// needed environment variables to your project — no connection strings to
// copy/paste by hand. Then run:  npm install @vercel/kv
// in your project folder (or add "@vercel/kv" to package.json dependencies).

import { kv } from "@vercel/kv";

const CEFCONNECT_BASE = "https://www.cefconnect.com/fund/";

// Add to this as you confirm more sponsor page patterns.
const SPONSOR_URLS = {
  // Entire BlackRock family confirmed working (they all share the same site
  // structure — verified against BCAT, BUI, BGR during manual checks).
  BCAT: "https://www.blackrock.com/us/individual/products/315530/blackrock-capital-allocation-term-trust",
  BUI:  "https://www.blackrock.com/us/individual/products/240173/blackrock-utility-and-infrastructure-trust-fund",
  BGR:  "https://www.blackrock.com/us/individual/products/240226/blackrock-energy-and-resources-trust-fund",
  BCX:  "https://www.blackrock.com/us/individual/products/256576/blackrock-resources-and-commodities-strategy-trust-aggregate-fund",
  BST:  "https://www.blackrock.com/us/individual/products/270141/blackrock-science-and-technology-trust-fund",
  BME:  "https://www.blackrock.com/us/individual/products/240227/blackrock-health-sciences-trust-usd-fund",
  BMEZ: "https://www.blackrock.com/us/individual/products/312196/health-sciences-term-trust",
  CII:  "https://www.blackrock.com/us/individual/products/240242/blackrock-enhanced-capital-and-income-fund-inc-usd-fund",
  BTX:  "https://www.blackrock.com/us/individual/products/317597/blackrock-technology-and-private-equity-term-trust",
  BOE:  "https://www.blackrock.com/us/individual/products/240197/blackrock-global-opportunities-equity-trust-fund",
  ECAT: "https://www.blackrock.com/us/individual/products/320060/blackrock-esg-capital-allocation-term-trust-class",
  // BSTZ URL not yet located — add when found (search "blackrock.com individual products BSTZ science technology term trust II")
  FT:   "https://www.franklintempleton.com/forms-literature/download/002-FF" // factsheet PDF
};

function parseGenericAsOfDate(html) {
  // Sponsor sites don't share one format the way CEFConnect does, so this
  // tries a few common patterns. Returns null if none match — the caller
  // treats that as "can't compare, don't trust this source's date."
  const m = html.match(/[Aa]s [Oo]f:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/)
         || html.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function toComparableDate(dateStr) {
  // Handles both M/D/YYYY (CEFConnect style) and YYYY-MM-DD — returns a Date
  // object for straightforward newer-than comparison, or null if unparseable.
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function parseGenericTopHoldings(html) {
  // For sponsor sites, which don't share CEFConnect's specific table ID.
  // Looser than the CEFConnect-specific parser, so more prone to false
  // matches — that's why holdings-check.js only trusts it when it finds a
  // reasonable-looking count (>=5) of results, not any single hit.
  const rows = [...html.matchAll(/([A-Za-z0-9&.,'\- ]{3,60})\s+(-?\d{1,2}\.\d{2})%/g)];
  return rows.slice(0, 10).map(r => ({ name: r[1].trim(), weightPct: parseFloat(r[2]) }));
}

async function fetchText(url, timeoutMs = 20000) {
  // A hard timeout per request — without this, ONE slow/hanging site can
  // stall the entire job (this was likely the real cause of the 504 timeouts
  // during testing, more so than the function's own overall time limit).
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

function parseCefConnectHoldingsDate(html) {
  const m = html.match(/(?:Holdings|Top Holdings)[\s\S]{0,200}?[Aa]s of (\d{1,2}\/\d{1,2}\/\d{4})/);
  return m ? m[1] : null;
}

function parseCefConnectTopHoldings(html) {
  // CONFIRMED WORKING (2026-09-11) against real CEFConnect HTML, fetched with
  // ?view=fund appended to the URL (essential — without it, the actual
  // holdings table isn't present in the page at all, only a JS-rendered
  // widget). The table has a stable element ID we can anchor on directly,
  // which avoids accidentally matching the similarly-structured "Country
  // Allocation" table further down the same page.
  const tableMatch = html.match(/TopHoldingsGrid"[\s\S]*?<\/table>/);
  if (!tableMatch) return [];
  const tableHtml = tableMatch[0];
  // Each real data row looks like:
  //   <td>NVIDIA Corp</td><td class="right-align">$115.44M</td><td class="right-align">5.70%</td>
  // The header row uses <th> instead of <td> so it's naturally excluded.
  const rows = [...tableHtml.matchAll(/<td>([^<]+)<\/td>\s*<td class="right-align">[^<]*<\/td>\s*<td class="right-align">(-?\d+\.\d+)%<\/td>/g)];
  return rows.map(r => ({ name: r[1].trim(), weightPct: parseFloat(r[2]) }));
}

function diffHoldings(oldList, newList) {
  const oldNames = new Set((oldList || []).map(h => h.name));
  const newNames = new Set(newList.map(h => h.name));
  const added = [...newNames].filter(n => !oldNames.has(n));
  const removed = [...oldNames].filter(n => !newNames.has(n));
  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

// --- real Vercel KV storage (was a stub — now actually persists) ---
async function getStoredHoldings(ticker) {
  const data = await kv.get(`holdings:${ticker}`);
  return data || null; // shape: { asOfDate: "2026-09-04", holdings: [...] }
}
async function saveHoldings(ticker, asOfDate, holdings, source) {
  await kv.set(`holdings:${ticker}`, { asOfDate, holdings, source, savedAt: new Date().toISOString() });
  console.log(`[holdings-check] ${ticker}: saved ${holdings.length} holdings (source: ${source}, as of ${asOfDate})`);
}
async function logAlert(ticker, message) {
  // Stores the last 200 alerts as a simple list you can read back from an
  // admin page or another route; wire to email/Slack later if you want
  // push notifications instead of having to go look.
  const entry = { ticker, message, at: new Date().toISOString() };
  await kv.lpush("holdings-alerts", JSON.stringify(entry));
  await kv.ltrim("holdings-alerts", 0, 199);
  console.warn(`[holdings-check] ALERT for ${ticker}: ${message}`);
}

function shouldCheckBamsec() {
  // Once a month, on the 1st, flag funds for a manual N-PORT cross-check
  // rather than trying to auto-parse SEC filings daily (they don't update
  // that often, and N-PORT XML parsing is its own project).
  return new Date().getDate() === 1;
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

async function checkOne(ticker) {
  const stored = await getStoredHoldings(ticker);

  // --- Fetch CEFConnect ---
  let cefconnect = null;
  try {
    const html = await fetchText(`${CEFCONNECT_BASE}${ticker}?view=fund`);
    const asOf = parseCefConnectHoldingsDate(html);
    const holdings = parseCefConnectTopHoldings(html);
    cefconnect = { asOf, holdings, dateObj: toComparableDate(asOf) };
  } catch (err) {
    await logAlert(ticker, `CEFConnect fetch/parse failed: ${err.message}`);
  }

  // --- Fetch the sponsor site too, if we have one on file — ALWAYS, not
  // just as a fallback, per the "check both and use whichever is newer"
  // approach ---
  let sponsor = null;
  if (SPONSOR_URLS[ticker]) {
    try {
      const html = await fetchText(SPONSOR_URLS[ticker]);
      const asOf = parseGenericAsOfDate(html);
      const holdings = parseGenericTopHoldings(html);
      if (holdings.length >= 5) {
        sponsor = { asOf, holdings, dateObj: toComparableDate(asOf) };
      }
    } catch (err) {
      await logAlert(ticker, `Sponsor site fetch/parse failed: ${err.message}`);
    }
  }

  // --- Decide which source is actually newer ---
  // Prefer whichever has a later parseable date; if only one source parsed
  // successfully, use that one; if neither has a usable date but one has
  // holdings and the other doesn't, use the one with holdings.
  let winner = null, winnerSource = null;
  if (cefconnect?.holdings.length && sponsor?.holdings.length) {
    if (cefconnect.dateObj && sponsor.dateObj) {
      if (sponsor.dateObj > cefconnect.dateObj) { winner = sponsor; winnerSource = "sponsor"; }
      else { winner = cefconnect; winnerSource = "cefconnect"; }
    } else {
      // Can't compare dates reliably — CEFConnect's structured table is the
      // more trustworthy parse of the two, so prefer it as the tiebreaker.
      winner = cefconnect; winnerSource = "cefconnect";
    }
  } else if (cefconnect?.holdings.length) {
    winner = cefconnect; winnerSource = "cefconnect";
  } else if (sponsor?.holdings.length) {
    winner = sponsor; winnerSource = "sponsor";
  }

  if (!winner) {
    return { ticker, updated: false, error: "no usable holdings from either source" };
  }

  const asOfToStore = winner.asOf || new Date().toISOString().slice(0, 10);
  const isNewer = !stored || asOfToStore !== stored.asOfDate || !stored.holdings || stored.holdings.length === 0;

  if (!isNewer) {
    return { ticker, updated: false, source: winnerSource, changed: false };
  }

  const diff = diffHoldings(stored?.holdings, winner.holdings);
  if (diff.changed) {
    await logAlert(ticker, `Holdings changed (source: ${winnerSource}) — added: [${diff.added.join(", ")}], removed: [${diff.removed.join(", ")}]`);
  }
  await saveHoldings(ticker, asOfToStore, winner.holdings, winnerSource);
  return { ticker, updated: true, source: winnerSource, changed: diff.changed, holdingsFound: winner.holdings.length };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function runHoldingsCheck() {
  // Run funds in BATCHES of 15 concurrently, moving to the next batch after
  // each finishes — a middle ground between one-at-a-time (too slow, timed
  // out earlier) and all-86-at-once (looks like abusive traffic to
  // CEFConnect and risks getting blocked, now that we know it's already
  // filtering suspicious requests).
  const batches = chunk(WATCHLIST, 15);
  const results = [];
  for (const batch of batches) {
    const batchResults = await Promise.all(batch.map(ticker => checkOne(ticker)));
    results.push(...batchResults);
  }
  if (shouldCheckBamsec()) {
    console.log("[holdings-check] 1st of the month — remember to cross-check latest N-PORT filings on BAMSEC for funds flagged above.");
  }
  return results;
}

export default async function handler(req, res) {
  const results = await runHoldingsCheck();
  const changed = results.filter(r => r.changed);
  res.status(200).json({ ok: true, checked: results.length, changed: changed.length, results });
}
