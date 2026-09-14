// api/nav-data.js  (plain Vercel Serverless Function — no framework needed)
//
// WHAT THIS DOES: a read endpoint that returns nav-check.js's saved current
// snapshot for every fund in one request, so the standalone
// cef-inav-estimator.html tool can pull in real, daily-updated NAV data
// instead of the static snapshot baked into that file at build time.
//
// nav-check.js saves one KV key per fund (nav-current:TICKER) rather than
// one combined key — unlike news:all, which was combined from the start for
// exactly this reason. This endpoint does the combining at READ time instead,
// fetching all 86 keys in one batched call so the browser only needs one
// request, not 86.
//
// WHERE TO PUT IT: api/nav-data.js at the root of your cef-cron-jobs repo.

import { kv } from "@vercel/kv";

const WATCHLIST = [
  "USA", "UTG", "UTF", "DNP", "BUI", "MEGI", "GLU", "DPG", "ERH", "PEO",
  "BGR", "NXG", "EMO", "BCX", "RQI", "RNP", "RFI", "JRS", "JRI", "AWP",
  "THW", "THQ", "HQH", "HQL", "BMEZ", "BME", "PDX", "GNT", "GGN", "BCV",
  "TY", "STK", "ETO", "LGI", "BST", "BSTZ", "GDV", "NIE", "CCD", "AIO",
  "RMT", "RVT", "NCZ", "AVK", "ECAT", "NBXG", "BCAT", "ETB", "SPXX", "JCE",
  "RIV", "ETG", "AGD", "NFJ", "BTX", "ETY", "CHI", "GLQ", "ETV", "ETW",
  "ETJ", "ADX", "ASG", "AOD", "EOI", "FT", "CHW", "GAB", "EOS", "EXG",
  "CSQ", "CPZ", "NMAI", "BOE", "CLM", "CRF", "CHY", "FFA", "ACV", "QQQX",
  "BTO", "SCD", "CII", "NCV", "CGO", "STEW"
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  try {
    const keys = WATCHLIST.map(t => `nav-current:${t}`);
    const values = await kv.mget(...keys);
    const nav = {};
    WATCHLIST.forEach((ticker, i) => {
      if (values[i]) nav[ticker] = values[i];
    });
    res.status(200).json({ ok: true, count: Object.keys(nav).length, nav });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
