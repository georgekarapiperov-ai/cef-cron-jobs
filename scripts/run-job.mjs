// Runs one data job inside GitHub Actions and writes the results into <outDir>:
//   node scripts/run-job.mjs news     out   → news.json      (+ kv-news.json store)
//   node scripts/run-job.mjs nav      out   → nav.json       (+ kv-nav.json store, NAV history)
//   node scripts/run-job.mjs holdings out   → holdings.json  (+ kv-holdings.json store)
// It calls the SAME handlers the Vercel functions use, with a file-based KV (scripts/kv-file-shim.mjs).
// Never exits with an error for a partial problem — the previous data simply stays in place.
import fs from "node:fs";
import path from "node:path";

const [job, outDir = "out"] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
process.env.KV_FILE = path.resolve(outDir, `kv-${job}.json`);
const { kv } = await import("@vercel/kv");
const api = f => new URL(`../api/${f}`, import.meta.url).href;
const t0 = Date.now(), log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

function fakeRes() {
  return { code: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; } };
}
async function call(file, query = {}, timeoutMs = 10 * 60 * 1000) {
  const mod = await import(api(file)); const res = fakeRes();
  const req = { query, url: "/api/" + file + "?" + new URLSearchParams(query), method: "GET", headers: {} };
  await Promise.race([mod.default(req, res), new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), timeoutMs))]);
  return res;
}
const writeJSON = (name, obj) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(obj));
const summary = { job, startedAt: new Date(t0).toISOString(), steps: {} };

async function seedNavHistory() {
  // First run for a fund: one year of daily NAVs from CEFConnect, so the 52-week range is right from day one.
  const { CEF_WATCHLIST } = await import(api("../lib/news-shared.js"));
  const missing = [];
  for (const t of CEF_WATCHLIST) { const h = await kv.get(`nav-history:${t}`); if (!h || h.length < 20) missing.push(t); }
  let i = 0, seeded = 0;
  async function worker() {
    while (i < missing.length) {
      const t = missing[i++];
      try {
        const r = await fetch(`https://www.cefconnect.com/api/v3/pricinghistory/${t}/1Y`, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36", "Accept": "application/json", "Referer": "https://www.cefconnect.com/" } });
        const j = await r.json();
        const rows = (j?.Data?.PriceHistory || []).filter(x => typeof x.NAVData === "number" && x.NAVData > 0)
          .map(x => ({ date: String(x.DataDate).slice(0, 10), nav: x.NAVData, source: "cefconnect-history" }));
        if (rows.length) { const old = (await kv.get(`nav-history:${t}`)) || []; const m = new Map(rows.map(x => [x.date, x])); old.forEach(x => m.set(x.date, x)); await kv.set(`nav-history:${t}`, [...m.values()].sort((a, b) => a.date.localeCompare(b.date))); seeded++; }
      } catch { /* try again next run */ }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return { missing: missing.length, seeded };
}

try {
  if (job === "news") {
    const sources = ["yahoo", "google", "stocktwits", "newsfilter", "finviz", "alphavantage", "secedgar"];
    const res = await Promise.allSettled(sources.map(s => call(`news-${s}.js`, {}, 12 * 60 * 1000)));
    res.forEach((r, i) => { summary.steps[sources[i]] = r.status === "fulfilled" ? (r.value.body || { code: r.value.code }) : { error: r.reason?.message }; log(sources[i], JSON.stringify(summary.steps[sources[i]]).slice(0, 160)); });
    kv.__save();
    const out = await call("news.js");
    if (out.body?.ok && out.body.news && Object.keys(out.body.news).length) {
      writeJSON("news.json", { ok: true, generatedAt: new Date().toISOString(), count: out.body.count, source: out.body.source || "github-actions", news: out.body.news });
      summary.newsTickers = out.body.count;
    } else summary.warning = "news output empty — kept the previous news.json";
  } else if (job === "nav") {
    summary.steps.seed = await seedNavHistory(); log("seed", JSON.stringify(summary.steps.seed));
    const r = await call("nav-check.js", {}, 25 * 60 * 1000);
    summary.steps.navCheck = { checked: r.body?.checked, failed: r.body?.failed, navDates: r.body?.navDates, feed: r.body?.cefconnectFeedFunds }; log("nav-check", JSON.stringify(summary.steps.navCheck));
    kv.__save();
    const out = await call("nav-data.js");
    if (out.body?.ok && out.body.nav && Object.keys(out.body.nav).length) {
      writeJSON("nav.json", { ok: true, generatedAt: new Date().toISOString(), count: out.body.count, nav: out.body.nav });
      summary.navFunds = out.body.count;
    } else summary.warning = "nav output empty — kept the previous nav.json";
  } else if (job === "holdings") {
    for (const g of [1, 2, 3, 4]) {
      const r = await call("holdings-check.js", { group: String(g) }, 15 * 60 * 1000);
      summary.steps["group" + g] = { checked: r.body?.checked, updated: r.body?.updated, failed: r.body?.failed, lookups: r.body?.newTickerLookups }; log("holdings group", g, JSON.stringify(summary.steps["group" + g]));
      kv.__save();
    }
    const out = await call("nav-data.js", { holdings: "1" });
    if (out.body?.ok && out.body.holdings && Object.keys(out.body.holdings).length) {
      writeJSON("holdings.json", { ok: true, generatedAt: new Date().toISOString(), count: out.body.count, holdings: out.body.holdings });
      summary.holdingsFunds = out.body.count;
    } else summary.warning = "holdings output empty — kept the previous holdings.json";
  } else {
    throw new Error("unknown job " + job);
  }
} catch (e) {
  summary.error = e.message; console.error("[run-job]", e);
}
summary.finishedAt = new Date().toISOString(); summary.keys = kv.__save();
writeJSON(`status-${job}.json`, summary);
log("done", JSON.stringify({ ...summary, steps: undefined }));
process.exit(0);
