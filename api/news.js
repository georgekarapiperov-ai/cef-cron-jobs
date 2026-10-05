// api/news.js  (plain Vercel Serverless Function)
//
// WHAT THIS DOES: reads all 7 sources' separately-saved data and merges it
// into one combined per-ticker view for the frontend tool.
//
// BANDWIDTH (2026-10-02): the answer is cached at Vercel's edge for 30 minutes,
// so repeated app refreshes are served from the cache instead of reading all
// 7 news files from KV every time (that was a big part of the KV bandwidth).

// LIVE FALLBACK (2026-10-05): if KV fails (Upstash plan limit) or has no news,
// headlines are fetched live from Yahoo Finance RSS and Google News RSS for every
// CEF (same feeds, queries and relevance filter as the news jobs), so the app keeps
// getting news.
// That answer is cached 30 min at the edge too.

import { kv } from "@vercel/kv";
import { CEF_WATCHLIST, fetchText, parseRssItems, isRelevant } from "../lib/news-shared.js";

const LIVE_MAX_AGE_DAYS = 21;
// Live headlines for one fund from Yahoo Finance RSS and Google News RSS (same feeds and
// queries as the news-yahoo / news-google jobs), filtered by the shared relevance rules.
async function liveForTicker(t, cutoff) {
  const feeds = [
    [`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(t)}&region=US&lang=en-US`, "Yahoo Finance"],
    [`https://news.google.com/rss/search?q=${encodeURIComponent(t + " stock")}&hl=en-US&gl=US&ceid=US:en`, "Google News"]
  ];
  const got = await Promise.all(feeds.map(async ([url, src]) => {
    try { return parseRssItems(await fetchText(url, 6000)).map(x => ({ ...x, source: x.source || src })); }
    catch { return []; }
  }));
  return got.flat().filter(x => isRelevant(x, t) && (!x.pubDate || Date.parse(x.pubDate) >= cutoff));
}
async function liveNews(tickers, budgetMs = 45000) {
  const t0 = Date.now(), cutoff = Date.now() - LIVE_MAX_AGE_DAYS * 86400000;
  const out = {}; let i = 0, fetched = 0;
  async function worker() {
    while (i < tickers.length && Date.now() - t0 < budgetMs) {
      const t = tickers[i++];
      const items = await liveForTicker(t, cutoff);
      if (items.length) out[t] = items;
      fetched++;
    }
  }
  await Promise.all(Array.from({ length: 20 }, worker));
  return { out, fetched };
}
function shape(combined) {
  const news = {};
  for (const ticker of Object.keys(combined)) {
    const seen = new Set(), deduped = [];
    for (const item of combined[ticker]) { if (item.link && seen.has(item.link)) continue; if (item.link) seen.add(item.link); deduped.push(item); }
    const sorted = deduped.sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || "")).slice(0, 12);
    news[ticker] = { items: sorted, hasRecentNews: sorted.some(i => i.pubDate && (Date.now() - new Date(i.pubDate).getTime()) < 24 * 60 * 60 * 1000) };
  }
  return news;
}

const SOURCES = ["newsfilter", "yahoo", "google", "stocktwits", "finviz", "alphavantage", "secedgar"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=3600");

  let kvError = null, combined = {};
  try {
    const sourceData = await Promise.all(SOURCES.map(s => kv.get(`news:source:${s}`)));
    sourceData.forEach(data => {
      if (!data) return;
      for (const ticker of Object.keys(data)) {
        const entry = data[ticker];
        if (!entry?.items?.length) continue;
        if (!combined[ticker]) combined[ticker] = [];
        combined[ticker].push(...entry.items);
      }
    });
  } catch (err) { kvError = err.message; }

  if (Object.keys(combined).length) {
    const news = shape(combined);
    return res.status(200).json({ ok: true, count: Object.keys(news).length, news });
  }
  // KV down or empty → live Yahoo headlines
  try {
    const { out, fetched } = await liveNews(CEF_WATCHLIST);
    const news = shape(out);
    return res.status(200).json({ ok: true, count: Object.keys(news).length, source: "live-yahoo+google", fetched, kvError: kvError ? kvError.slice(0, 160) : null, news });
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ ok: false, error: err.message, kvError });
  }
}
