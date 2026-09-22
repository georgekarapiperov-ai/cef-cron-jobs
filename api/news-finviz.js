// api/news-finviz.js  (plain Vercel Serverless Function)
//
// RUNS: every 15 minutes — slower tier since this scrapes a full HTML page
// per ticker (heavier than an RSS/JSON source, and more fragile).
//
// FIRST DRAFT — Finviz's news table structure hasn't been verified against
// real current output. If this comes back empty, capture one ticker's raw
// HTML (same debug-capture approach used for CEFConnect earlier) and adjust
// the regex to match what's actually there.

import { WATCHLIST, chunk, fetchText, mergeAndSaveSource } from "../lib/news-shared.js";

function parseFinvizNews(html) {
  const items = [];
  const tableMatch = html.match(/id="news-table"[\s\S]*?<\/table>/);
  if (!tableMatch) return items;
  const rows = [...tableMatch[0].matchAll(/<a[^>]*class="[^"]*tab-link-news[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  for (const r of rows) {
    items.push({
      link: r[1].trim(),
      title: r[2].replace(/<[^>]+>/g, "").trim(),
      pubDate: null, // Finviz's date cells sit outside the link — needs its own pass once the table structure is confirmed
      source: "Finviz"
    });
  }
  return items;
}

async function fetchOne(ticker) {
  const url = `https://finviz.com/quote.ashx?t=${encodeURIComponent(ticker)}`;
  try {
    const html = await fetchText(url);
    return parseFinvizNews(html);
  } catch (err) {
    return [];
  }
}

export default async function handler(req, res) {
  const itemsByTicker = {};
  const batches = chunk(WATCHLIST, 15);
  for (const batch of batches) {
    const results = await Promise.all(batch.map(async ticker => ({ ticker, items: await fetchOne(ticker) })));
    for (const { ticker, items } of results) itemsByTicker[ticker] = items;
  }
  const newItemCount = await mergeAndSaveSource("finviz", itemsByTicker);
  res.status(200).json({ ok: true, source: "finviz", tickersChecked: WATCHLIST.length, newItemsFound: newItemCount, checkedAt: new Date().toISOString() });
}
