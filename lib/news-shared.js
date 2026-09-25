// lib/news-shared.js
//
// Shared helpers used by every per-source news function (news-newsfilter.js,
// news-yahoo.js, news-google.js, news-finviz.js, news-stocktwits.js,
// news-secedgar.js, news-alphavantage.js).
//
// KEY DESIGN DECISION: each source writes to its OWN KV key
// ("news:source:<name>") instead of all sources sharing one "news:all" key.
// These functions now run independently, on different schedules, and can
// genuinely execute AT THE SAME TIME (GitHub Actions runs each workflow on
// its own trigger). If they all wrote to one shared key, two sources
// finishing at the same moment would race — whichever saves last would
// silently overwrite the other's results. Separate keys make that
// impossible: nobody's writes can clobber anybody else's. The read endpoint
// (api/news.js) combines all sources' keys together at READ time instead.
//
// RELEVANCE FILTER (2026-09-22): Google News / Yahoo / StockTwits searches
// by ticker alone pull in a lot of noise — short tickers collide with plain
// English words (USA, FT, TY, BME...) or with a completely different
// company that happens to share the same ticker on another exchange (CGO is
// also a Canadian telecom on TSX; BUI matched an unrelated Business Insider
// story). isRelevant() rejects anything that doesn't actually look like it's
// about THIS fund: either the ticker appears as a distinct word/cashtag,
// AND, for tickers known to collide with something else, the article must
// also mention a piece of the fund's real name. SEC EDGAR items are always
// trusted since they come from the filer's own official CIK, not a keyword
// search.

import { kv } from "@vercel/kv";

export const WATCHLIST = [
  "USA", "UTG", "UTF", "DNP", "BUI", "MEGI", "GLU", "DPG", "ERH", "PEO",
  "BGR", "NXG", "EMO", "BCX", "RQI", "RNP", "RFI", "JRS", "JRI", "AWP",
  "THW", "THQ", "HQH", "HQL", "BMEZ", "BME", "PDX", "GNT", "GGN", "BCV",
  "TY", "STK", "ETO", "LGI", "BST", "BSTZ", "GDV", "NIE", "CCD", "AIO",
  "RMT", "RVT", "NCZ", "AVK", "ECAT", "NBXG", "BCAT", "ETB", "SPXX", "JCE",
  "RIV", "ETG", "AGD", "NFJ", "BTX", "ETY", "CHI", "GLQ", "ETV", "ETW",
  "ETJ", "ADX", "ASG", "AOD", "EOI", "FT", "CHW", "GAB", "EOS", "EXG",
  "CSQ", "CPZ", "NMAI", "BOE", "CLM", "CRF", "CHY", "FFA", "ACV", "QQQX",
  "BTO", "SCD", "CII", "NCV", "CGO", "STEW", "HIX", "NMZ", "ACP", "TEI",
  "MMU", "NAD", "FSCO", "JQC", "JFR", "PHK", "NDMO", "PPT", "NZF", "VGM",
  "MMT", "GOF", "BPRE", "BTT", "RLTY", "NUV", "NMCO", "PML", "FPF", "JPC",
  "NVG", "NBB", "IGD", "NPFD", "ERC", "CIK", "NEA", "DHY", "VKI", "BGT",
  "DSU", "HGLB", "CEF", "IIM", "FTF", "MUC", "VGI", "PDI", "PCQ", "BDJ",
  "FRA", "EFR", "EARN", "FFC", "IGA", "GHY", "BBN", "WIW", "NAC", "NKX",
  "OIA", "BGB", "KIO", "IDE", "PFL", "KTF", "BIT", "GGT", "PTY", "EVT",
  "MMD", "EAD", "PDT", "GLO", "DLY", "DSL", "EVV", "MFM", "VVR", "IQI",
  "EMD", "MCN", "ZTR", "OPP", "MUJ", "CCIF", "BGY", "MHD", "MGF", "DFP",
  "FSSL", "EDF", "LDP", "PTA", "FTHY", "SWZ", "BLW", "NHS", "EOD", "MUA",
  "HPS", "EFT", "VMO", "IFN", "DXYZ", "MQY", "BKT", "BGX", "HFRO", "JLS",
  "VKQ", "NRK", "PFN", "PSUS", "RA", "MHF", "ARDC", "EVN", "SPE", "BGH",
  "RMM", "HTD", "EIM", "HYT", "NAN", "PFD", "ASGI", "KF", "EHI", "LEO",
  "HYI", "ECF", "PDO", "BHK", "MCI", "EIC", "AWF", "DBL", "VBF", "PCM",
  "EVF", "FLC", "EVG", "RSF", "AEF", "IAE", "WDI", "GUG", "ISD", "FAX",
  "VLT", "NPCT", "RVI", "RFMZ", "GLV", "TDF", "PSF", "VCV", "EDD", "PGP",
  "JGH", "PCN", "MYI", "DMB", "GUT", "DHF", "EOT", "GDL", "NXP", "CET",
  "HPI", "TPZ", "EMF", "RCS", "IIF", "DMA", "HIO", "CFND", "PAXS", "BTZ",
  "IGR", "DSM", "SCOP", "FINS", "BRW", "NXDT", "SPMC", "NAZ", "DMO", "GBAB",
  "GDO", "BWG", "AFB", "WIA", "TWN", "ECC", "RVII", "MXF", "GCV", "RGT",
  "GRX", "HPF", "GGZ", "PCF", "VTN", "NBH", "JHI", "NRO", "ASA", "DTF",
  "TSI", "MYN", "NMS", "MSD", "PGZ", "MIY", "PFO", "JOF", "TBLD", "JMM",
  "JHS", "PAI", "IGI", "ETX", "FMN", "WEA", "FMY", "FOF", "VPV", "EEA",
  "FUND", "GAM", "GF", "GRF", "HEQ", "HERZ", "IAF", "XFLT", "SOR", "SABA",
  "CEV", "PWRL", "BANX", "NMT", "NNY", "BOT", "PNI", "PMO", "NPV", "PIM",
  "NSLR", "BMN", "NUW", "OCCI", "PMM", "SDHY", "NMI", "BSL", "MIN", "SBI",
  "BHV", "CEE", "MPA", "MPV", "RCG", "RMMZ", "RMI", "CAF", "NCA", "NIM",
  "RFM", "MXE", "IHD"
];

export const MAX_ITEMS_PER_TICKER = 15;

// One or more distinctive keywords from each fund's REAL name. For tickers
// prone to collision (short words, or a same-ticker company on another
// exchange), an article must contain one of these keywords in addition to
// the ticker itself — the ticker match alone isn't trusted for these.
// Sourced directly from official fund names seen in real Yahoo/SEC articles
// during testing (2026-09-22). AVK and JRI are the two exceptions filled
// from general knowledge rather than a confirmed article in that test run —
// worth double-checking those two if you see odd results.
export const FUND_KEYWORDS = {
  USA:  ["Liberty All-Star Equity"],
  UTG:  ["Reaves Utility"],
  UTF:  ["Cohen & Steers Infrastructure"],
  DNP:  ["DNP Select"],
  BUI:  ["BlackRock Utility", "Utility, Infrastructure & Power", "Utility Infrastructure & Power"],
  MEGI: ["NYLIM", "CBRE Global Infrastructure Megatrends"],
  GLU:  ["Gabelli Global Utility"],
  DPG:  ["Duff & Phelps Utility"],
  ERH:  ["Allspring Utilities"],
  PEO:  ["Adams Natural Resources"],
  BGR:  ["BlackRock Energy and Resources"],
  NXG:  ["NXG NextGen Infrastructure"],
  EMO:  ["ClearBridge Energy Midstream"],
  BCX:  ["BlackRock Resources"],
  RQI:  ["Cohen & Steers Quality Income Realty"],
  RNP:  ["Cohen & Steers REIT and Preferred"],
  RFI:  ["Cohen & Steers Total Return Realty"],
  JRS:  ["Nuveen Real Estate Income"],
  JRI:  ["Nuveen Real Asset"], // best-known name, not confirmed in test data — this ticker was the most polluted, verify results
  AWP:  ["abrdn Global Premier Properties", "Aberdeen Global Premier Properties"],
  THW:  ["abrdn World Healthcare", "Aberdeen World Healthcare"],
  THQ:  ["abrdn Healthcare Opportunities", "Aberdeen Healthcare Opportunities"],
  HQH:  ["abrdn Healthcare Investors", "Tekla Healthcare Investors"],
  HQL:  ["abrdn Life Sciences", "Tekla Life Sciences"],
  BMEZ: ["BlackRock Health Sciences Term Trust"],
  BME:  ["BlackRock Health Sciences Trust"],
  PDX:  ["PIMCO Dynamic Income"],
  GNT:  ["GAMCO Natural Resources"],
  GGN:  ["GAMCO Global Gold"],
  BCV:  ["Bancroft Fund"],
  TY:   ["Tri-Continental", "Tri Continental"],
  STK:  ["Columbia Seligman Premium Technology"],
  ETO:  ["Eaton Vance Tax-Advantage", "Eaton Vance Tax-Advantaged Global Dividend Opp"],
  LGI:  ["Lazard Global Total Return"],
  BST:  ["BlackRock Science and Technology Trust"],
  BSTZ: ["BlackRock Science and Technology Trust II"],
  GDV:  ["Gabelli Dividend"],
  NIE:  ["Virtus Equity & Convertible Income", "AllianzGI Equity & Convertible"],
  CCD:  ["Calamos Dynamic Convertible"],
  AIO:  ["Virtus Artificial Intelligence"],
  RMT:  ["Royce Micro-Cap"],
  RVT:  ["Royce Small-Cap", "Royce Value Trust"],
  NCZ:  ["Virtus Convertible & Income Fund II"],
  AVK:  ["Advent Convertible", "Advent Claymore"], // best-known name, verify results
  ECAT: ["BlackRock ESG Capital Allocation"],
  NBXG: ["Neuberger Berman Next Generation Connectivity"],
  BCAT: ["BlackRock Capital Allocation Term Trust"],
  ETB:  ["Eaton Vance Tax-Managed Buy-Write Income"],
  SPXX: ["Nuveen S&P 500 Dynamic Overwrite"],
  JCE:  ["Nuveen Core Equity Alpha"],
  RIV:  ["RiverNorth Opportunities"],
  ETG:  ["Eaton Vance Tax-Advantaged Global Dividend Income"],
  AGD:  ["abrdn Global Dynamic Dividend", "Aberdeen Global Dynamic Dividend"],
  NFJ:  ["Virtus Dividend, Interest & Premium Strategy"],
  BTX:  ["BlackRock Technology and Private Equity Term Trust"],
  ETY:  ["Eaton Vance Tax-Managed Diversified Equity Income"],
  CHI:  ["Calamos Convertible Opportunities and Income"],
  GLQ:  ["Clough Global Equity"],
  ETV:  ["Eaton Vance Buy-Write Fund", "Eaton Vance Tax-Managed Buy-Write Opportunities"],
  ETW:  ["Eaton Vance Tax-Managed Global Buy-Write"],
  ETJ:  ["Eaton Vance Risk-Managed Diversified Equity Income"],
  ADX:  ["Adams Diversified Equity"],
  ASG:  ["Liberty All-Star Growth"],
  AOD:  ["abrdn Total Dynamic Dividend", "Aberdeen Total Dynamic Dividend"],
  EOI:  ["Eaton Vance Enhanced Equity Income Fund"],
  FT:   ["Franklin Universal Trust"],
  CHW:  ["Calamos Global Dynamic Income"],
  GAB:  ["Gabelli Equity Trust"],
  EOS:  ["Eaton Vance Enhanced Equity Income Fund II"],
  EXG:  ["Eaton Vance Tax-Managed Global Diversified Equity Income"],
  CSQ:  ["Calamos Strategic Total Return"],
  CPZ:  ["Calamos Long/Short Equity"],
  NMAI: ["Nuveen Multi-Asset Income"],
  BOE:  ["BlackRock Enhanced Global Dividend"],
  CLM:  ["Cornerstone Strategic Investment"],
  CRF:  ["Cornerstone Total Return"],
  CHY:  ["Calamos Convertible & High Income", "Calamos Convertible and High Income"],
  FFA:  ["First Trust Enhanced Equity Income"],
  ACV:  ["Virtus AllianzGI Diversified Income"],
  QQQX: ["Nuveen NASDAQ 100"],
  BTO:  ["John Hancock Financial Opportunities"],
  SCD:  ["LMP Capital and Income"],
  CII:  ["BlackRock Enhanced Large Cap Core"],
  NCV:  ["Virtus Convertible & Income Fund"],
  CGO:  ["Calamos Global Total Return"],
  STEW: ["SRH Total Return"]
};

export async function fetchText(url, timeoutMs = 8000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        ...extraHeaders
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1];
    if (title && link) {
      items.push({
        title: title.replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
        link: link.trim(),
        pubDate: pubDate ? new Date(pubDate).toISOString() : null,
        source: source ? source.trim() : null
      });
    }
  }
  return items;
}

// Rejects items that aren't actually about this specific fund. See the
// RELEVANCE FILTER note above for the reasoning.
export function isRelevant(item, ticker) {
  // SEC EDGAR items come straight from the fund's own official CIK — never a
  // keyword search — so they're inherently correct and always kept.
  if (item.source === "SEC EDGAR") return true;

  const text = `${item.title || ""}`;

  // StockTwits "shotgun" posts naming a pile of unrelated tickers in one
  // message aren't really about any single one of them — drop those.
  const cashtags = text.match(/\$[A-Z]{1,6}\b/g) || [];
  if (cashtags.length > 4 && !cashtags.includes(`$${ticker}`)) return false;

  const hasTickerWord = new RegExp(`(^|[^A-Za-z])${ticker}([^A-Za-z]|$)`).test(text);
  const hasCashtag = text.includes(`$${ticker}`);
  const hasTicker = hasTickerWord || hasCashtag;

  const keywords = FUND_KEYWORDS[ticker];
  if (keywords) {
    // Known-ambiguous ticker: require the fund's actual name, not just the
    // ticker letters, since the ticker alone collides with something else.
    return keywords.some(k => text.toLowerCase().includes(k.toLowerCase()));
  }

  return hasTicker;
}

// Reads this source's existing saved data, merges in freshly-fetched items
// per ticker (filtered for relevance, deduped by link, keeping the most
// recent MAX_ITEMS_PER_TICKER), and saves it back — all scoped to this ONE
// source's own key.
export async function mergeAndSaveSource(sourceName, itemsByTicker) {
  const key = `news:source:${sourceName}`;
  const existing = (await kv.get(key)) || {};
  const updated = { ...existing };
  let newItemCount = 0;

  for (const ticker of Object.keys(itemsByTicker)) {
    const rawItems = itemsByTicker[ticker];
    if (!rawItems || rawItems.length === 0) continue;
    const items = rawItems.filter(i => isRelevant(i, ticker));
    if (items.length === 0) continue;

    const existingLinks = new Set((updated[ticker]?.items || []).map(i => i.link));
    const freshItems = items.filter(i => i.link && !existingLinks.has(i.link));
    newItemCount += freshItems.length;
    const merged = [...freshItems, ...(updated[ticker]?.items || [])]
      .sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || ""))
      .slice(0, MAX_ITEMS_PER_TICKER);
    updated[ticker] = { items: merged, lastChecked: new Date().toISOString() };
  }

  await kv.set(key, updated);
  return newItemCount;
}
