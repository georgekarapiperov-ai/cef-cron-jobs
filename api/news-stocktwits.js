// api/news-stocktwits.js  (plain Vercel Serverless Function)
//
// RUNS: every 5 minutes. StockTwits' public per-symbol stream — often
// surfaces market chatter faster than formal news outlets.
//
// FIRST DRAFT CAVEAT: StockTwits has tightened API access over the years;
// this unauthenticated endpoint may work, may be rate-limited, or may
// require a developer account by the time you test this. Same "build it,
// check real output, adjust" pattern as every other HTML/undocumented
// source in this project — if this comes back empty or erroring, that's
// the likely reason, not a bug in the merge/storage logic around it.

import { WATCHLIST, chunk, fetchText, mergeAndSaveSource } from "../lib/news-shared.js";

async function fetchOne(ticker) {
  const url = `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(ticker)}.json`;
  try {
    const raw = await fetchText(url);
    const data = JSON.parse(raw);
    const messages = data?.messages || [];
    return messages.slice(0, 20).map(m => ({
      title: m.body,
      link: `https://stocktwits.com/symbol/${ticker}/message/${m.id}`,
      pubDate: m.created_at ? new Date(m.created_at).toISOString() : null,
      source: "StockTwits"
    }));
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
  const newItemCount = await mergeAndSaveSource("stocktwits", itemsByTicker);
  res.status(200).json({ ok: true, source: "stocktwits", tickersChecked: WATCHLIST.length, newItemsFound: newItemCount, checkedAt: new Date().toISOString() });
}
