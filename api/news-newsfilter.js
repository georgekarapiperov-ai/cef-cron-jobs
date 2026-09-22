// api/news-newsfilter.js  (plain Vercel Serverless Function)
//
// RUNS: every 5 minutes (fastest tier — this is your cheapest, single-batch
// source, so it's worth checking most often).
//
// Needs NEWSFILTER_API_KEY set in Vercel's environment variables. If not
// set, this function does nothing harmful — it just reports 0 items found.

import { WATCHLIST, mergeAndSaveSource } from "../lib/news-shared.js";

const NEWSFILTER_API_KEY = process.env.NEWSFILTER_API_KEY;

async function fetchNewsfilterBatch(tickers) {
  if (!NEWSFILTER_API_KEY) return {};
  const perTicker = {};
  try {
    const queryString = `symbols:(${tickers.join(" OR ")})`;
    const res = await fetch(`https://api.newsfilter.io/search?token=${NEWSFILTER_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queryString, from: 0, size: 100 })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    for (const a of data?.articles || []) {
      const item = {
        title: a.title,
        link: a.sourceUrl,
        pubDate: a.publishedAt ? new Date(a.publishedAt).toISOString() : null,
        source: a.source?.name || "newsfilter.io"
      };
      for (const sym of a.symbols || []) {
        if (!tickers.includes(sym)) continue;
        if (!perTicker[sym]) perTicker[sym] = [];
        perTicker[sym].push(item);
      }
    }
  } catch (err) {
    console.warn("[news-newsfilter] request failed:", err.message);
  }
  return perTicker;
}

export default async function handler(req, res) {
  const itemsByTicker = await fetchNewsfilterBatch(WATCHLIST);
  const newItemCount = await mergeAndSaveSource("newsfilter", itemsByTicker);
  res.status(200).json({ ok: true, source: "newsfilter", tickersChecked: WATCHLIST.length, newItemsFound: newItemCount, checkedAt: new Date().toISOString() });
}
