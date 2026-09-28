// api/quote.js  (plain Vercel Serverless Function — no framework needed)
//
// WHAT THIS DOES: live quote proxy for cef-inav-estimator.html. The browser
// can't call Yahoo Finance directly (CORS), so this does the fetch server-side.
//
// TWO MODES (one file, so the project stays within Vercel's 12-function limit):
//   Single (CEF tab, unchanged): /api/quote?symbol=AAPL
//     → { symbol, price, changePercent, marketState }
//   Batch (Preferreds tab):      /api/quote?symbols=COF,COF-PI,COF-PJ   (max 30)
//     → { ok, count, quotes: { SYMBOL: { symbol, price, changePercent, marketState } }, errors }

const MAX_BATCH = 30;

async function fetchText(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.google.com/"
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// One ticker, same session-aware price logic as before (pre/post-market when active).
async function getQuote(symbol, timeoutMs) {
  // Yahoo uses hyphens for share classes (BRK-A) where our data uses periods (BRK.A).
  // Keep the ORIGINAL symbol in the response so the frontend's lookup still matches.
  const yahooSymbol = symbol.replace(/\./g, "-");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1m&includePrePost=true`;
  const raw = await fetchText(url, timeoutMs);
  const data = JSON.parse(raw);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error("no meta in Yahoo response");

  const state = meta.marketState;
  let price;
  if ((state === "PRE" || state === "PREPRE") && typeof meta.preMarketPrice === "number") {
    price = meta.preMarketPrice;
  } else if ((state === "POST" || state === "POSTPOST") && typeof meta.postMarketPrice === "number") {
    price = meta.postMarketPrice;
  } else {
    price = meta.regularMarketPrice;
  }
  const prevClose = meta.chartPreviousClose ?? meta.previousClose;
  const changePercent = (typeof price === "number" && typeof prevClose === "number" && prevClose !== 0)
    ? (price - prevClose) / prevClose * 100
    : null;

  return { symbol, price: price ?? null, changePercent, marketState: state ?? null };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  const params = new URL(req.url, "http://x").searchParams;

  // ---- Batch mode: ?symbols=A,B,C ----
  const batch = req.query?.symbols || params.get("symbols");
  if (batch) {
    const symbols = [...new Set(String(batch).split(",").map(s => s.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_BATCH);
    const quotes = {}, errors = {};
    await Promise.all(symbols.map(async (s) => {
      try {
        const q = await getQuote(s, 6000);
        if (typeof q.price === "number") quotes[s] = q; else errors[s] = "no price";
      } catch (e) {
        errors[s] = e.message;
      }
    }));
    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");
    return res.status(200).json({ ok: true, count: Object.keys(quotes).length, quotes, errors });
  }

  // ---- Single mode: ?symbol=AAPL (unchanged behavior for the CEF tab) ----
  const symbol = req.query?.symbol || params.get("symbol");
  if (!symbol) {
    return res.status(400).json({ error: "missing ?symbol=" });
  }
  try {
    res.status(200).json(await getQuote(symbol, 8000));
  } catch (err) {
    res.status(err.message === "no meta in Yahoo response" ? 502 : 500).json({ error: err.message });
  }
}
