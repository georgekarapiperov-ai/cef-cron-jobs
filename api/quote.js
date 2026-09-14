// api/quote.js  (plain Vercel Serverless Function — no framework needed)
//
// WHAT THIS DOES: a live single-ticker quote proxy for the standalone
// cef-inav-estimator.html tool. That tool runs in a browser and can't call
// Yahoo Finance directly (CORS), so it was relying on public CORS proxies —
// which are unreliable and were causing the frozen/missing prices you saw.
// This endpoint does the same server-side fetch we already proved works in
// nav-check.js (proper browser headers, timeout), with no CORS problem since
// it's server-to-server.
//
// WHERE TO PUT IT: api/quote.js at the root of your cef-cron-jobs repo,
// alongside holdings-check.js, nav-check.js, and news-check.js.
//
// USAGE FROM THE MAIN TOOL: https://cef-cron-jobs.vercel.app/api/quote?symbol=AAPL

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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const symbol = req.query?.symbol || new URL(req.url, "http://x").searchParams.get("symbol");
  if (!symbol) {
    return res.status(400).json({ error: "missing ?symbol=" });
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=true`;
    const raw = await fetchText(url);
    const data = JSON.parse(raw);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) {
      return res.status(502).json({ error: "no meta in Yahoo response" });
    }

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

    res.status(200).json({ symbol, price: price ?? null, changePercent, marketState: state ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
