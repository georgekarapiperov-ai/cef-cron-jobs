"""Full holdings for every CEF from SEC N-PORT filings.

    py jobs\\holdings_sec.py                      all funds (only re-downloads funds with a new filing)
    py jobs\\holdings_sec.py --tickers UTF,CHI    just these
    py jobs\\holdings_sec.py --force              re-download every filing

Steps per fund:
  1. ticker -> SEC CIK (company_tickers.json; overrides in jobs/sec_overrides.json for misses)
  2. latest NPORT-P (or amendment) from the submissions API; its primary_doc.xml has EVERY holding
     (name, CUSIP, ISIN, balance, value, % of net assets, asset type) + fund totals -> leverage = totAssets / netAssets
  3. CUSIP/ISIN -> ticker with OpenFIGI (cached in figi-cache.json; free, no key needed — a key just makes it faster)
     convertible bonds -> the common stock they convert into (N-PORT names it), so they can be priced like that stock
  4. classify: equity / preferred / fund (priceable with a ticker), bond / loan / ABS (priced by a proxy ETF),
     derivative / cash (excluded but shown), private (shown, no price)

Output (in --out, default jobs/out/):  holdings-sec.json.gz (every fund, every holding),
  holdings-sec-index.json (one summary line per fund, no holdings), figi-cache.json
Rules: SEC max 10 requests/s with a User-Agent naming the person (we use 8/s). A fund that fails keeps its previous
record — good data is never replaced by worse data.
"""
import argparse
import asyncio
import gzip
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from holdings_diff import diff_lists  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SEC_RPS = 8
FIGI_URL = "https://api.openfigi.com/v3/mapping"

# Bloomberg exchange code (OpenFIGI exchCode) -> Yahoo suffix, for the listings we can price.
YAHOO_SUFFIX = {
    "US": "", "CN": ".TO", "CT": ".TO", "CV": ".V", "LN": ".L", "GR": ".DE", "GY": ".DE", "FP": ".PA", "IM": ".MI",
    "SM": ".MC", "NA": ".AS", "BB": ".BR", "SW": ".SW", "SE": ".SW", "SS": ".ST", "DC": ".CO", "NO": ".OL", "FH": ".HE",
    "ID": ".IR", "PL": ".LS", "AV": ".VI", "JP": ".T", "JT": ".T", "HK": ".HK", "AU": ".AX", "AT": ".AX", "NZ": ".NZ",
    "SP": ".SI", "KS": ".KS", "KQ": ".KQ", "TT": ".TW", "TP": ".TWO", "IN": ".NS", "IB": ".BO", "IS": ".NS", "BZ": ".SA",
    "MM": ".MX", "CI": ".SN", "SJ": ".JO", "TB": ".BK", "IJ": ".JK", "MK": ".KL", "PM": ".PS", "C1": ".SS", "CG": ".SS",
    "CS": ".SZ", "TI": ".IS", "AB": ".SR", "IT": ".TA", "PW": ".WA", "GA": ".AT", "CP": ".PR", "HB": ".BD",
}
# Home exchange to prefer for a security from this country (OpenFIGI lists many venues; the first is often German).
HOME_EXCH = {"US": ["US"], "CA": ["CN", "CT"], "GB": ["LN"], "DE": ["GY", "GR"], "FR": ["FP"], "IT": ["IM"], "ES": ["SM"],
             "NL": ["NA"], "BE": ["BB"], "CH": ["SW", "SE"], "SE": ["SS"], "DK": ["DC"], "NO": ["NO"], "FI": ["FH"],
             "IE": ["ID", "LN"], "PT": ["PL"], "AT": ["AV"], "JP": ["JT", "JP"], "HK": ["HK"], "AU": ["AT", "AU"],
             "NZ": ["NZ"], "SG": ["SP"], "KR": ["KS", "KQ"], "TW": ["TT", "TP"], "IN": ["IS", "IN", "IB"], "BR": ["BZ"],
             "MX": ["MM"], "CL": ["CI"], "ZA": ["SJ"], "TH": ["TB"], "ID": ["IJ"], "MY": ["MK"], "PH": ["PM"],
             "CN": ["C1", "CG", "CS", "HK"], "TR": ["TI"], "SA": ["AB"], "IL": ["IT"], "PL": ["PW"], "GR": ["GA"]}

# N-PORT asset categories
DERIV = {"DIR", "DCR", "DFE", "DE", "DO", "DCO"}
CASHLIKE = {"STIV", "RA"}


def sec_user_agent():
    ua = os.environ.get("SEC_USER_AGENT")
    if ua:
        return ua
    f = ROOT / "secrets.txt"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            k, _, v = line.partition("=")
            if k.strip() == "SEC_CONTACT" and v.strip():
                return f"CEF-Desk george {v.strip()}"
    raise SystemExit("SEC needs a contact in the User-Agent: set SEC_USER_AGENT, or SEC_CONTACT=<email> in secrets.txt")


def figi_key():
    if os.environ.get("OPENFIGI_API_KEY"):
        return os.environ["OPENFIGI_API_KEY"]
    f = ROOT / "secrets.txt"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            k, _, v = line.partition("=")
            if k.strip() == "OPENFIGI_API_KEY" and v.strip():
                return v.strip()
    return None


class Sec:
    """SEC client: polite rate limit, retries on 429/5xx."""
    def __init__(self, ua):
        self.c = httpx.AsyncClient(headers={"User-Agent": ua, "Accept-Encoding": "gzip, deflate"}, timeout=60,
                                   follow_redirects=True)
        self.lock = asyncio.Lock()
        self.next_at = 0.0

    async def get(self, url):
        for attempt in range(4):
            async with self.lock:
                wait = self.next_at - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
                self.next_at = time.monotonic() + 1 / SEC_RPS
            try:
                r = await self.c.get(url)
            except httpx.HTTPError:
                await asyncio.sleep(2 * (attempt + 1))
                continue
            if r.status_code == 429 or r.status_code >= 500:
                await asyncio.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            return r
        raise RuntimeError(f"SEC gave up after retries: {url}")


# ---------------- N-PORT XML ----------------
def _t(el, path):
    """Text of the first matching child path (namespace-agnostic), e.g. 'debtSec/maturityDt'."""
    cur = el
    for part in path.split("/"):
        if cur is None:
            return None
        cur = next((c for c in cur if isinstance(c.tag, str) and etree.QName(c).localname == part), None)
    return cur.text.strip() if cur is not None and cur.text else None


def _ids(el):
    out = {}
    idents = next((c for c in el if isinstance(c.tag, str) and etree.QName(c).localname == "identifiers"), None)
    if idents is not None:
        for c in idents:
            if not isinstance(c.tag, str):
                continue
            name = etree.QName(c).localname
            if name in ("isin", "ticker", "cusip") and c.get("value"):
                out[name] = c.get("value").strip()
            elif name == "other" and c.get("value"):
                out.setdefault("other", c.get("value").strip())
    return out


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def parse_nport(xml_bytes):
    root = etree.fromstring(xml_bytes)
    def find_all(name):
        return root.iter("{*}" + name)
    def first(name):
        return next(find_all(name), None)
    gen = first("genInfo")
    fund = first("fundInfo")
    out = {
        "regName": _t(gen, "regName") if gen is not None else None,
        "seriesName": _t(gen, "seriesName") if gen is not None else None,
        "seriesId": _t(gen, "seriesId") if gen is not None else None,
        "asOf": _t(gen, "repPdDate") if gen is not None else None,
        "totAssets": _f(_t(fund, "totAssets")) if fund is not None else None,
        "totLiabs": _f(_t(fund, "totLiabs")) if fund is not None else None,
        "netAssets": _f(_t(fund, "netAssets")) if fund is not None else None,
        "holdings": [],
    }
    for el in find_all("invstOrSec"):
        ids = _ids(el)
        cusip = _t(el, "cusip")
        h = {
            "name": _t(el, "name"), "title": _t(el, "title"),
            "cusip": cusip if cusip and cusip not in ("N/A", "000000000") else None,
            "isin": ids.get("isin"), "tkr": ids.get("ticker"),
            "bal": _f(_t(el, "balance")), "units": _t(el, "units"), "cur": _t(el, "curCd"),
            "usd": _f(_t(el, "valUSD")), "pct": _f(_t(el, "pctVal")),
            "payoff": _t(el, "payoffProfile"), "cat": _t(el, "assetCat"), "iss": _t(el, "issuerCat"),
            "ctry": _t(el, "invCountry"), "restricted": _t(el, "isRestrictedSec") == "Y",
            "fv": _t(el, "fairValLevel"),
        }
        if h["cat"] is None:   # "other" category: <assetConditional desc=...>
            ac = next((c for c in el.iter("{*}assetConditional")), None)
            h["cat"] = "OTHER" if ac is None else ("OTHER:" + (ac.get("desc") or ""))
        if h["iss"] is None:
            ic = next((c for c in el.iter("{*}issuerConditional")), None)
            h["iss"] = "OTHER" if ic is None else ("OTHER:" + (ic.get("desc") or ""))
        debt = next((c for c in el if isinstance(c.tag, str) and etree.QName(c).localname == "debtSec"), None)
        if debt is not None:
            h["mat"] = _t(debt, "maturityDt")
            h["cpn"] = _f(_t(debt, "annualizedRt"))
            h["default"] = _t(debt, "isDefault") == "Y"
            ref = next(debt.iter("{*}dbtSecRefInstrument"), None)
            if ref is not None:            # convertible: the stock it converts into
                rids = _ids(ref)
                ci = next(debt.iter("{*}currencyInfo"), None)
                h["conv"] = {"name": _t(ref, "name"), "cusip": rids.get("cusip"), "isin": rids.get("isin"),
                             "tkr": rids.get("ticker"), "ratio": _f(ci.get("convRatio")) if ci is not None else None}
        out["holdings"].append(h)
    return out


# ---------------- OpenFIGI ----------------
class Figi:
    def __init__(self, cache_path):
        self.path = cache_path
        self.cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
        self.key = figi_key()
        self.batch = 100 if self.key else 10
        self.per_min = 250 if self.key else 25         # keyed limit is 25 per 6 s
        self.c = httpx.AsyncClient(timeout=60, headers={"Content-Type": "application/json",
                                                         **({"X-OPENFIGI-APIKEY": self.key} if self.key else {})})
        self.sent = []
        self.calls = 0

    @staticmethod
    def job_key(kind, value):
        return f"{kind}:{value}"

    async def _post(self, jobs):
        while True:
            now = time.monotonic()
            self.sent = [t for t in self.sent if now - t < 60]
            if len(self.sent) < self.per_min:
                break
            await asyncio.sleep(61 - (now - self.sent[0]))
        self.sent.append(time.monotonic())
        self.calls += 1
        r = await self.c.post(FIGI_URL, json=jobs)
        if r.status_code == 429:
            await asyncio.sleep(int(r.headers.get("ratelimit-reset", "60")) + 1)
            return await self._post(jobs)
        r.raise_for_status()
        return r.json()

    async def resolve(self, wanted, progress=None):
        """wanted: set of (kind, value), kind in ID_CUSIP / ID_ISIN. Fills the cache."""
        todo = [w for w in wanted if self.job_key(*w) not in self.cache]
        for i in range(0, len(todo), self.batch):
            chunk = todo[i:i + self.batch]
            res = await self._post([{"idType": k[4:], "idValue": v, "exchCode": "US"} if k.startswith("USX:")
                                    else {"idType": k, "idValue": v} for k, v in chunk])
            for (k, v), r in zip(chunk, res):
                listings = [{"t": d.get("ticker"), "ex": norm_exch(d.get("exchCode")), "type": d.get("securityType"),
                             "type2": d.get("securityType2"), "sector": d.get("marketSector"), "name": d.get("name")}
                            for d in (r.get("data") or [])]
                # keep every listing on an exchange we can price (ONEOK's US line was the 50th venue) + a few others
                others = [l for l in listings if l["ex"] not in YAHOO_SUFFIX]
                self.cache[self.job_key(k, v)] = ([l for l in listings if l["ex"] in YAHOO_SUFFIX] + others[:3]
                                                  + [l for l in others[3:] if l["t"] and re.fullmatch(r"[A-Z]{1,5}", l["t"])][:2])
            if progress and (i // self.batch) % 20 == 0:
                progress(f"OpenFIGI {min(i + self.batch, len(todo))}/{len(todo)} codes")
            if (i // self.batch) % 25 == 0:
                self.save()
        self.save()
        return len(todo)

    def _us_candidate(self, kind, value):
        """OpenFIGI sometimes links a US CUSIP only to European lines (ONEOK -> 'OKE' on ER). Plain ticker to retry on US."""
        listings = self.cache.get(self.job_key(kind, value)) or []
        if any(l["ex"] == "US" for l in listings):
            return None
        plain = sorted({l["t"] for l in listings if l["t"] and re.fullmatch(r"[A-Z]{1,5}", l["t"])}, key=len)
        name = next((l["name"] for l in listings if l.get("name")), None)
        return [(t, name) for t in plain[:3]] or None

    async def resolve_us_fallback(self, wanted):
        """Second pass for US codes without a US listing: look the plain ticker up on US exchanges; same company name only."""
        todo = {}
        for k, v in wanted:
            if k.startswith("USX:"):
                continue
            if k in ("ID_CUSIP", "ID_CINS") or (k == "ID_ISIN" and v.startswith("US")):
                for t, name in self._us_candidate(k, v) or []:
                    if f"US:{t}" not in self.cache:
                        todo[t] = name
        items = list(todo.items())
        for i in range(0, len(items), self.batch):
            chunk = items[i:i + self.batch]
            res = await self._post([{"idType": "TICKER", "idValue": t, "exchCode": "US"} for t, _ in chunk])
            for (t, name), r in zip(chunk, res):
                hit = next((d for d in (r.get("data") or []) if same_company(d.get("name"), name)), None)
                self.cache[f"US:{t}"] = hit["ticker"] if hit else ""
        self.save()
        return len(items)

    def save(self):
        self.path.write_text(json.dumps(self.cache, separators=(",", ":")), encoding="utf-8")

    def us_ticker(self, kind, value):
        """The US listing from a US-filtered lookup (None if the security has no US line)."""
        for l in self.cache.get(self.job_key("USX:" + kind, value)) or []:
            t = l["t"] or ""
            if l["ex"] == "US" and t and not (len(t) == 5 and t.endswith("F")):   # WMMVF = OTC copy, not a listing
                return yahoo_ticker(t, "US")
        return None

    def ticker(self, kind, value, country):
        """Best Yahoo ticker for a code, preferring the home-country listing."""
        listings = self.cache.get(self.job_key(kind, value)) or []
        if not listings:
            return None, None
        prefs = HOME_EXCH.get(country or "US", []) + ["US"]
        pick = None
        for ex in prefs:
            pick = next((l for l in listings if l["ex"] == ex and l["t"]), None)
            if pick:
                break
        if not pick:
            pick = next((l for l in listings if l["ex"] in YAHOO_SUFFIX and l["t"]), None)
        if not pick or (country or "US") == "US" and pick["ex"] != "US":
            for t, _ in (self._us_candidate(kind, value) or []) if (country or "US") == "US" else []:
                us = self.cache.get(f"US:{t}")
                if us:
                    return yahoo_ticker(us, "US"), {"t": us, "ex": "US", "via": "ticker fallback"}
        if not pick:
            return None, listings[0]
        return yahoo_ticker(pick["t"], pick["ex"]), pick


def same_company(a, b):
    """'EXXON MOBIL CORP' == 'EXXONMOBIL HOLDINGS CORP' (Exxon's 2026 holding-company reorganisation)."""
    drop = r"\b(corp|corporation|inc|incorporated|holdings?|co|company|ltd|limited|plc|the|group|com|new)\b"
    norm = lambda s: re.sub(r"[^a-z]", "", re.sub(drop, "", (s or "").lower()))  # noqa: E731
    x, y = norm(a), norm(b)
    return bool(x and y) and (x == y or (min(len(x), len(y)) >= 5 and (x.startswith(y) or y.startswith(x))))


def cusip_kind(c):
    """US CUSIPs start with a digit; foreign-issuer CINS codes (Medtronic G5960L103) start with a letter."""
    return "ID_CINS" if c and c[0].isalpha() else "ID_CUSIP"


def norm_exch(ex):
    """OpenFIGI sometimes answers 'TT (Taiwan Stock Exchange)' instead of 'TT'."""
    return (ex or "").split(" (")[0].strip() or None


PREFS_PATH = ROOT / "app" / "data" / "prefs.json"


def load_pref_cusips():
    """CUSIP -> Yahoo symbol from George's preferreds list (OpenFIGI only gives Bloomberg names for prefs)."""
    f = PREFS_PATH
    if not f.exists():
        return {}
    return {p["cusip"].upper(): p["ysym"] for p in json.loads(f.read_text(encoding="utf-8")) if p.get("cusip") and p.get("ysym")}


def yahoo_ticker(t, ex):
    t = t.strip().upper()
    suf = YAHOO_SUFFIX.get(ex)
    if suf is None:
        return None
    if " " in t:                       # e.g. "SO 4.2 PRA" — not a plain listing we can price
        return None
    t = t.rstrip("/").rstrip("*").replace("/", "-")
    if suf == "" and re.fullmatch(r"[A-Z]+\.[A-Z]", t):
        t = t.replace(".", "-")                       # BRK.B -> BRK-B
    if suf == ".HK" and t.isdigit():
        t = t.zfill(4)
    if suf in (".L",) and t.endswith("."):
        t = t[:-1]
    return t + suf


# ---------------- classification ----------------
def classify(h):
    """Returns (cls, proxy). cls: equity / preferred / fund / bond / loan / abs / derivative / cash / private / other."""
    cat, iss = (h.get("cat") or ""), (h.get("iss") or "")
    name = (h.get("name") or "") + " " + (h.get("title") or "")
    if cat in DERIV:
        return "derivative", None
    if cat in CASHLIKE or (cat == "OTHER" and re.search(r"\bcash\b", name, re.I)):
        return "cash", None
    if iss == "PF":
        return "private", None
    if cat == "EC":
        if iss == "RF":
            return "fund", None
        if h.get("restricted") and h.get("fv") == "3":
            return "private", None
        return "equity", None
    if cat == "EP":
        if h.get("restricted") and h.get("fv") == "3":
            return "private", None
        return "preferred", "PFF"
    if cat == "LON":
        return "loan", "BKLN"
    if cat.startswith("ABS"):
        return "abs", "MBB" if "MBS" in cat else ("BKLN" if "CBDO" in cat else "LQD")
    if cat in ("DBT", "SN"):
        if h.get("conv"):
            return "convertible", None
        if iss == "MUN":
            return "bond", "MUB"
        if iss in ("UST", "USGA"):
            return "bond", "TLT" if (h.get("mat") or "") > _years_from_now(10) else "IEF"
        if iss == "USGSE":
            return "bond", "MBB"
        if iss == "NUSS":
            return "bond", "EMB"
        cpn = h.get("cpn")
        return "bond", ("HYG" if (cpn is not None and cpn >= 6.0) else "LQD")
    if cat == "RE":
        return "private", None
    return "other", None


def _years_from_now(n):
    d = datetime.now(timezone.utc)
    return f"{d.year + n}-{d.month:02d}-{d.day:02d}"


def name_tokens(s):
    stop = {"fund", "inc", "the", "trust", "income", "&", "and", "of", "co", "corp", "llc", "closed", "end", "term",
            "fd", "tr", "opportunities", "opportunity", "total", "return", "strategy", "strategies", "global"}
    return {w for w in re.findall(r"[a-z0-9]+", (s or "").lower()) if w not in stop and len(w) > 1}


# ---------------- per fund ----------------
async def latest_nport(sec, cik, want_series=None, fund_name=None):
    """Newest NPORT-P/NPORT-P/A for this CIK (and series, for multi-fund trusts)."""
    sub = (await sec.get(f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json")).json()
    r = sub["filings"]["recent"]
    rows = [{"form": f, "acc": r["accessionNumber"][i], "filed": r["filingDate"][i], "rep": r["reportDate"][i]}
            for i, f in enumerate(r["form"]) if f in ("NPORT-P", "NPORT-P/A")]
    if not rows:
        return None, sub.get("name")
    rows.sort(key=lambda x: (x["rep"], x["filed"]), reverse=True)
    top_rep = rows[0]["rep"]
    same = [x for x in rows if x["rep"] == top_rep]
    single = len({x["acc"] for x in same if x["form"] == "NPORT-P"}) <= 1 and not want_series
    if single:
        return {"cik": int(cik), **rows[0]}, sub.get("name")
    # several series file under this CIK: open the newest filings until the series (or the name) matches
    best, best_score = None, -1
    for x in rows[:12]:
        xml = await fetch_xml(sec, cik, x["acc"])
        p = parse_nport(xml)
        if want_series and p["seriesId"] == want_series:
            return {"cik": int(cik), **x, "_parsed": p}, sub.get("name")
        if not want_series:
            score = len(name_tokens(fund_name) & name_tokens(p["seriesName"]))
            if score > best_score:
                best, best_score = {"cik": int(cik), **x, "_parsed": p}, score
    return best, sub.get("name")


async def fetch_xml(sec, cik, acc):
    return (await sec.get(f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc.replace('-', '')}/primary_doc.xml")).content


async def process_fund(sec, fund, cikmap, overrides, prev, force):
    t = fund["ticker"]
    ov = overrides.get(t) or {}
    info = cikmap.get(t)
    cik = ov.get("cik") or (info or {}).get("cik")
    series = ov.get("seriesId") or (info or {}).get("seriesId")
    if not cik:
        return {"error": "ticker not in SEC company list (add it to jobs/sec_overrides.json)"}
    filing, company = await latest_nport(sec, cik, series, fund["name"])
    if not filing:
        return {"error": f"no N-PORT filings for CIK {cik} ({company}) — not a registered fund that files N-PORT"}
    if (filing.get("rep") or "") < _years_from_now(-1):     # NXDT: became a REIT in 2022, last N-PORT is from then
        return {"error": f"last N-PORT is as of {filing.get('rep')} — the fund stopped filing (not used)"}
    if prev and prev.get("accession") == filing["acc"] and not force:
        return {"unchanged": True}
    parsed = filing.get("_parsed") or parse_nport(await fetch_xml(sec, cik, filing["acc"]))
    overlap = name_tokens(fund["name"]) & (name_tokens(parsed["seriesName"]) | name_tokens(parsed["regName"]))
    return {
        "ticker": t, "cik": int(cik),
        "secName": (parsed["seriesName"] if parsed["seriesName"] not in (None, "N/A") else None) or parsed["regName"] or company,
        "nameMatch": bool(overlap), "form": filing["form"], "accession": filing["acc"],
        "filed": filing["filed"], "asOf": parsed["asOf"] or filing["rep"],
        "url": f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{filing['acc'].replace('-', '')}/",
        "totAssets": parsed["totAssets"], "totLiabs": parsed["totLiabs"], "netAssets": parsed["netAssets"],
        "raw": parsed["holdings"],
    }


def finish_fund(rec, figi, pref_cusips):
    """Tickers + classes + summary for a freshly parsed fund (needs the FIGI cache filled)."""
    rows = []
    for h in rec.pop("raw"):
        cls, proxy = classify(h)
        t, via = None, None
        if h.get("cusip") and h["cusip"].upper() in pref_cusips and cls not in ("derivative", "cash"):
            t, proxy = pref_cusips[h["cusip"].upper()], None      # a preferred / baby bond from George's list
        elif cls in ("equity", "preferred", "fund"):
            if h.get("cusip") and (h.get("ctry") in (None, "US") or cusip_kind(h["cusip"]) == "ID_CINS"):
                t = figi.us_ticker(cusip_kind(h["cusip"]), h["cusip"])    # Chubb CINS -> CB (not Zurich AEX)
            if not t and h.get("cusip") and (h.get("ctry") in (None, "US")):
                t, _ = figi.ticker(cusip_kind(h["cusip"]), h["cusip"], "US")
            if not t and h.get("isin") and not h.get("cusip"):
                t = figi.us_ticker("ID_ISIN", h["isin"])
            if not t and h.get("isin"):
                t, _ = figi.ticker("ID_ISIN", h["isin"], h.get("ctry"))
            if not t and h.get("cusip"):
                t, _ = figi.ticker(cusip_kind(h["cusip"]), h["cusip"], h.get("ctry"))
            if not t and cls == "equity" and h.get("ctry") == "US" and h.get("tkr"):
                t = yahoo_ticker(h["tkr"], "US")             # filing's own ticker: last resort (BNY's still says BK)
        elif cls == "convertible":
            c = h["conv"]
            if c.get("cusip"):
                t = figi.us_ticker(cusip_kind(c["cusip"]), c["cusip"])
            if not t and c.get("cusip"):
                t, _ = figi.ticker(cusip_kind(c["cusip"]), c["cusip"], "US")
            if not t and c.get("isin"):
                t, _ = figi.ticker("ID_ISIN", c["isin"], c["isin"][:2])
            via = c.get("name")
            if not t:
                proxy = "CWB"      # can't find the stock: convertible-bond ETF as a stand-in
        if cls == "preferred" and t:
            proxy = None
        if cls in ("equity", "preferred", "fund") and not t and (
                h.get("fv") == "3" or not (h.get("cusip") or h.get("isin") or h.get("tkr"))):
            cls, proxy = "private", None          # no market listing: private company / restricted share class
        row = {"n": h.get("title") or h.get("name"), "t": t, "c": cls, "p": round(h["pct"], 4) if h.get("pct") is not None else None,
               "usd": round(h["usd"]) if h.get("usd") is not None else None, "cat": h.get("cat"), "iss": h.get("iss"),
               "ctry": h.get("ctry"), "cur": h.get("cur"), "cusip": h.get("cusip"), "isin": h.get("isin")}
        if proxy:
            row["proxy"] = proxy
        if via:
            row["via"] = via
        if h.get("payoff") == "Short":
            row["short"] = True
        for k in ("mat", "cpn"):
            if h.get(k) is not None:
                row[k] = h[k]
        if h.get("default"):
            row["default"] = True
        if re.search(r"anthropic", row["n"] or "", re.I):
            row["link"] = "https://app.hyperliquid.xyz/trade/io:ANTH"
        rows.append(row)
    rows.sort(key=lambda r: -(r["p"] or 0))
    pct = lambda pred: round(sum((r["p"] or 0) for r in rows if pred(r)), 2)  # noqa: E731
    na = rec.get("netAssets")
    rec["leverage"] = round(rec["totAssets"] / na, 3) if rec.get("totAssets") and na else None
    rec["count"] = len(rows)
    rec["pctTotal"] = pct(lambda r: True)
    rec["pctPriceable"] = pct(lambda r: r["t"] is not None)
    rec["pctProxy"] = pct(lambda r: r["t"] is None and r.get("proxy"))
    rec["pctExcluded"] = pct(lambda r: r["c"] in ("derivative", "cash"))
    rec["pctNoPrice"] = pct(lambda r: r["t"] is None and not r.get("proxy") and r["c"] not in ("derivative", "cash"))
    rec["holdings"] = rows
    return rec


def figi_wanted(rec, pref_cusips):
    want = set()
    for h in rec["raw"]:
        if h.get("cusip") and h["cusip"].upper() in pref_cusips:
            continue
        cls, _ = classify(h)
        if cls in ("equity", "preferred", "fund"):
            if h.get("cusip") and (h.get("ctry") in (None, "US") or cusip_kind(h["cusip"]) == "ID_CINS"):
                want.add(("USX:" + cusip_kind(h["cusip"]), h["cusip"]))
            if h.get("cusip") and h.get("ctry") in (None, "US"):
                want.add((cusip_kind(h["cusip"]), h["cusip"]))
            elif h.get("isin"):
                want.add(("ID_ISIN", h["isin"]))
                if not h.get("cusip"):
                    want.add(("USX:ID_ISIN", h["isin"]))
            elif h.get("cusip"):
                want.add((cusip_kind(h["cusip"]), h["cusip"]))
        elif cls == "convertible":
            c = h["conv"]
            if c.get("cusip"):
                want.add(("USX:" + cusip_kind(c["cusip"]), c["cusip"]))
                want.add((cusip_kind(c["cusip"]), c["cusip"]))
            elif c.get("isin"):
                want.add(("ID_ISIN", c["isin"]))
    return want


async def load_cik_map(sec, cache_path):
    """ticker -> CIK. SEC publishes the same list three ways (company_tickers.json returned 404 on 2026-10-07 while
    the others worked); the last good map is kept in cik-map.json as a final fallback."""
    out = {}
    async def company_tickers():
        ct = (await sec.get("https://www.sec.gov/files/company_tickers.json")).json()
        return {v["ticker"].upper(): {"cik": v["cik_str"], "title": v["title"]} for v in ct.values()}
    async def exchange_file():
        ex = (await sec.get("https://www.sec.gov/files/company_tickers_exchange.json")).json()
        f = ex["fields"]
        return {d["ticker"].upper(): {"cik": d["cik"], "title": d.get("name")}
                for d in (dict(zip(f, row)) for row in ex["data"]) if d.get("ticker")}
    async def ticker_txt():
        txt = (await sec.get("https://www.sec.gov/include/ticker.txt")).text
        return {t.upper(): {"cik": int(c)} for t, c in (l.split("	") for l in txt.splitlines() if "	" in l)}
    for src in (company_tickers, exchange_file, ticker_txt):
        try:
            out = await src()
            if len(out) > 1000:
                break
        except Exception as e:  # noqa: BLE001
            print(f"  SEC ticker list via {src.__name__} failed: {e}", flush=True)
    try:
        mf = (await sec.get("https://www.sec.gov/files/company_tickers_mf.json")).json()
        f = mf["fields"]
        for row in mf["data"]:
            d = dict(zip(f, row))
            t = (d.get("symbol") or "").upper()
            if t and t not in out:
                out[t] = {"cik": d["cik"], "seriesId": d.get("seriesId")}
    except Exception as e:  # noqa: BLE001
        print(f"  SEC fund ticker list failed: {e}", flush=True)
    if len(out) > 1000:
        cache_path.write_text(json.dumps(out), encoding="utf-8")
    elif cache_path.exists():
        print("  using the saved ticker->CIK map (SEC lists unavailable)", flush=True)
        out = json.loads(cache_path.read_text(encoding="utf-8"))
    else:
        raise RuntimeError("no SEC ticker list available and no saved copy")
    return out


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers", help="comma list (default: every CEF)")
    ap.add_argument("--out", default=str(ROOT / "jobs" / "out"))
    ap.add_argument("--cefs", default=str(ROOT / "app" / "data" / "cefs.json"))
    ap.add_argument("--prefs", default=str(ROOT / "app" / "data" / "prefs.json"))
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    global PREFS_PATH
    PREFS_PATH = Path(a.prefs)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    say = lambda m: print(f"[{datetime.now():%H:%M:%S}] {m}", flush=True)  # noqa: E731

    cefs = json.loads(Path(a.cefs).read_text(encoding="utf-8"))
    if a.tickers:
        want = {t.strip().upper() for t in a.tickers.split(",")}
        cefs = [c for c in cefs if c["ticker"] in want]
    res_path = out / "holdings-sec.json.gz"
    prev_all = {"funds": {}, "missing": {}}
    if res_path.exists():
        prev_all = json.loads(gzip.decompress(res_path.read_bytes()))
    elif (out / "holdings-sec.json").exists():                  # older uncompressed output
        prev_all = json.loads((out / "holdings-sec.json").read_text(encoding="utf-8"))
    ov_path = ROOT / "jobs" / "sec_overrides.json"
    overrides = json.loads(ov_path.read_text(encoding="utf-8")) if ov_path.exists() else {}

    sec = Sec(sec_user_agent())
    figi = Figi(out / "figi-cache.json")
    say(f"{len(cefs)} funds; OpenFIGI {'with' if figi.key else 'without'} API key")
    cikmap = await load_cik_map(sec, out / "cik-map.json")

    sem = asyncio.Semaphore(6)
    async def one(f):
        async with sem:
            try:
                return f["ticker"], await process_fund(sec, f, cikmap, overrides, prev_all["funds"].get(f["ticker"]), a.force)
            except Exception as e:  # noqa: BLE001
                return f["ticker"], {"error": f"{type(e).__name__}: {e}"}
    results = await asyncio.gather(*(one(f) for f in cefs))
    fresh = {t: r for t, r in results if "raw" in r}
    say(f"SEC: {len(fresh)} new filings parsed, {sum(1 for _, r in results if r.get('unchanged'))} unchanged, "
        f"{sum(1 for _, r in results if 'error' in r)} problems")

    wanted = set()
    for r in fresh.values():
        wanted |= figi_wanted(r, load_pref_cusips())
    n = await figi.resolve(wanted, say)
    n2 = await figi.resolve_us_fallback(wanted)
    say(f"OpenFIGI: {len(wanted)} codes needed, {n} new lookups, {n2} US fallbacks ({figi.calls} requests)")

    pref_cusips = load_pref_cusips()
    funds, missing = dict(prev_all.get("funds", {})), dict(prev_all.get("missing", {}))
    checks = dict(prev_all.get("checks", {}))
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for t, r in results:
        if "raw" in r:
            rec = finish_fund(r, figi, pref_cusips)
            if rec["count"] == 0 and t in funds:
                missing[t] = "new filing had no holdings — kept the previous one"
                checks[t] = {"at": now_iso, "result": "new filing was empty — kept the previous one"}
                continue
            old = funds.get(t)
            if old and old.get("accession") != rec["accession"]:
                rec["changes"] = {"since": old.get("asOf"), "detectedAt": now_iso, **diff_lists(old["holdings"], rec["holdings"])}
            funds[t] = rec
            missing.pop(t, None)
            checks[t] = {"at": now_iso, "result": f"new filing (as of {rec['asOf']})" if old else "first download"}
        elif r.get("unchanged"):
            checks[t] = {"at": now_iso, "result": "no new filing"}
        elif "error" in r:
            missing[t] = r["error"] + (" (kept previous filing)" if t in funds else "")
            checks[t] = {"at": now_iso, "result": "problem: " + r["error"]}
    # name check against the CURRENT fund names (corrections in app/data/fund_corrections.json change them)
    names = {c["ticker"]: c["name"] for c in json.loads(Path(a.cefs).read_text(encoding="utf-8"))}
    for t, f in funds.items():
        if t in names:
            f["nameMatch"] = bool(name_tokens(names[t]) & name_tokens(f.get("secName")))
    # a filing older than a year means the fund stopped filing N-PORT (NXDT became a REIT in 2022): never use it
    cutoff = _years_from_now(-1)
    for t in [t for t, f in funds.items() if (f.get("asOf") or "") < cutoff]:
        missing[t] = f"last N-PORT is as of {funds[t].get('asOf')} — the fund stopped filing (not used)"
        del funds[t]
    doc = {"ok": True, "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
           "source": "SEC EDGAR N-PORT (NPORT-P), tickers via OpenFIGI", "count": len(funds), "funds": funds, "missing": missing,
           "checks": checks}
    tmp = out / "holdings-sec.tmp"
    tmp.write_bytes(gzip.compress(json.dumps(doc, separators=(",", ":")).encode("utf-8"), 6))
    tmp.replace(res_path)
    (out / "holdings-sec.json").unlink(missing_ok=True)
    index = {k: v for k, v in doc.items() if k != "funds"}
    index["funds"] = {t: {k: v for k, v in f.items() if k != "holdings"} for t, f in funds.items()}
    (out / "holdings-sec-index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    await sec.c.aclose()
    await figi.c.aclose()
    say(f"wrote {res_path} — {len(funds)} funds, {len(missing)} without N-PORT data, {res_path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    asyncio.run(main())
