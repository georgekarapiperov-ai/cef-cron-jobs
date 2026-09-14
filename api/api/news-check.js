// api/news-check.js  (plain Vercel Serverless Function — no framework needed)
//
// RUNS: every ~10 minutes, triggered by GitHub Actions (see
// .github/workflows/news-check.yml) — NOT Vercel's own cron, since Vercel's
// free Hobby plan only allows once-per-day schedules. This function itself
// doesn't know or care who calls it; it just needs to be pinged periodically.
//
// WHAT THIS DOES
// For every one of the 86 CEF tickers, fetches Yahoo Finance's per-ticker RSS
// news feed (XML, lightweight, meant for polling — not scraping an HTML
// page), extracts new headlines, and merges them into ONE combined storage
// key covering all funds. Keeping everything in a single key (instead of 86
// separate ones) is what makes checking every 10 minutes stay inside
// Upstash's free tier — roughly 2 commands per run instead of ~300.
//
// SOURCES: only Yahoo Finance RSS for now. Finviz and SEC EDGAR (a more
// authoritative substitute for BAMSEC, which has no public API/RSS and would
// need fragile scraping of a JS-heavy site) are documented as follow-ups
// below — same incremental pattern as the sponsor-URL expansion in
// holdings-check.js. Adding a source that breaks shouldn't take down the
// ones that already work, which is why they're separate, addable blocks.
//
// WHERE TO PUT IT: api/news-check.js at the root of your repo, alongside
// holdings-check.js and nav-check.js.

import { kv } from "@vercel/kv";

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

const YAHOO_RSS_BASE = "https://feeds.finance.yahoo.com/rss/2.0/headline";
const MAX_ITEMS_PER_TICKER = 8; // how many recent headlines to keep per fund

async function fetchText(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36" },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseRssItems(xml) {
  // Simple regex-based RSS parsing — avoids needing an XML library
  // dependency for a fairly predictable, simple feed format. Each <item>
  // block has <title>, <link>, <pubDate>, and often <source>.
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
        source: source ? source.trim() : "Yahoo Finance"
      });
    }
  }
  return items;
}

async function fetchNewsForTicker(ticker) {
  const url = `${YAHOO_RSS_BASE}?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
  try {
    const xml = await fetchText(url);
    return parseRssItems(xml);
  } catch (err) {
    return []; // a single ticker's feed failing shouldn't break the whole run
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function runNewsCheck() {
  // One combined GET at the start, one combined SET at the end — this is
  // the whole reason storage stays cheap at this check frequency.
  const existing = (await kv.get("news:all")) || {};
  const updated = { ...existing };
  let newItemCount = 0;

  const batches = chunk(WATCHLIST, 15); // same batching approach as holdings-check.js
  for (const batch of batches) {
    const results = await Promise.all(batch.map(async ticker => {
      const items = await fetchNewsForTicker(ticker);
      return { ticker, items };
    }));

    for (const { ticker, items } of results) {
      if (items.length === 0) continue;
      const existingLinks = new Set((updated[ticker]?.items || []).map(i => i.link));
      const freshItems = items.filter(i => !existingLinks.has(i.link));
      newItemCount += freshItems.length;

      const merged = [...freshItems, ...(updated[ticker]?.items || [])]
        .sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || ""))
        .slice(0, MAX_ITEMS_PER_TICKER);

      updated[ticker] = {
        items: merged,
        lastChecked: new Date().toISOString(),
        hasRecentNews: merged.some(i => i.pubDate && (Date.now() - new Date(i.pubDate).getTime()) < 24 * 60 * 60 * 1000)
      };
    }
  }

  await kv.set("news:all", updated);
  return { tickersChecked: WATCHLIST.length, newItemsFound: newItemCount };
}

export default async function handler(req, res) {
  const result = await runNewsCheck();
  res.status(200).json({ ok: true, ...result, checkedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// FOLLOW-UP SOURCES (not built yet — add incrementally, same pattern as
// SPONSOR_URLS in holdings-check.js):
//
// SEC EDGAR (a solid substitute for BAMSEC, which has no public API and
// would need fragile scraping): each company has a stable Atom feed at
//   https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<CIK>&type=8-K&output=atom
// but needs each fund's CIK number looked up first — 86 individual lookups,
// same shape of work as the sponsor-URL expansion.
//
// Finviz: has a news table on its quote page (finviz.com/quote.ashx?t=TICKER)
// but it's HTML, not RSS/XML — would need its own parser verified against
// real output, the same way CEFConnect's holdings table needed one.
// ---------------------------------------------------------------------------
