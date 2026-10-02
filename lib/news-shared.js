// lib/news-shared.js
//
// Shared helpers used by every per-source news function (news-newsfilter.js,
// news-yahoo.js, news-google.js, news-finviz.js, news-stocktwits.js,
// news-secedgar.js, news-alphavantage.js).
//
// KEY DESIGN DECISION: each source writes to its OWN KV key
// ("news:source:<name>") instead of all sources sharing one "news:all" key.
// These functions now run independently, on different schedules, and can
// genuinely execute AT THE SAME TIME (GitHub Actions runs each workflow on
// its own trigger). If they all wrote to one shared key, two sources
// finishing at the same moment would race — whichever saves last would
// silently overwrite the other's results. Separate keys make that
// impossible: nobody's writes can clobber anybody else's. The read endpoint
// (api/news.js) combines all sources' keys together at READ time instead.
//
// RELEVANCE FILTER (2026-09-22): Google News / Yahoo / StockTwits searches
// by ticker alone pull in a lot of noise — short tickers collide with plain
// English words (USA, FT, TY, BME...) or with a completely different
// company that happens to share the same ticker on another exchange (CGO is
// also a Canadian telecom on TSX; BUI matched an unrelated Business Insider
// story). isRelevant() rejects anything that doesn't actually look like it's
// about THIS fund: either the ticker appears as a distinct word/cashtag,
// AND, for tickers known to collide with something else, the article must
// also mention a piece of the fund's real name. SEC EDGAR items are always
// trusted since they come from the filer's own official CIK, not a keyword
// search.
//
// PREFERRED-STOCK PARENTS (2026-09-28): the Preferreds tab groups 690
// preferreds / baby bonds under ~310 parent companies (COF → COF-I, COF-J…).
// News is fetched ONCE per parent common ticker (PREF_PARENTS), not per
// preferred — pref-specific headlines ("Capital One declares dividends on
// Series I…") name the parent company, and the frontend attaches them to the
// right preferred by matching the series. To switch this off instantly if a
// news job starts timing out, set INCLUDE_PREF_PARENTS = false and commit.

import { kv } from "@vercel/kv";

// The CEF watchlist — keep in sync with nav-check.js, nav-data.js and the
// frontend FUNDS array (see CLAUDE.md "two separate hardcoded watchlists").
export const CEF_WATCHLIST = [
  "USA", "UTG", "UTF", "DNP", "BUI", "MEGI", "GLU", "DPG", "ERH", "PEO",
  "BGR", "NXG", "EMO", "BCX", "RQI", "RNP", "RFI", "JRS", "JRI", "AWP",
  "THW", "THQ", "HQH", "HQL", "BMEZ", "BME", "PDX", "GNT", "GGN", "BCV",
  "TY", "STK", "ETO", "LGI", "BST", "BSTZ", "GDV", "NIE", "CCD", "AIO",
  "RMT", "RVT", "NCZ", "AVK", "ECAT", "NBXG", "BCAT", "ETB", "SPXX", "JCE",
  "RIV", "ETG", "AGD", "NFJ", "BTX", "ETY", "CHI", "GLQ", "ETV", "ETW",
  "ETJ", "ADX", "ASG", "AOD", "EOI", "FT", "CHW", "GAB", "EOS", "EXG",
  "CSQ", "CPZ", "NMAI", "BOE", "CLM", "CRF", "CHY", "FFA", "ACV", "QQQX",
  "BTO", "SCD", "CII", "NCV", "CGO", "STEW", "HIX", "NMZ", "ACP", "TEI",
  "MMU", "NAD", "FSCO", "JQC", "JFR", "PHK", "NDMO", "PPT", "NZF", "VGM",
  "MMT", "GOF", "BPRE", "BTT", "RLTY", "NUV", "NMCO", "PML", "FPF", "JPC",
  "NVG", "NBB", "IGD", "NPFD", "ERC", "CIK", "NEA", "DHY", "VKI", "BGT",
  "DSU", "HGLB", "CEF", "IIM", "FTF", "MUC", "VGI", "PDI", "PCQ", "BDJ",
  "FRA", "EFR", "EARN", "FFC", "IGA", "GHY", "BBN", "WIW", "NAC", "NKX",
  "OIA", "BGB", "KIO", "IDE", "PFL", "KTF", "BIT", "GGT", "PTY", "EVT",
  "MMD", "EAD", "PDT", "GLO", "DLY", "DSL", "EVV", "MFM", "VVR", "IQI",
  "EMD", "MCN", "ZTR", "OPP", "MUJ", "CCIF", "BGY", "MHD", "MGF", "DFP",
  "FSSL", "EDF", "LDP", "PTA", "FTHY", "SWZ", "BLW", "NHS", "EOD", "MUA",
  "HPS", "EFT", "VMO", "IFN", "DXYZ", "MQY", "BKT", "BGX", "HFRO", "JLS",
  "VKQ", "NRK", "PFN", "PSUS", "RA", "MHF", "ARDC", "EVN", "SPE", "BGH",
  "RMM", "HTD", "EIM", "HYT", "NAN", "PFD", "ASGI", "KF", "EHI", "LEO",
  "HYI", "ECF", "PDO", "BHK", "MCI", "EIC", "AWF", "DBL", "VBF", "PCM",
  "EVF", "FLC", "EVG", "RSF", "AEF", "IAE", "WDI", "GUG", "ISD", "FAX",
  "VLT", "NPCT", "RVI", "RFMZ", "GLV", "TDF", "PSF", "VCV", "EDD", "PGP",
  "JGH", "PCN", "MYI", "DMB", "GUT", "DHF", "EOT", "GDL", "NXP", "CET",
  "HPI", "TPZ", "EMF", "RCS", "IIF", "DMA", "HIO", "CFND", "PAXS", "BTZ",
  "IGR", "DSM", "SCOP", "FINS", "BRW", "NXDT", "SPMC", "NAZ", "DMO", "GBAB",
  "GDO", "BWG", "AFB", "WIA", "TWN", "ECC", "RVII", "MXF", "GCV", "RGT",
  "GRX", "HPF", "GGZ", "PCF", "VTN", "NBH", "JHI", "NRO", "ASA", "DTF",
  "TSI", "MYN", "NMS", "MSD", "PGZ", "MIY", "PFO", "JOF", "TBLD", "JMM",
  "JHS", "PAI", "IGI", "ETX", "FMN", "WEA", "FMY", "FOF", "VPV", "EEA",
  "FUND", "GAM", "GF", "GRF", "HEQ", "HERZ", "IAF", "XFLT", "SOR", "SABA",
  "CEV", "PWRL", "BANX", "NMT", "NNY", "BOT", "PNI", "PMO", "NPV", "PIM",
  "NSLR", "BMN", "NUW", "OCCI", "PMM", "SDHY", "NMI", "BSL", "MIN", "SBI",
  "BHV", "CEE", "MPA", "MPV", "RCG", "RMMZ", "RMI", "CAF", "NCA", "NIM",
  "RFM", "MXE", "IHD"
];

// ON/OFF switch for preferred-stock parent news. false = CEF news only (exactly as before).
export const INCLUDE_PREF_PARENTS = true;

// Parent-company common tickers from Pref-Master.xlsx (the Preferreds tab's
// families). Tickers marked "*" in the sheet (common no longer trades) are left out.
export const PREF_PARENTS = [
  "ABR", "ABX", "ACGL", "ACP", "ACR", "AD", "ADAM", "ADC", "AEG", "AFG", "AGM", "AGNC",
  "AHRT", "AHT", "AIG", "AIRT", "AIZ", "ALB", "ALL", "ALTG", "AMG", "AMH", "AOMR", "AON",
  "APO", "AQN", "ARES", "ARR", "ASB", "ASST", "ATLC", "AUB", "AXS", "BA", "BAC", "BAM",
  "BANC", "BANF", "BC", "BCV", "BEP", "BFH", "BFS", "BHF", "BHR", "BIP", "BIPC", "BMNR",
  "BN", "BNY", "BOH", "BPOP", "BRKR", "BTSG", "BUSE", "BW", "BWB", "C", "CCIF", "CCNE",
  "CDZI", "CFG", "CFR", "CFTR", "CG", "CHMI", "CHSCP", "CIM", "CION", "CLDT", "CMRE", "CMS",
  "CNO", "CNOB", "CODI", "COF", "CTO", "CTVA", "CUBI", "D", "DBRG", "DCOM", "DDS", "DHC",
  "DLNG", "DLR", "DSX", "DTE", "DUK", "DX", "EARN", "ECC", "ECF", "EFC", "EFSC", "EIC",
  "EIX", "EPIIF", "EPR", "EQH", "ET", "ETR", "EXC", "F", "FBIO", "FBRT", "FBYD", "FCNCA",
  "FG", "FGBI", "FGNX", "FHN", "FITB", "FLG", "FOUR", "FRME", "FRT", "FTAI", "FULT", "GAB",
  "GAIN", "GAM", "GDV", "GECC", "GEG", "GGN", "GGT", "GL", "GLP", "GLU", "GNL", "GNT",
  "GOOD", "GOOG", "GPMT", "GPUS", "GRBK", "GREE", "GS", "GSL", "GUT", "HBAN", "HFRO", "HIG",
  "HL", "HLTC", "HNNA", "HOV", "HPE", "HPP", "HRZN", "HTGC", "HWC", "IIPR", "IMPP", "INBK",
  "INN", "IPCRE", "IVR", "JPM", "JXN", "KEY", "KIM", "KKR", "KMI", "KMPR", "KREF", "LAND",
  "LBRDA", "LFMD", "LFT", "LILA", "LNC", "LOB", "LUMN", "LXP", "MAA", "MBIN", "MCHP", "MDV",
  "MET", "METC", "MFA", "MFIC", "MFIN", "MHLD", "MITT", "MLCI", "MNSB", "MS", "MSBI", "MSTR",
  "MTB", "NAVI", "NCV", "NCZ", "NEE", "NEWT", "NGL", "NLY", "NMFC", "NOVT", "NREF", "NRUC",
  "NSA", "NTRS", "NXDT", "OCCI", "OFS", "ONB", "OPP", "ORCL", "OXLC", "OXSQ", "OZK", "PBI",
  "PCG", "PDCC", "PEB", "PFLT", "PFX", "PG", "PHXE", "PINE", "PMT", "PNFP", "POWW", "PRHI",
  "PRIF", "PRU", "PSA", "PSEC", "PW", "QXO", "RC", "REG", "REXR", "RF", "RGA", "RILY",
  "RITM", "RIV", "RLJ", "RNR", "RPT", "RWAY", "RWT", "SACH", "SAR", "SB", "SCHW", "SF",
  "SHO", "SIGI", "SLG", "SLM", "SLNH", "SMCI", "SO", "SOHO", "SPE", "SPG", "SPMC", "SQFT",
  "SR", "SRE", "SRG", "SSSS", "STRR", "STT", "SYF", "T", "TCBI", "TDS", "TEN", "TFC",
  "TFIN", "TMUS", "TPG", "TPTA", "TRIN", "TRP", "TRTX", "TVC", "TWO", "TY", "UMBF", "UMH",
  "UNM", "USB", "VLY", "VNO", "VOYA", "VSEC", "WAFD", "WAL", "WBS", "WFC", "WHF", "WHLR",
  "WHR", "WMT", "WRB", "WSBC", "WTFC", "WVVI", "XEL", "XOMA", "XRN", "ZION"
];

// The list every news source iterates over: CEFs + parent companies, de-duplicated
// (a few parents, like ACP or GAB, are CEFs already).
export const WATCHLIST = INCLUDE_PREF_PARENTS
  ? [...new Set([...CEF_WATCHLIST, ...PREF_PARENTS])]
  : CEF_WATCHLIST;

export const MAX_ITEMS_PER_TICKER = 6;      // was 15 — cut 2026-10-02 to stay inside the KV bandwidth limit
export const MAX_ITEM_AGE_DAYS = 21;        // headlines older than this are dropped when a source saves

// Company-name keywords for each parent. A headline is kept for a parent if it
// names the company (e.g. "Capital One"), or has its exact $CASHTAG, or — for
// tickers of 3+ letters that aren't ordinary words — the ticker as a whole word.
// Auto-generated from the sheet's company names (first two words, legal suffixes
// removed), with hand-picked names for 1–2 letter and very famous tickers.
export const PARENT_KEYWORDS = {
  ABR: ["Arbor Realty"], ABX: ["Abacus Global"], ACGL: ["Arch Capital"],
  ACP: ["abrdn Income"], ACR: ["ACRES Commercial"], AD: ["Array Digital"],
  ADAM: ["Adamas Trust"], ADC: ["Agree Realty"], AEG: ["Aegon"],
  AFG: ["American Financial Group"], AGM: ["Farmer Mac", "Federal Agricultural"], AGNC: ["AGNC Investment"],
  AHRT: ["AH Realty"], AHT: ["Ashford Hospitality"], AIG: ["American International Group", "AIG"],
  AIRT: ["Air T"], AIZ: ["Assurant"], ALB: ["Albemarle"],
  ALL: ["Allstate"], ALTG: ["Alta Equipment"], AMG: ["Affiliated Managers"],
  AMH: ["American Homes"], AOMR: ["Angel Oak"], AON: ["Aon"],
  APO: ["Apollo Global"], AQN: ["Algonquin Power"], ARES: ["Ares Management"],
  ARR: ["ARMOUR Residential"], ASB: ["Associated Banc-Corp"], ASST: ["Strive Inc", "Strive, Inc", "Strive Asset"],
  ATLC: ["Atlanticus"], AUB: ["Atlantic Union"], AXS: ["Axis Capital"],
  BA: ["Boeing"], BAC: ["Bank of America"], BAM: ["Brookfield Asset"],
  BANC: ["Banc of California"], BANF: ["Bancfirst"], BC: ["Brunswick"],
  BCV: ["Bancroft Fund"], BEP: ["Brookfield Renewable"], BFH: ["Bread Financial"],
  BFS: ["Saul Centers"], BHF: ["Brighthouse Financial"], BHR: ["Braemar Hotels"],
  BIP: ["Brookfield Infrastructure"], BIPC: ["Brookfield Infrastructure"], BMNR: ["BitMine Immersion"],
  BN: ["Brookfield Corp"], BNY: ["BNY"], BOH: ["Bank of Hawaii"],
  BPOP: ["Popular, Inc", "Popular Inc", "Banco Popular"], BRKR: ["Bruker"], BTSG: ["BrightSpring Health"],
  BUSE: ["First Busey"], BW: ["Babcock & Wilcox"], BWB: ["Bridgewater Bancshares"],
  C: ["Citigroup"], CCIF: ["Carlyle Credit"], CCNE: ["CNB Financial"],
  CDZI: ["Cadiz"], CFG: ["Citizens Financial"], CFR: ["Cullen Frost"],
  CFTR: ["Cantor Fitzgerald"], CG: ["Carlyle"], CHMI: ["Cherry Hill"],
  CHSCP: ["CHS"], CIM: ["Chimera Investment"], CION: ["CION Investment"],
  CLDT: ["Chatham Lodging"], CMRE: ["Costamare"], CMS: ["CMS Energy"],
  CNO: ["CNO Financial"], CNOB: ["ConnectOne Bancorp"], CODI: ["Compass Diversified"],
  COF: ["Capital One"], CTO: ["CTO Realty"], CTVA: ["Corteva"],
  CUBI: ["Customers Bancorp"], D: ["Dominion Energy"], DBRG: ["DigitalBridge"],
  DCOM: ["Dime Commercial"], DDS: ["Dillard's"], DHC: ["Diversified Healthcare"],
  DLNG: ["Dynagas LNG"], DLR: ["Digital Realty"], DSX: ["Diana Shipping"],
  DTE: ["DTE Energy"], DUK: ["Duke Energy"], DX: ["Dynex"],
  EARN: ["Ellington Credit"], ECC: ["Eagle Point Credit"], ECF: ["Ellsworth Growth"],
  EFC: ["Ellington Financial"], EFSC: ["Enterprise Financial"], EIC: ["Eagle Point Income"],
  EIX: ["Edison International"], EPIIF: ["Eagle Point Institutional"], EPR: ["EPR Properties"],
  EQH: ["Equitable Holdings"], ET: ["Energy Transfer"], ETR: ["Entergy"],
  EXC: ["Exelon"], F: ["Ford"], FBIO: ["Fortress Biotech"],
  FBRT: ["Franklin BSP"], FBYD: ["Falcon's Beyond"], FCNCA: ["First Citizens"],
  FG: ["F&G Annuities"], FGBI: ["First Guaranty"], FGNX: ["FG Nexus"],
  FHN: ["First Horizon"], FITB: ["Fifth Third"], FLG: ["Flagstar Bank"],
  FOUR: ["Shift4 Payments"], FRME: ["First Merchants"], FRT: ["Federal Realty"],
  FTAI: ["FTAI Aviation"], FULT: ["Fulton Financial"], GAB: ["Gabelli Equity"],
  GAIN: ["Gladstone Investment"], GAM: ["General American Investors"], GDV: ["Gabelli Dividend"],
  GECC: ["Great Elm Capital"], GEG: ["Great Elm Group"], GGN: ["GAMCO Global"],
  GGT: ["Gabelli Multimedia"], GL: ["Globe Life"], GLP: ["Global Partners"],
  GLU: ["Gabelli Global"], GNL: ["Global Net"], GNT: ["GAMCO Natural"],
  GOOD: ["Gladstone Commercial"], GOOG: ["Alphabet", "Google"], GPMT: ["Granite Point"],
  GPUS: ["Hyperscale Data"], GRBK: ["Green Brick"], GREE: ["Greenidge Generation"],
  GS: ["Goldman Sachs", "Goldman"], GSL: ["Global Ship"], GUT: ["Gabelli Utility"],
  HBAN: ["Huntington Bancshares"], HFRO: ["Highland Opportunities"], HIG: ["Hartford Insurance"],
  HL: ["Hecla"], HLTC: ["National Healthcare"], HNNA: ["Hennessy Advisors"],
  HOV: ["Hovnanian Enterprises"], HPE: ["Hewlett Packard Enterprise"], HPP: ["Hudson Pacific"],
  HRZN: ["Horizon Technology"], HTGC: ["Hercules Capital"], HWC: ["Hancock Whitney"],
  IIPR: ["Innovative Industrial"], IMPP: ["Imperial Petroleum"], INBK: ["First Internet"],
  INN: ["Summit Hotel"], IPCRE: ["InPoint Commercial"], IVR: ["Invesco Mortgage"],
  JPM: ["JPMorgan"], JXN: ["Jackson Financial"], KEY: ["KeyCorp"],
  KIM: ["Kimco Realty"], KKR: ["KKR"], KMI: ["Kinder Morgan"],
  KMPR: ["Kemper"], KREF: ["KKR Real"], LAND: ["Gladstone Land"],
  LBRDA: ["Liberty Broadband"], LFMD: ["LifeMD"], LFT: ["Lument Finance"],
  LILA: ["Liberty Latin"], LNC: ["Lincoln National"], LOB: ["Live Oak"],
  LUMN: ["Lumen Technologies"], LXP: ["LXP Industrial"], MAA: ["Mid-America Apartment"],
  MBIN: ["Merchants Bancorp"], MCHP: ["Microchip Technology"], MDV: ["Modiv Industrial"],
  MET: ["MetLife"], METC: ["Ramaco Resources"], MFA: ["MFA Financial"],
  MFIC: ["MidCap Financial"], MFIN: ["Medallion Financial"], MHLD: ["Kestrel Group"],
  MITT: ["TPG Mortgage"], MLCI: ["Mount Logan"], MNSB: ["MainStreet Bancshares"],
  MS: ["Morgan Stanley"], MSBI: ["Midland States"], MSTR: ["MicroStrategy", "Strategy Inc"],
  MTB: ["M&T Bank"], NAVI: ["Navient"], NCV: ["Virtus Convertible"],
  NCZ: ["Virtus Convertible"], NEE: ["NextEra"], NEWT: ["NewtekOne"],
  NGL: ["NGL Energy"], NLY: ["Annaly Capital"], NMFC: ["New Mountain"],
  NOVT: ["Novanta"], NREF: ["NexPoint Real"], NRUC: ["National Rural"],
  NSA: ["National Storage"], NTRS: ["Northern Trust"], NXDT: ["NexPoint Diversified"],
  OCCI: ["OFS Credit"], OFS: ["OFS Capital"], ONB: ["Old National"],
  OPP: ["RiverNorth/DoubleLine Strategic"], ORCL: ["Oracle"], OXLC: ["Oxford Lane"],
  OXSQ: ["Oxford Square"], OZK: ["Bank OZK"], PBI: ["Pitney Bowes"],
  PCG: ["PG&E"], PDCC: ["Pearl Diver"], PEB: ["Pebblebrook Hotel"],
  PFLT: ["PennantPark Floating"], PFX: ["PhenixFIN"], PG: ["Procter & Gamble"],
  PHXE: ["PHXE"], PINE: ["Alpine Income"], PMT: ["Pennymac Mortgage"],
  PNFP: ["Pinnacle Financial"], POWW: ["Outdoor Holding", "AMMO Inc"], PRHI: ["Presurance"],
  PRIF: ["Priority Income"], PRU: ["Prudential"], PSA: ["Public Storage"],
  PSEC: ["Prospect Capital"], PW: ["Power REIT"], QXO: ["QXO"],
  RC: ["Ready Capital"], REG: ["Regency Centers"], REXR: ["Rexford Industrial"],
  RF: ["Regions Financial"], RGA: ["Reinsurance Group of America"], RILY: ["B. Riley", "BRC Group"],
  RITM: ["Rithm Capital"], RIV: ["RiverNorth Opportunities"], RLJ: ["RLJ Lodging"],
  RNR: ["RenaissanceRe"], RPT: ["Rithm Property"], RWAY: ["Runway Growth"],
  RWT: ["Redwood Trust"], SACH: ["Sachem Capital"], SAR: ["Saratoga Investment"],
  SB: ["Safe Bulkers"], SCHW: ["Charles Schwab", "Schwab"], SF: ["Stifel"],
  SHO: ["Sunstone Hotel"], SIGI: ["Selective Insurance"], SLG: ["SL Green"],
  SLM: ["SLM"], SLNH: ["Soluna"], SMCI: ["Super Micro"],
  SO: ["Southern Company", "Southern Co"], SOHO: ["Sotherly Hotels"], SPE: ["Special Opportunities"],
  SPG: ["Simon Property"], SPMC: ["Sound Point"], SQFT: ["Presidio Property"],
  SR: ["Spire"], SRE: ["Sempra"], SRG: ["Seritage Growth"],
  SSSS: ["SuRo Capital"], STRR: ["Star Equity"], STT: ["State Street"],
  SYF: ["Synchrony Financial"], T: ["AT&T"], TCBI: ["Texas Capital"],
  TDS: ["Telephone and Data Systems"], TEN: ["Tsakos Energy"], TFC: ["Truist Financial"],
  TFIN: ["Triumph Financial"], TMUS: ["T-Mobile"], TPG: ["TPG"],
  TPTA: ["Terra Property"], TRIN: ["Trinity Capital"], TRP: ["TC Energy"],
  TRTX: ["TPG RE"], TVC: ["Tennessee Valley"], TWO: ["Two Harbors"],
  TY: ["Tri-Continental"], UMBF: ["UMB Financial"], UMH: ["UMH Properties"],
  UNM: ["Unum"], USB: ["U.S. Bancorp", "US Bancorp"], VLY: ["Valley National"],
  VNO: ["Vornado Realty"], VOYA: ["Voya Financial"], VSEC: ["VSE"],
  WAFD: ["WaFd"], WAL: ["Western Alliance"], WBS: ["Webster Financial"],
  WFC: ["Wells Fargo"], WHF: ["WhiteHorse Finance"], WHLR: ["Wheeler Real"],
  WHR: ["Whirlpool"], WMT: ["Walmart"], WRB: ["W. R. Berkley", "W.R. Berkley", "Berkley"],
  WSBC: ["Wesbanco"], WTFC: ["Wintrust Financial"], WVVI: ["Willamette Valley"],
  XEL: ["Xcel Energy"], XOMA: ["XOMA Royalty"], XRN: ["Chiron Real"],
  ZION: ["Zions Bancorporation"]
};

// Parent tickers that are also everyday English words or names — for these the
// bare ticker is NOT enough; the headline must name the company or use the $CASHTAG.
const AMBIGUOUS_PARENT_TICKERS = new Set([
  "ADAM", "ALL", "EARN", "GAIN", "GOOD", "INN", "KEY", "KIM", "LAND", "LOB",
  "MET", "NEWT", "PINE", "SOHO", "TEN", "TWO", "WAL"
]);

// One or more distinctive keywords from each fund's REAL name. For tickers
// prone to collision (short words, or a same-ticker company on another
// exchange), an article must contain one of these keywords in addition to
// the ticker itself — the ticker match alone isn't trusted for these.
// Sourced directly from official fund names seen in real Yahoo/SEC articles
// during testing (2026-09-22). AVK and JRI are the two exceptions filled
// from general knowledge rather than a confirmed article in that test run —
// worth double-checking those two if you see odd results.
export const FUND_KEYWORDS = {
  USA:  ["Liberty All-Star Equity"],
  UTG:  ["Reaves Utility"],
  UTF:  ["Cohen & Steers Infrastructure"],
  DNP:  ["DNP Select"],
  BUI:  ["BlackRock Utility", "Utility, Infrastructure & Power", "Utility Infrastructure & Power"],
  MEGI: ["NYLIM", "CBRE Global Infrastructure Megatrends"],
  GLU:  ["Gabelli Global Utility"],
  DPG:  ["Duff & Phelps Utility"],
  ERH:  ["Allspring Utilities"],
  PEO:  ["Adams Natural Resources"],
  BGR:  ["BlackRock Energy and Resources"],
  NXG:  ["NXG NextGen Infrastructure"],
  EMO:  ["ClearBridge Energy Midstream"],
  BCX:  ["BlackRock Resources"],
  RQI:  ["Cohen & Steers Quality Income Realty"],
  RNP:  ["Cohen & Steers REIT and Preferred"],
  RFI:  ["Cohen & Steers Total Return Realty"],
  JRS:  ["Nuveen Real Estate Income"],
  JRI:  ["Nuveen Real Asset"], // best-known name, not confirmed in test data — this ticker was the most polluted, verify results
  AWP:  ["abrdn Global Premier Properties", "Aberdeen Global Premier Properties"],
  THW:  ["abrdn World Healthcare", "Aberdeen World Healthcare"],
  THQ:  ["abrdn Healthcare Opportunities", "Aberdeen Healthcare Opportunities"],
  HQH:  ["abrdn Healthcare Investors", "Tekla Healthcare Investors"],
  HQL:  ["abrdn Life Sciences", "Tekla Life Sciences"],
  BMEZ: ["BlackRock Health Sciences Term Trust"],
  BME:  ["BlackRock Health Sciences Trust"],
  PDX:  ["PIMCO Dynamic Income"],
  GNT:  ["GAMCO Natural Resources"],
  GGN:  ["GAMCO Global Gold"],
  BCV:  ["Bancroft Fund"],
  TY:   ["Tri-Continental", "Tri Continental"],
  STK:  ["Columbia Seligman Premium Technology"],
  ETO:  ["Eaton Vance Tax-Advantage", "Eaton Vance Tax-Advantaged Global Dividend Opp"],
  LGI:  ["Lazard Global Total Return"],
  BST:  ["BlackRock Science and Technology Trust"],
  BSTZ: ["BlackRock Science and Technology Trust II"],
  GDV:  ["Gabelli Dividend"],
  NIE:  ["Virtus Equity & Convertible Income", "AllianzGI Equity & Convertible"],
  CCD:  ["Calamos Dynamic Convertible"],
  AIO:  ["Virtus Artificial Intelligence"],
  RMT:  ["Royce Micro-Cap"],
  RVT:  ["Royce Small-Cap", "Royce Value Trust"],
  NCZ:  ["Virtus Convertible & Income Fund II"],
  AVK:  ["Advent Convertible", "Advent Claymore"], // best-known name, verify results
  ECAT: ["BlackRock ESG Capital Allocation"],
  NBXG: ["Neuberger Berman Next Generation Connectivity"],
  BCAT: ["BlackRock Capital Allocation Term Trust"],
  ETB:  ["Eaton Vance Tax-Managed Buy-Write Income"],
  SPXX: ["Nuveen S&P 500 Dynamic Overwrite"],
  JCE:  ["Nuveen Core Equity Alpha"],
  RIV:  ["RiverNorth Opportunities"],
  ETG:  ["Eaton Vance Tax-Advantaged Global Dividend Income"],
  AGD:  ["abrdn Global Dynamic Dividend", "Aberdeen Global Dynamic Dividend"],
  NFJ:  ["Virtus Dividend, Interest & Premium Strategy"],
  BTX:  ["BlackRock Technology and Private Equity Term Trust"],
  ETY:  ["Eaton Vance Tax-Managed Diversified Equity Income"],
  CHI:  ["Calamos Convertible Opportunities and Income"],
  GLQ:  ["Clough Global Equity"],
  ETV:  ["Eaton Vance Buy-Write Fund", "Eaton Vance Tax-Managed Buy-Write Opportunities"],
  ETW:  ["Eaton Vance Tax-Managed Global Buy-Write"],
  ETJ:  ["Eaton Vance Risk-Managed Diversified Equity Income"],
  ADX:  ["Adams Diversified Equity"],
  ASG:  ["Liberty All-Star Growth"],
  AOD:  ["abrdn Total Dynamic Dividend", "Aberdeen Total Dynamic Dividend"],
  EOI:  ["Eaton Vance Enhanced Equity Income Fund"],
  FT:   ["Franklin Universal Trust"],
  CHW:  ["Calamos Global Dynamic Income"],
  GAB:  ["Gabelli Equity Trust"],
  EOS:  ["Eaton Vance Enhanced Equity Income Fund II"],
  EXG:  ["Eaton Vance Tax-Managed Global Diversified Equity Income"],
  CSQ:  ["Calamos Strategic Total Return"],
  CPZ:  ["Calamos Long/Short Equity"],
  NMAI: ["Nuveen Multi-Asset Income"],
  BOE:  ["BlackRock Enhanced Global Dividend"],
  CLM:  ["Cornerstone Strategic Investment"],
  CRF:  ["Cornerstone Total Return"],
  CHY:  ["Calamos Convertible & High Income", "Calamos Convertible and High Income"],
  FFA:  ["First Trust Enhanced Equity Income"],
  ACV:  ["Virtus AllianzGI Diversified Income"],
  QQQX: ["Nuveen NASDAQ 100"],
  BTO:  ["John Hancock Financial Opportunities"],
  SCD:  ["LMP Capital and Income"],
  CII:  ["BlackRock Enhanced Large Cap Core"],
  NCV:  ["Virtus Convertible & Income Fund"],
  CGO:  ["Calamos Global Total Return"],
  STEW: ["SRH Total Return"]
};

export async function fetchText(url, timeoutMs = 8000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        ...extraHeaders
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1];
    if (title && link) {
      items.push({
        title: title.replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
        link: link.trim(),
        pubDate: pubDate ? new Date(pubDate).toISOString() : null,
        source: source ? source.trim() : null
      });
    }
  }
  return items;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Rejects items that aren't actually about this specific fund / company. See
// the RELEVANCE FILTER note above for the reasoning.
export function isRelevant(item, ticker) {
  // SEC EDGAR items come straight from the filer's own official CIK — never a
  // keyword search — so they're inherently correct and always kept.
  if (item.source === "SEC EDGAR") return true;

  const text = `${item.title || ""}`;

  // StockTwits "shotgun" posts naming a pile of unrelated tickers in one
  // message aren't really about any single one of them — drop those.
  const cashtags = text.match(/\$[A-Z]{1,6}\b/g) || [];
  if (cashtags.length > 4 && !cashtags.includes(`$${ticker}`)) return false;

  const hasTickerWord = new RegExp(`(^|[^A-Za-z])${ticker}([^A-Za-z]|$)`).test(text);
  const hasCashtag = text.includes(`$${ticker}`);
  const hasTicker = hasTickerWord || hasCashtag;

  const keywords = FUND_KEYWORDS[ticker];
  if (keywords) {
    // Known-ambiguous ticker: require the fund's actual name, not just the
    // ticker letters, since the ticker alone collides with something else.
    return keywords.some(k => text.toLowerCase().includes(k.toLowerCase()));
  }

  // Preferred-stock parent company (e.g. COF): keep it if the headline names
  // the company (whole words, so "Ford" doesn't match "afford"), or has the
  // exact $CASHTAG ("$C" must not match "$COF"), or — for 3+ letter tickers
  // that aren't ordinary words — the ticker as a whole word.
  const parentKeywords = PARENT_KEYWORDS[ticker];
  if (parentKeywords) {
    const namesCompany = parentKeywords.some(k =>
      new RegExp(`(^|[^A-Za-z])${escapeRegex(k)}([^A-Za-z]|$)`, "i").test(text));
    if (namesCompany) return true;
    if (new RegExp(`\\$${ticker}(?![A-Za-z])`).test(text)) return true;
    return ticker.length >= 3 && !AMBIGUOUS_PARENT_TICKERS.has(ticker) && hasTickerWord;
  }

  return hasTicker;
}

// Reads this source's existing saved data, merges in freshly-fetched items
// per ticker (filtered for relevance, deduped by link, keeping the most
// recent MAX_ITEMS_PER_TICKER), and saves it back — all scoped to this ONE
// source's own key.
//
// BANDWIDTH (2026-10-02): every save also trims ALL tickers (max items, max
// age, tickers no longer watched), and the key is only written back when
// something actually changed — most 5/30-minute runs find nothing new, and
// re-uploading the whole file each time was the main KV bandwidth cost.
export async function mergeAndSaveSource(sourceName, itemsByTicker) {
  const key = `news:source:${sourceName}`;
  const existing = (await kv.get(key)) || {};
  const updated = {};
  const cutoff = new Date(Date.now() - MAX_ITEM_AGE_DAYS * 86400000).toISOString();
  const watched = new Set(WATCHLIST);
  let newItemCount = 0, trimmed = false;

  // 1) trim what's already stored
  for (const ticker of Object.keys(existing)) {
    if (!watched.has(ticker)) { trimmed = true; continue; }
    const items = (existing[ticker]?.items || []);
    const kept = items.filter(i => !i.pubDate || i.pubDate >= cutoff).slice(0, MAX_ITEMS_PER_TICKER);
    if (kept.length !== items.length) trimmed = true;
    if (kept.length) updated[ticker] = { items: kept, lastChecked: existing[ticker].lastChecked };
    else trimmed = true;
  }

  // 2) merge in fresh items
  for (const ticker of Object.keys(itemsByTicker)) {
    const rawItems = itemsByTicker[ticker];
    if (!rawItems || rawItems.length === 0) continue;
    const items = rawItems.filter(i => isRelevant(i, ticker) && (!i.pubDate || i.pubDate >= cutoff));
    if (items.length === 0) continue;

    const existingLinks = new Set((updated[ticker]?.items || []).map(i => i.link));
    const freshItems = items.filter(i => i.link && !existingLinks.has(i.link));
    if (!freshItems.length) continue;
    const merged = [...freshItems, ...(updated[ticker]?.items || [])]
      .sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || ""))
      .slice(0, MAX_ITEMS_PER_TICKER);
    const oldLinks = new Set((updated[ticker]?.items || []).map(i => i.link));
    newItemCount += merged.filter(i => !oldLinks.has(i.link)).length;
    updated[ticker] = { items: merged, lastChecked: new Date().toISOString() };
  }

  // 3) write back only if something changed
  if (newItemCount > 0 || trimmed) await kv.set(key, updated);
  return newItemCount;
}
