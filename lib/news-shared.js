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
  "BTO", "SCD", "CII", "NCV", "CGO", "STEW"
];

export const MAX_ITEMS_PER_TICKER = 15;

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

// Reads this source's existing saved data, merges in freshly-fetched items
// per ticker (deduping by link, keeping the most recent MAX_ITEMS_PER_TICKER),
// and saves it back — all scoped to this ONE source's own key.
export async function mergeAndSaveSource(sourceName, itemsByTicker) {
  const key = `news:source:${sourceName}`;
  const existing = (await kv.get(key)) || {};
  const updated = { ...existing };
  let newItemCount = 0;

  for (const ticker of Object.keys(itemsByTicker)) {
    const items = itemsByTicker[ticker];
    if (!items || items.length === 0) continue;
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
