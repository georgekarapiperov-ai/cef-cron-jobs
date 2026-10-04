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
//     → { ok, fred: { ID: { d: [dates], v: [values], src } }, errors }
//     Optional: set FRED_API_KEY in Vercel → Settings → Environment Variables for the most reliable route.
//   CALENDARS (Pref Setup → Calendars) — fetched live and cached at Vercel's edge, NO KV used:
//     /api/quote?econ=1&from=2026-10-05&to=2026-10-11&countries=US,EU,DE   (TradingView economic calendar, max 35 days)
//     /api/quote?earnings=2026-10-01&to=2026-10-31   (Nasdaq earnings calendar, weekdays, max 35 days)
//     /api/quote?dividends=2026-10-01&to=2026-10-31  (Nasdaq dividend calendar by ex-date, weekdays, max 35 days)

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

// ---- FRED series: rates & credit spreads ----
// Route 1: FRED's official API when FRED_API_KEY is set in Vercel (free key from fredaccount.stlouisfed.org).
// Route 2: FRED's CSV download, last ~2 years only (small and fast).
// Route 3 (20Y yield only): the U.S. Treasury's own daily yield-curve CSV.
function isoDaysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

async function fredFromApi(id) {
  const key = process.env.FRED_API_KEY;
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(id)}&api_key=${encodeURIComponent(key)}&file_type=json&observation_start=${isoDaysAgo(760)}`;
  const j = JSON.parse(await fetchText(url, 5000));
  const d = [], v = [];
  (j.observations || []).forEach(o => { const n = parseFloat(o.value); if (!isNaN(n)) { d.push(o.date); v.push(n); } });
  if (!d.length) throw new Error("FRED API returned no data");
  return { d, v, src: "FRED API" };
}

async function fredFromCsv(id) {
  const csv = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${isoDaysAgo(760)}`, 5000);
  const d = [], v = [];
  csv.trim().split(/\r?\n/).slice(1).forEach(line => {
    const [date, val] = line.split(",");
    const n = parseFloat(val);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(n)) { d.push(date); v.push(n); }
  });
  if (!d.length) throw new Error("FRED CSV returned no data");
  return { d, v, src: "FRED" };
}

async function treasury20y() {
  const y = new Date().getUTCFullYear();
  const years = [y, y - 1, y - 2];
  const rows = new Map();
  await Promise.all(years.map(async (yr) => {
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${yr}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${yr}&page&_format=csv`;
    const csv = await fetchText(url, 4000);
    const lines = csv.trim().split(/\r?\n/);
    const col = lines[0].split(",").map(h => h.replace(/"/g, "").trim()).indexOf("20 Yr");
    if (col < 0) return;
    lines.slice(1).forEach(line => {
      const c = line.split(",");
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(c[0]);
      const n = parseFloat(c[col]);
      if (m && !isNaN(n)) rows.set(`${m[3]}-${m[1]}-${m[2]}`, n);
    });
  }).map(p => p.catch(() => null)));
  const d = [...rows.keys()].sort();
  if (!d.length) throw new Error("Treasury CSV returned no data");
  return { d, v: d.map(k => rows.get(k)), src: "U.S. Treasury" };
}

async function getFred(id) {
  const errs = [];
  if (process.env.FRED_API_KEY) {
    try { return await fredFromApi(id); } catch (e) { errs.push("API: " + e.message); }
  }
  try { return await fredFromCsv(id); } catch (e) { errs.push("CSV: " + e.message); }
  if (id === "DGS20") {
    try { return await treasury20y(); } catch (e) { errs.push("Treasury: " + e.message); }
  }
  throw new Error(errs.join(" | "));
}


// ---------- CALENDARS (live, edge-cached, no KV) ----------
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function dayList(from, to, weekdaysOnly) {
  const out = []; const d = new Date(from + "T00:00:00Z"), end = new Date(to + "T00:00:00Z");
  while (d <= end && out.length < 36) { const wd = d.getUTCDay(); if (!weekdaysOnly || (wd !== 0 && wd !== 6)) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
async function poolMap(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: e.message }; } } }));
  return out;
}
async function fetchJSON(url, headers, timeoutMs = 10000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const NASDAQ_HEADERS = { "User-Agent": UA, "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", "Origin": "https://www.nasdaq.com", "Referer": "https://www.nasdaq.com/" };
const money = s => { const n = parseFloat(String(s ?? "").replace(/[$,\s]/g, "")); return isNaN(n) ? null : n; };
const mdy = s => { const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null; };

async function econCalendar(from, to, countries) {
  const url = `https://economic-calendar.tradingview.com/events?from=${from}T00:00:00.000Z&to=${to}T23:59:59.000Z&countries=${encodeURIComponent(countries)}`;
  let j;
  for (const origin of ["https://www.tradingview.com", "https://in.tradingview.com"]) {
    try { j = await fetchJSON(url, { "User-Agent": UA, "Accept": "application/json", "Origin": origin, "Referer": origin + "/" }); break; }
    catch (e) { if (origin.includes("in.")) throw e; }
  }
  return (j?.result || []).map(e => ({
    t: e.date, country: e.country, title: e.title, period: e.period || null, importance: e.importance,
    actual: e.actual ?? null, forecast: e.forecast ?? null, previous: e.previous ?? null, unit: e.unit || "", scale: e.scale || "", category: e.category || null
  }));
}
async function earningsDay(date) {
  const j = await fetchJSON(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, NASDAQ_HEADERS);
  return (j?.data?.rows || []).map(r => ({
    date, symbol: r.symbol, name: r.name, mcap: money(r.marketCap),
    time: /pre/i.test(r.time || "") ? "bmo" : /after/i.test(r.time || "") ? "amc" : "",
    eps: money(r.epsForecast), nEst: parseInt(r.noOfEsts, 10) || null, fq: r.fiscalQuarterEnding || null, lastEps: money(r.lastYearEPS)
  }));
}
async function dividendsDay(date) {
  const j = await fetchJSON(`https://api.nasdaq.com/api/calendar/dividends?date=${date}`, NASDAQ_HEADERS);
  return (j?.data?.calendar?.rows || []).map(r => ({
    exDate: mdy(r.dividend_Ex_Date) || date, symbol: r.symbol, name: r.companyName, amount: money(r.dividend_Rate),
    annual: money(r.indicated_Annual_Dividend), payDate: mdy(r.payment_Date), recordDate: mdy(r.record_Date), announced: mdy(r.announcement_Date)
  }));
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

  // ---- Calendars ----
  const q = k => req.query?.[k] || params.get(k);
  if (q("econ") || q("earnings") || q("dividends")) {
    const from = q("econ") ? q("from") : (q("earnings") || q("dividends"));
    const to = q("to") || from;
    if (!ISO_DAY.test(from || "") || !ISO_DAY.test(to || "") || to < from) return res.status(400).json({ ok: false, error: "use from/to as YYYY-MM-DD" });
    try {
      if (q("econ")) {
        const countries = String(q("countries") || "US,EU,DE,FR,GB,JP,CN,IN,AU,NZ").toUpperCase().replace(/[^A-Z,]/g, "");
        const days = dayList(from, to, false);
        const events = await econCalendar(from, days[days.length - 1], countries);
        res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
        return res.status(200).json({ ok: true, from, to, count: events.length, events });
      }
      const days = dayList(from, to, true);
      const isEarn = !!q("earnings");
      const per = await poolMap(days, 6, isEarn ? earningsDay : dividendsDay);
      const rows = [], errors = {};
      per.forEach((r, i) => { if (Array.isArray(r)) rows.push(...r); else errors[days[i]] = r?.error || "failed"; });
      res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=43200");
      return res.status(200).json({ ok: true, from, to, count: rows.length, rows, errors });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  }

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
