// api/quote.js  (plain Vercel Serverless Function — no framework needed)
//
// WHAT THIS DOES: live quote proxy for cef-inav-estimator.html. The browser
// can't call Yahoo Finance directly (CORS), so this does the fetch server-side.
//
// FOUR MODES (one file, so the project stays within Vercel's 12-function limit):
//   Single (CEF tab, unchanged): /api/quote?symbol=AAPL
//     → { symbol, price, changePercent, marketState }
//   Batch (Preferreds tab):      /api/quote?symbols=COF,COF-PI,COF-PJ   (max 30)
//     → { ok, count, quotes: { SYMBOL: { symbol, price, changePercent, marketState, volume } }, errors }
//   History (Pref Setup tab):    /api/quote?history=TLT,COF-PI&range=6mo   (max 25; range 1mo|3mo|6mo|1y|2y)
//     → { ok, history: { SYMBOL: { days, close, adj, vol, divs } }, errors }
//   FRED (Pref Setup tab):       /api/quote?fred=DGS20,BAMLC0A4CBBB   (max 5 series, official Federal Reserve data)
//     → { ok, fred: { ID: { d: [dates], v: [values] } }, errors }

const MAX_BATCH = 30;
const MAX_HISTORY = 25;
const RANGES = new Set(["1mo", "3mo", "6mo", "1y", "2y"]);

// Daily history for one ticker: closes, dividend-adjusted closes, volumes, dividends.
async function getHistory(symbol, range) {
  const yahooSymbol = symbol.replace(/\./g, "-");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=1d&events=div`;
  const data = JSON.parse(await fetchText(url, 8000));
  const r = data?.chart?.result?.[0];
  if (!r || !Array.isArray(r.timestamp)) throw new Error("no history");
  const q = r.indicators?.quote?.[0] || {};
  const adjAll = r.indicators?.adjclose?.[0]?.adjclose || [];
  const days = [], close = [], adj = [], vol = [];
  r.timestamp.forEach((ts, i) => {
    const c = q.close?.[i];
    if (typeof c !== "number") return;
    days.push(new Date(ts * 1000).toISOString().slice(0, 10));
    close.push(+c.toFixed(4));
    adj.push(typeof adjAll[i] === "number" ? +adjAll[i].toFixed(4) : +c.toFixed(4));
    vol.push(q.volume?.[i] ?? 0);
  });
  const divs = Object.values(r.events?.dividends || {})
    .map(d => ({ date: new Date(d.date * 1000).toISOString().slice(0, 10), amount: d.amount }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { days, close, adj, vol, divs };
}

// One FRED series (no API key needed for the CSV download). Keeps the last ~2 years.
async function getFred(id) {
  const csv = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`, 8000);
  const d = [], v = [];
  csv.trim().split(/\r?\n/).slice(1).forEach(line => {
    const [date, val] = line.split(",");
    const n = parseFloat(val);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(n)) { d.push(date); v.push(n); }
  });
  if (!d.length) throw new Error("no FRED data");
  return { d: d.slice(-520), v: v.slice(-520) };
}

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

  return { symbol, price: price ?? null, changePercent, marketState: state ?? null, volume: meta.regularMarketVolume ?? null };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  const params = new URL(req.url, "http://x").searchParams;

  // ---- History mode: ?history=A,B&range=6mo ----
  const hist = req.query?.history || params.get("history");
  if (hist) {
    const range = RANGES.has(String(req.query?.range || params.get("range"))) ? String(req.query?.range || params.get("range")) : "6mo";
    const symbols = [...new Set(String(hist).split(",").map(s => s.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_HISTORY);
    const history = {}, errors = {};
    await Promise.all(symbols.map(async (s) => {
      try { history[s] = await getHistory(s, range); } catch (e) { errors[s] = e.message; }
    }));
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");
    return res.status(200).json({ ok: true, count: Object.keys(history).length, history, errors });
  }

  // ---- FRED mode: ?fred=DGS20,BAMLC0A4CBBB ----
  const fred = req.query?.fred || params.get("fred");
  if (fred) {
    const ids = [...new Set(String(fred).split(",").map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9]+$/.test(s)))].slice(0, 5);
    const out = {}, errors = {};
    await Promise.all(ids.map(async (id) => {
      try { out[id] = await getFred(id); } catch (e) { errors[id] = e.message; }
    }));
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");
    return res.status(200).json({ ok: true, fred: out, errors });
  }

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
