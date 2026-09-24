// api/news.js  (plain Vercel Serverless Function)
//
// WHAT THIS DOES: reads all 7 sources' separately-saved data and merges it
// into one combined per-ticker view for the frontend tool.

import { kv } from "@vercel/kv";
import { isRelevant } from "../lib/news-shared.js";

const SOURCES = ["newsfilter", "yahoo", "google", "stocktwits", "finviz", "alphavantage", "secedgar"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  // ONE-TIME CLEANUP MODE: visit /api/news?cleanup=1 once to re-apply the
  // relevance filter to everything already saved in KV, stripping out old
  // junk that predates the filter. Remove this whole block (and the
  // isRelevant import above) after running it once.
  if (req.query.cleanup === "1") {
    const report = {};
    let totalRemoved = 0;
    for (const source of SOURCES) {
      const key = `news:source:${source}`;
      const data = await kv.get(key);
      if (!data) { report[source] = { removed: 0, note: "no data" }; continue; }
      const updated = {};
      let removedForSource = 0;
      for (const ticker of Object.keys(data)) {
        const entry = data[ticker];
        const items = entry?.items || [];
        const kept = items.filter(i => isRelevant(i, ticker));
        removedForSource += items.length - kept.length;
        if (kept.length > 0) updated[ticker] = { ...entry, items: kept };
      }
      await kv.set(key, updated);
      report[source] = { removed: removedForSource };
      totalRemoved += removedForSource;
    }
    return res.status(200).json({ ok: true, mode: "cleanup", totalRemoved, report });
  }

  try {
    const sourceData = await Promise.all(SOURCES.map(s => kv.get(`news:source:${s}`)));
    const combined = {};

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
        .slice(0, 20);
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
