// api/news-yahoo.js  (plain Vercel Serverless Function)
//
// RUNS: every 5 minutes. Per-ticker RSS, batched to be polite to Yahoo's
// servers. No API key needed.

import { WATCHLIST, chunk, fetchText, parseRssItems, mergeAndSaveSource } from "../lib/news-shared.js";

const YAHOO_RSS_BASE = "https://feeds.finance.yahoo.com/rss/2.0/headline";

async function fetchOne(ticker) {
  const url = `${YAHOO_RSS_BASE}?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
  try {
    const xml = await fetchText(url);
    return parseRssItems(xml).map(i => ({ ...i, source: i.source || "Yahoo Finance" }));
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
  const newItemCount = await mergeAndSaveSource("yahoo", itemsByTicker);
  res.status(200).json({ ok: true, source: "yahoo", tickersChecked: WATCHLIST.length, newItemsFound: newItemCount, checkedAt: new Date().toISOString() });
}
