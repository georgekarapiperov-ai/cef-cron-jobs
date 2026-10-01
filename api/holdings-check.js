// api/holdings-check.js  (plain Vercel Serverless Function — no framework needed)
//
// WHAT THIS DOES (rewritten 2026-10-01)
// For every fund in the 353-fund watchlist:
//   1. Reads CEFConnect's top-10 holdings table and its "as of" date
//      (and the sponsor site for the funds listed in SPONSOR_URLS).
//   2. Turns each holding NAME into a TICKER via Yahoo's search, cached in KV
//      ("holding-tickers") so each name is only looked up once.
//   3. Flags swaps, bonds, notes, cash, futures etc. as "non-equity" (they
//      can't be live-priced, so the app excludes them).
//   4. Saves holdings:TICKER = { asOfDate, holdings:[{name, w, t, kind}], source, savedAt }.
// The app shows a "Holdings update — review" badge when this differs from the
// list it uses, and nothing changes until George approves it in the app.
//
// RUNS: GitHub Actions workflow "Holdings Check" calls ?group=1..4.
// With no ?group (e.g. the Vercel cron), it processes the next group in rotation.
//
// STORAGE: Vercel KV (@vercel/kv).

import { kv } from "@vercel/kv";

const CEFCONNECT_BASE = "https://www.cefconnect.com/fund/";
const YAHOO_SEARCH = "https://query1.finance.yahoo.com/v1/finance/search";
const MAX_NEW_LOOKUPS_PER_RUN = 400;   // keeps each run well inside the time limit; leftovers are looked up next run

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

async function fetchText(url, timeoutMs = 20000, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.google.com/"
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

// "6/30/2026" or "2026-06-30" → "2026-06-30"
function toISO(d) {
  if (!d) return null;
  let m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = String(d).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

// Things that can't be live-priced as a stock: swaps, bonds/notes, cash, futures, options, loans, FX,
// private placements, convertibles ("Uber Technolo 0.875 12/28"), and accounting lines.
const NON_EQUITY = /\birs\b|\bswaps?\b|sofr|libor|\bccp|\bcash\b|money market|\brepo\b|repurchase|\btreasur(y|ies)\b|\bnotes?\b|\bbonds?\b|\bdebentures?\b|\bloans?\b|\bfutures?\b|\boptions?\b|\bforwards?\b|\bfx\b|\bcurrency\b|\d+(\.\d+)?\s?%|\b(19|20)\d\d\b|\bdue\b|\bprvt\b|private|\bpref eq\b|\bseries [a-z]-?\d*\b|\d+\.\d+\s+\d{1,2}\/\d{2}\b|\b\d{1,2}\/\d{2}\b|convertible|\bprf\b|perpetual|other (liability|assets)|clearing corp|merger sub|bidco/i;
const US_EXCHANGES = new Set(["NMS", "NYQ", "NGM", "NCM", "ASE", "PCX", "BTS", "NAS", "NYS", "CBO"]);
const LOOKUP_VERSION = 2;   // bump to re-try earlier misses / foreign picks with an improved method

// Abbreviated sector-SPDR names as they appear in CEFConnect tables
const ETF_ALIASES = [
  [/engy.*sel.*sect|energy select sector/i, "XLE"], [/util.*sel.*sect|utilities select sector/i, "XLU"],
  [/fin.*sel.*sect|financial select sector/i, "XLF"], [/tech.*sel.*sect|technology select sector/i, "XLK"],
  [/(hlth|health).*sel.*sect/i, "XLV"], [/(indl|industrial).*sel.*sect/i, "XLI"], [/(matls|materials).*sel.*sect/i, "XLB"],
  [/(cons|consumer).*(stap|staples).*sel/i, "XLP"], [/(cons|consumer).*(disc|discretionary).*sel/i, "XLY"],
  [/real.*estate.*sel.*sect/i, "XLRE"], [/comm.*(svcs|services).*sel/i, "XLC"]
];

// "Meta Platforms Inc Class A" → "Meta Platforms Inc"; "Sanofi SA ADR" → "Sanofi SA"
function cleanName(name) {
  return name.replace(/®|™/g, " ")
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(class|cl)\s+[a-z]\b/gi, " ")
    .replace(/\bordinary shares?\b|\bord shs?\b|\bregistered shares?\b|\breg shs?\b|\bshs\b|\bpartnership units?\b|\bunits?\b|\bcommon stock\b|\bnon[- ]?vtg\b|\bnon[- ]?voting\b|\bsponsored\b|\bunsponsored\b|\badrs?\b|\bads\b|\bgdrs?\b|\bnew\b|\bact\.?\b|\bregistered\b/gi, " ")
    .replace(/(^|\s)-[a-z]-(?=\s|$)/gi, " ")
    .replace(/[-–]\s*$/, "").replace(/\s+/g, " ").trim();
}
const LEGAL = /\b(inc|corp|corporation|co|company|ltd|limited|plc|sa|ag|nv|se|spa|s\.a\.|n\.v\.|holdings?|group|lp|llc|oyj|asa|ab|kk)\b\.?/gi;

async function yahooSearch(q) {
  const url = `${YAHOO_SEARCH}?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`;
  const j = JSON.parse(await fetchText(url, 8000, "application/json"));
  return (j.quotes || []).filter(x => x.symbol && (x.quoteType === "EQUITY" || x.quoteType === "ETF"));
}

async function yahooLookup(name) {
  const at = new Date().toISOString();
  for (const [re, t] of ETF_ALIASES) if (re.test(name)) return { t, ex: "PCX", foreign: false, v: LOOKUP_VERSION, at };
  const base = cleanName(name);
  const noLegal = base.replace(LEGAL, " ").replace(/\s+/g, " ").trim();
  const firstTwo = noLegal.split(" ").slice(0, 2).join(" ");
  const tries = [...new Set([base, noLegal, firstTwo].filter(q => q && q.length >= 3))];
  let firstHit = null;
  for (const q of tries) {
    const quotes = await yahooSearch(q);
    const us = quotes.find(x => US_EXCHANGES.has(x.exchange));
    if (us) return { t: us.symbol, ex: us.exchange, foreign: false, yname: us.shortname || us.longname || null, query: q, v: LOOKUP_VERSION, at };
    if (!firstHit && quotes[0]) firstHit = { q, x: quotes[0] };
  }
  if (firstHit) return { t: firstHit.x.symbol, ex: firstHit.x.exchange || null, foreign: true, yname: firstHit.x.shortname || null, query: firstHit.q, v: LOOKUP_VERSION, at };
  return { t: null, v: LOOKUP_VERSION, at };
}

// Resolves names → tickers, using and updating the shared KV cache.
async function resolveNames(names) {
  const cache = (await kv.get("holding-tickers")) || {};
  const redo = n => {
    const c = cache[n]; if (!c) return true;
    if (c.v !== LOOKUP_VERSION && (!c.t || c.foreign)) return true;                    // retry with the improved method once
    return !c.t && (Date.now() - Date.parse(c.at || 0)) > 14 * 86400000;              // retry misses after 14 days
  };
  const todo = [...new Set(names)].filter(n => !NON_EQUITY.test(n) && redo(n)).slice(0, MAX_NEW_LOOKUPS_PER_RUN);
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const n = todo[i++];
      try { cache[n] = await yahooLookup(n); } catch { /* try again next run */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, todo.length) }, worker));
  if (todo.length) await kv.set("holding-tickers", cache);
  return { cache, looked: todo.length };
}

function diffHoldings(oldList, newList) {
  const oldNames = new Set((oldList || []).map(h => h.name));
  const newNames = new Set((newList || []).map(h => h.name));
  const added = [...newNames].filter(n => !oldNames.has(n));
  const removed = [...oldNames].filter(n => !newNames.has(n));
  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

async function logAlert(ticker, message) {
  const entry = { ticker, message, at: new Date().toISOString() };
  await kv.lpush("holdings-alerts", JSON.stringify(entry));
  await kv.ltrim("holdings-alerts", 0, 199);
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

function getGroup(groupNum) {
  const idx = parseInt(groupNum, 10) - 1;
  return WATCHLIST.filter((_, i) => i % 4 === idx);
}

// Reads the newest top-10 list for one fund (CEFConnect, or the sponsor site when newer).
async function fetchLatest(ticker) {
  let cefconnect = null, sponsor = null;
  try {
    const html = await fetchText(`${CEFCONNECT_BASE}${ticker}?view=fund`);
    const holdings = parseCefConnectTopHoldings(html);
    if (holdings.length) cefconnect = { asOf: toISO(parseCefConnectHoldingsDate(html)), holdings };
  } catch (err) {
    await logAlert(ticker, `CEFConnect fetch/parse failed: ${err.message}`);
  }
  if (SPONSOR_URLS[ticker]) {
    try {
      const html = await fetchText(SPONSOR_URLS[ticker]);
      const holdings = parseGenericTopHoldings(html);
      if (holdings.length >= 5) sponsor = { asOf: toISO(parseGenericAsOfDate(html)), holdings };
    } catch (err) {
      await logAlert(ticker, `Sponsor site fetch/parse failed: ${err.message}`);
    }
  }
  if (cefconnect && sponsor && sponsor.asOf && cefconnect.asOf && sponsor.asOf > cefconnect.asOf) return { ...sponsor, source: "sponsor" };
  if (cefconnect) return { ...cefconnect, source: "cefconnect" };
  if (sponsor) return { ...sponsor, source: "sponsor" };
  return null;
}

async function runGroup(tickers) {
  // 1) fetch the lists, 15 funds at a time (gentle on CEFConnect)
  const latest = {};
  for (let i = 0; i < tickers.length; i += 15) {
    const batch = tickers.slice(i, i + 15);
    const got = await Promise.all(batch.map(t => fetchLatest(t).catch(() => null)));
    batch.forEach((t, k) => { latest[t] = got[k]; });
  }
  // 2) names → tickers (cached)
  const allNames = Object.values(latest).flatMap(x => x ? x.holdings.map(h => h.name) : []);
  const { cache, looked } = await resolveNames(allNames);
  // 3) save
  const results = [];
  for (const t of tickers) {
    const x = latest[t];
    if (!x) { results.push({ ticker: t, updated: false, error: "no usable holdings" }); continue; }
    const holdings = x.holdings.map(h => {
      const nonEq = NON_EQUITY.test(h.name);
      const hit = nonEq ? null : cache[h.name];
      return { name: h.name, w: h.weightPct, t: hit ? hit.t : null, foreign: hit ? !!hit.foreign : false, kind: nonEq ? "non-equity" : (hit && hit.t ? "equity" : "unresolved") };
    });
    const stored = await kv.get(`holdings:${t}`);
    const asOf = x.asOf || stored?.asOfDate || new Date().toISOString().slice(0, 10);
    const needsTickers = holdings.some(h => h.kind === "unresolved");
    const sameAsStored = stored && stored.asOfDate === asOf && JSON.stringify(stored.holdings) === JSON.stringify(holdings);
    if (!sameAsStored) {
      const diff = diffHoldings(stored?.holdings, holdings);
      if (diff.changed && stored) await logAlert(t, `Holdings changed (${x.source}) — added: [${diff.added.join(", ")}], removed: [${diff.removed.join(", ")}]`);
      await kv.set(`holdings:${t}`, { asOfDate: asOf, holdings, source: x.source, savedAt: new Date().toISOString() });
    }
    results.push({ ticker: t, updated: !sameAsStored, asOf, source: x.source, holdings: holdings.length, unresolved: holdings.filter(h => h.kind === "unresolved").length, needsTickers });
  }
  return { results, looked };
}

export default async function handler(req, res) {
  let group = parseInt(req.query.group, 10);
  if (!(group >= 1 && group <= 4)) {           // no group: take the next one in rotation
    const last = (await kv.get("holdings-rotation")) || 0;
    group = (last % 4) + 1;
    await kv.set("holdings-rotation", group);
  }
  const { results, looked } = await runGroup(getGroup(group));
  res.status(200).json({
    ok: true, group, checked: results.length,
    updated: results.filter(r => r.updated).length,
    failed: results.filter(r => r.error).length,
    newTickerLookups: looked,
    results
  });
}
