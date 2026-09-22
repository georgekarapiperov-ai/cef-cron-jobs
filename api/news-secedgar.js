// api/news-secedgar.js  (plain Vercel Serverless Function)
//
// RUNS: every 60 minutes — official filings don't drop every 5 minutes, so
// this doesn't need the fast tier's cadence.
//
// Self-service CIK lookup: fetches SEC's own master ticker→CIK file once,
// caches it, and looks up each of our 86 tickers server-side — no manual
// CIK gathering needed. Uses data.sec.gov's official submissions API.

import { WATCHLIST, chunk, fetchText, mergeAndSaveSource } from "../lib/news-shared.js";
import { kv } from "@vercel/kv";

const SEC_USER_AGENT = "CEFDeskNewsBot YOUR_REAL_EMAIL_HERE"; // <-- REPLACE THIS with your actual email before committing

async function getTickerToCikMap() {
  const cached = await kv.get("sec:ticker-cik-map");
  if (cached) return cached;
  try {
    const raw = await fetchText("https://www.sec.gov/files/company_tickers.json", 15000, { "User-Agent": SEC_USER_AGENT });
    const data = JSON.parse(raw);
    const map = {};
    for (const key in data) {
      const entry = data[key];
      if (entry.ticker) map[entry.ticker.toUpperCase()] = entry.cik_str;
    }
    await kv.set("sec:ticker-cik-map", map); // cached indefinitely — delete this key manually to force a refresh if SEC's file changes
    return map;
  } catch (err) {
    console.warn("[news-secedgar] Failed to fetch/cache SEC ticker-CIK map:", err.message);
    return {};
  }
}

async function fetchFilings(cik) {
  const padded = String(cik).padStart(10, "0");
  try {
    const raw = await fetchText(`https://data.sec.gov/submissions/CIK${padded}.json`, 8000, { "User-Agent": SEC_USER_AGENT });
    const data = JSON.parse(raw);
    const recent = data?.filings?.recent;
    if (!recent) return [];
    const items = [];
    const count = Math.min(recent.form?.length || 0, 20);
    for (let i = 0; i < count; i++) {
      const accessionNoDashes = recent.accessionNumber[i].replace(/-/g, "");
      items.push({
        title: `${recent.form[i]} filed`,
        link: `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNoDashes}/${recent.primaryDocument[i]}`,
        pubDate: recent.filingDate[i] ? new Date(recent.filingDate[i]).toISOString() : null,
        source: "SEC EDGAR"
      });
    }
    return items;
  } catch (err) {
    return [];
  }
}

export default async function handler(req, res) {
  const cikMap = await getTickerToCikMap();
  const tickersWithCik = WATCHLIST.filter(t => cikMap[t]);
  const itemsByTicker = {};
  const batches = chunk(tickersWithCik, 6); // SEC's fair-use guidance is 10 req/sec max — stay well under that
  for (const batch of batches) {
    const results = await Promise.all(batch.map(async ticker => ({ ticker, items: await fetchFilings(cikMap[ticker]) })));
    for (const { ticker, items } of results) itemsByTicker[ticker] = items;
    await new Promise(r => setTimeout(r, 300));
  }
  const newItemCount = await mergeAndSaveSource("secedgar", itemsByTicker);
  res.status(200).json({ ok: true, source: "secedgar", tickersChecked: WATCHLIST.length, tickersWithCik: tickersWithCik.length, newItemsFound: newItemCount, checkedAt: new Date().toISOString() });
}
