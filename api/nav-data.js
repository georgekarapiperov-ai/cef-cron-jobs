// api/nav-data.js  (plain Vercel Serverless Function — no framework needed)
//
// WHAT THIS DOES: a read endpoint that returns nav-check.js's saved current
// snapshot for every fund in one request, so the standalone
// cef-inav-estimator.html tool can pull in real, daily-updated NAV data
// instead of the static snapshot baked into that file at build time.
//
// nav-check.js saves one KV key per fund (nav-current:TICKER) rather than
// one combined key. This endpoint does the combining at READ time instead,
// fetching all keys in one batched call so the browser only needs one
// request, not one per fund.
//
// CACHE FIX (2026-09-22): explicitly disabling caching here guarantees every
// request hits KV fresh, no matter what the browser would otherwise assume.
//
// WATCHLIST EXPANDED (2026-09-25): grew from 86 to 353 funds. This file has
// its OWN copy of the watchlist, separate from nav-check.js's — they must be
// kept in sync manually. If you add more funds later, update BOTH files.
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
