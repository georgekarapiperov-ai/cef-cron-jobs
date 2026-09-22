// api/news-alphavantage.js  (plain Vercel Serverless Function)
//
// RUNS: every 60 minutes. Alpha Vantage's free tier allows only 25
// requests/DAY total — but its News & Sentiment endpoint accepts a
// comma-separated list of tickers in ONE request, so checking all 86 funds
// costs just 1 of those 25 daily requests. Running hourly (24 times/day)
// stays comfortably inside that budget with room to spare.
//
// Needs ALPHAVANTAGE_API_KEY set in Vercel's environment variables.

import { WATCHLIST, mergeAndSaveSource } from "../lib/news-shared.js";

const ALPHAVANTAGE_API_KEY = process.env.ALPHAVANTAGE_API_KEY;

async function fetchAlphaVantageBatch(tickers) {
  if (!ALPHAVANTAGE_API_KEY) return {};
  const perTicker = {};
  try {
    // Alpha Vantage documents a practical limit on how many tickers one
    // request can carry — chunking at 50 is a safe margin under that.
    const tickerGroups = [];
    for (let i = 0; i < tickers.length; i += 50) tickerGroups.push(tickers.slice(i, i + 50));

    for (const group of tickerGroups) {
      const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${group.join(",")}&apikey=${ALPHAVANTAGE_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const feed = data?.feed || [];
      for (const a of feed) {
        const item = {
          title: a.title,
          link: a.url,
          pubDate: a.time_published ? new Date(
            a.time_published.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6")
          ).toISOString() : null,
          source: a.source || "Alpha Vantage"
        };
        for (const t of a.ticker_sentiment || []) {
          if (!tickers.includes(t.ticker)) continue;
          if (!perTicker[t.ticker]) perTicker[t.ticker] = [];
          perTicker[t.ticker].push(item);
        }
      }
    }
  } catch (err) {
    console.warn("[news-alphavantage] request failed:", err.message);
  }
  return perTicker;
}

export default async function handler(req, res) {
  const itemsByTicker = await fetchAlphaVantageBatch(WATCHLIST);
  const newItemCount = await mergeAndSaveSource("alphavantage", itemsByTicker);
  res.status(200).json({ ok: true, source: "alphavantage", tickersChecked: WATCHLIST.length, newItemsFound: newItemCount, checkedAt: new Date().toISOString() });
}
