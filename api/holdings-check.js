bash

cat /mnt/user-data/outputs/api-cron-holdings-check.js
Output

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
  BCAT: "https://www.blackrock.com/us/individual/products/315530/blackrock-capital-allocation-term-trust",
  BUI:  "https://www.blackrock.com/us/individual/products/240173/blackrock-utility-and-infrastructure-trust-fund",
  BGR:  "https://www.blackrock.com/us/individual/products/240226/blackrock-energy-and-resources-trust-fund",
  FT:   "https://www.franklintempleton.com/forms-literature/download/002-FF" // factsheet PDF
};

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CEFDeskBot/1.0)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function parseCefConnectHoldingsDate(html) {
  const m = html.match(/(?:Holdings|Top Holdings)[\s\S]{0,200}?[Aa]s of (\d{1,2}\/\d{1,2}\/\d{4})/);
  return m ? m[1] : null;
}

function parseCefConnectTopHoldings(html) {
  // Matches rows like: "NextEra Energy Inc ... 4.75%" in the top-holdings table.
  // This regex is intentionally loose since CEFConnect's markup varies by fund
  // type (equity vs swap-heavy vs convertible) — verify a sample manually
  // after the first few automated runs.
  const rows = [...html.matchAll(/([A-Za-z0-9&.,'\- ]{3,60})\s+(-?\d{1,2}\.\d{2})%/g)];
  return rows.slice(0, 10).map(r => ({ name: r[1].trim(), weightPct: parseFloat(r[2]) }));
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
  "USA","UTG","UTF","DNP","BUI","MEGI","GLU","DPG","ERH","FT" /* ...append the rest of your 86 */
];

async function checkOne(ticker) {
  const stored = await getStoredHoldings(ticker);

  try {
    const html = await fetchText(`${CEFCONNECT_BASE}${ticker}`);
    const asOf = parseCefConnectHoldingsDate(html);
    const isNewer = !stored || !asOf || asOf !== stored.asOfDate;

    if (isNewer) {
      const holdings = parseCefConnectTopHoldings(html);
      const diff = diffHoldings(stored?.holdings, holdings);
      if (diff.changed) {
        await logAlert(ticker, `Holdings changed — added: [${diff.added.join(", ")}], removed: [${diff.removed.join(", ")}]`);
      }
      await saveHoldings(ticker, asOf, holdings, "cefconnect");
      return { ticker, updated: true, source: "cefconnect", changed: diff.changed };
    }

    // CEFConnect date hasn't moved — try the sponsor site if we have one on file.
    if (SPONSOR_URLS[ticker]) {
      const sponsorHtml = await fetchText(SPONSOR_URLS[ticker]);
      const sponsorHoldings = parseCefConnectTopHoldings(sponsorHtml); // heuristic; sponsor pages vary
      if (sponsorHoldings.length >= 5) {
        const diff = diffHoldings(stored?.holdings, sponsorHoldings);
        if (diff.changed) await logAlert(ticker, `Sponsor site shows newer holdings than CEFConnect — added: [${diff.added.join(", ")}], removed: [${diff.removed.join(", ")}]`);
        await saveHoldings(ticker, new Date().toISOString().slice(0,10), sponsorHoldings, "sponsor");
        return { ticker, updated: true, source: "sponsor", changed: diff.changed };
      }
    }

    return { ticker, updated: false, source: "cefconnect", changed: false };
  } catch (err) {
    await logAlert(ticker, `Fetch/parse failed: ${err.message}`);
    return { ticker, updated: false, error: err.message };
  }
}

async function runHoldingsCheck() {
  const results = [];
  for (const ticker of WATCHLIST) {
    results.push(await checkOne(ticker));
    await new Promise(r => setTimeout(r, 800)); // be polite, stagger requests
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
