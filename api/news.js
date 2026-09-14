// api/news.js  (plain Vercel Serverless Function — no framework needed)
//
// WHAT THIS DOES: a simple read endpoint. news-check.js does the polling and
// saving; this just hands back what's currently stored, with permissive CORS
// so the separate cef-inav-estimator.html tool (hosted anywhere) can fetch
// it directly from the browser.
//
// WHERE TO PUT IT: api/news.js at the root of your repo.

import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  try {
    const news = (await kv.get("news:all")) || {};
    res.status(200).json({ ok: true, news });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
