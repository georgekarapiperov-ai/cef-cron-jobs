// api/news.js  (plain Vercel Serverless Function)
//
// WHAT THIS DOES: reads all 7 sources' separately-saved data and merges it
// into one combined per-ticker view for the frontend tool — this is where
// "many independent sources" becomes "one clean answer" for whoever's
// displaying it. Merging happens HERE, at read time, specifically because
// each source writes independently and might run at any moment; combining
// only when someone actually asks for the data sidesteps any timing issues
// between writers entirely.

import { kv } from "@vercel/kv";

const SOURCES = ["newsfilter", "yahoo", "google", "stocktwits", "finviz", "alphavantage", "secedgar"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  try {
    const sourceData = await Promise.all(SOURCES.map(s => kv.get(`news:source:${s}`)));
    const combined = {}; // ticker -> [items...]

    sourceData.forEach((data, i) => {
      if (!data) return;
      for (const ticker of Object.keys(data)) {
        const entry = data[ticker];
        if (!entry?.items?.length) continue;
        if (!combined[ticker]) combined[ticker] = [];
        combined[ticker].push(...entry.items);
      }
    });

    const news = {};
    for (const ticker of Object.keys(combined)) {
      const deduped = [];
      const seenLinks = new Set();
      for (const item of combined[ticker]) {
        if (item.link && seenLinks.has(item.link)) continue;
        if (item.link) seenLinks.add(item.link);
        deduped.push(item);
      }
      const sorted = deduped
        .sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || ""))
        .slice(0, 20); // final cap across all sources combined, for one ticker
      news[ticker] = {
        items: sorted,
        hasRecentNews: sorted.some(i => i.pubDate && (Date.now() - new Date(i.pubDate).getTime()) < 24 * 60 * 60 * 1000)
      };
    }

    res.status(200).json({ ok: true, count: Object.keys(news).length, news });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
