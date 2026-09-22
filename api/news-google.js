// api/news-google.js  (plain Vercel Serverless Function)
//
// RUNS: every 5 minutes. Google News' public RSS search endpoint — no key,
// no signup, aggregates many outlets per ticker (often catches a story a
// single-source feed misses). Same easy XML format as Yahoo's feed.

import { WATCHLIST, chunk, fetchText, parseRssItems, mergeAndSaveSource } from "../lib/news-shared.js";

const GOOGLE_NEWS_RSS_BASE = "https://news.google.com/rss/search";

async function fetchOne(ticker) {
  // Searching "<TICKER> stock" narrows results toward financial news rather
  // than unrelated matches for short tickers that double as common words.
  const q = encodeURIComponent(`${ticker} stock`);
  const url = `${GOOGLE_NEWS_RSS_BASE}?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const xml = await fetchText(url);
    return parseRssItems(xml).map(i => ({ ...i, source: i.source || "Google News" }));
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
  const newItemCount = await mergeAndSaveSource("google", itemsByTicker);
  res.status(200).json({ ok: true, source: "google", tickersChecked: WATCHLIST.length, newItemsFound: newItemCount, checkedAt: new Date().toISOString() });
}
