// api/quotes.js — batch live quotes (up to 60 symbols per call) for the Preferreds tab.
// Same Yahoo v8/finance/chart approach as quote.js, but many symbols per request.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_SYMBOLS = 60;
const PARALLEL = 10;

async function fetchQuote(symbol) {
  const y = symbol.replace(/\./g, "-");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=1d&range=1d`;
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") throw new Error("no price");
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? null;
  return { price, prevClose: prev, changePercent: prev ? ((price - prev) / prev) * 100 : null };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");
  const raw = String(req.query.symbols || "");
  const symbols = [...new Set(raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_SYMBOLS);
  if (!symbols.length) return res.status(400).json({ ok: false, error: "pass ?symbols=AAA,BBB" });

  const quotes = {}, errors = {};
  let i = 0;
  async function worker() {
    while (i < symbols.length) {
      const s = symbols[i++];
      try { quotes[s] = await fetchQuote(s); } catch (e) { errors[s] = e.message; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, symbols.length) }, worker));
  res.status(200).json({ ok: true, count: Object.keys(quotes).length, quotes, errors });
}
