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
// HOLDINGS MODE (2026-10-01): /api/nav-data?holdings=1 returns holdings-check.js's
// saved top-10 holdings for every fund (kept in this file so the project stays
// within Vercel's 12-function limit).
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
  "BTO", "SCD", "CII", "NCV", "CGO", "STEW",
  "HIX", "NMZ", "ACP", "TEI", "MMU", "NAD", "FSCO", "JQC", "JFR", "PHK",
  "NDMO", "PPT", "NZF", "VGM", "MMT", "GOF", "BPRE", "BTT", "RLTY", "NUV",
  "NMCO", "PML", "FPF", "JPC", "NVG", "NBB", "IGD", "NPFD", "ERC", "CIK",
  "NEA", "DHY", "VKI", "BGT", "DSU", "HGLB", "CEF", "IIM", "FTF", "MUC",
  "VGI", "PDI", "PCQ", "BDJ", "FRA", "EFR", "EARN", "FFC", "IGA", "GHY",
  "BBN", "WIW", "NAC", "NKX", "OIA", "BGB", "KIO", "IDE", "PFL", "KTF",
  "BIT", "GGT", "PTY", "EVT", "MMD", "EAD", "PDT", "GLO", "DLY", "DSL",
  "EVV", "MFM", "VVR", "IQI", "EMD", "MCN", "ZTR", "OPP", "MUJ", "CCIF",
  "BGY", "MHD", "MGF", "DFP", "FSSL", "EDF", "LDP", "PTA", "FTHY", "SWZ",
  "BLW", "NHS", "EOD", "MUA", "HPS", "EFT", "VMO", "IFN", "DXYZ", "MQY",
  "BKT", "BGX", "HFRO", "JLS", "VKQ", "NRK", "PFN", "PSUS", "RA", "MHF",
  "ARDC", "EVN", "SPE", "BGH", "RMM", "HTD", "EIM", "HYT", "NAN", "PFD",
  "ASGI", "KF", "EHI", "LEO", "HYI", "ECF", "PDO", "BHK", "MCI", "EIC",
  "AWF", "DBL", "VBF", "PCM", "EVF", "FLC", "EVG", "RSF", "AEF", "IAE",
  "WDI", "GUG", "ISD", "FAX", "VLT", "NPCT", "RVI", "RFMZ", "GLV", "TDF",
  "PSF", "VCV", "EDD", "PGP", "JGH", "PCN", "MYI", "DMB", "GUT", "DHF",
  "EOT", "GDL", "NXP", "CET", "HPI", "TPZ", "EMF", "RCS", "IIF", "DMA",
  "HIO", "CFND", "PAXS", "BTZ", "IGR", "DSM", "SCOP", "FINS", "BRW", "NXDT",
  "SPMC", "NAZ", "DMO", "GBAB", "GDO", "BWG", "AFB", "WIA", "TWN", "ECC",
  "RVII", "MXF", "GCV", "RGT", "GRX", "HPF", "GGZ", "PCF", "VTN", "NBH",
  "JHI", "NRO", "ASA", "DTF", "TSI", "MYN", "NMS", "MSD", "PGZ", "MIY",
  "PFO", "JOF", "TBLD", "JMM", "JHS", "PAI", "IGI", "ETX", "FMN", "WEA",
  "FMY", "FOF", "VPV", "EEA", "FUND", "GAM", "GF", "GRF", "HEQ", "HERZ",
  "IAF", "XFLT", "SOR", "SABA", "CEV", "PWRL", "BANX", "NMT", "NNY", "BOT",
  "PNI", "PMO", "NPV", "PIM", "NSLR", "BMN", "NUW", "OCCI", "PMM", "SDHY",
  "NMI", "BSL", "MIN", "SBI", "BHV", "CEE", "MPA", "MPV", "RCG", "RMMZ",
  "RMI", "CAF", "NCA", "NIM", "RFM", "MXE", "IHD"
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  try {
    // ?holdings=1 → the saved top-10 holdings (from holdings-check.js) for every fund
    if (req.query?.holdings) {
      const hv = await kv.mget(...WATCHLIST.map(t => `holdings:${t}`));
      const holdings = {};
      WATCHLIST.forEach((ticker, i) => { if (hv[i]) holdings[ticker] = hv[i]; });
      return res.status(200).json({ ok: true, count: Object.keys(holdings).length, holdings });
    }
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
