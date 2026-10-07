"""Holdings straight from the fund sponsors' own websites — usually newer than SEC N-PORT (monthly vs ~60-day lag).

    py jobs\\holdings_sponsors.py                     every sponsor plugin
    py jobs\\holdings_sponsors.py --only nuveen        one plugin

Plugins (one per sponsor family; add more the same way):
  blackrock  BlackRock product list -> each closed-end fund's holdings CSV (top 10, monthly)
  nuveen     one Excel file with the FULL holdings of every Nuveen closed-end fund (monthly)

Tickers: from the sponsor file when it has them; otherwise the holding's name is matched against the same fund's
SEC N-PORT list (jobs/out/holdings-sec.json.gz) and that row's ticker / class / stand-in ETF is used.
Output (in --out, default jobs/out/): holdings-sponsor.json. A fund whose download fails keeps its previous record;
a list with an older date than the stored one is ignored (never overwrite good data with worse data).
"""
import argparse
import asyncio
import csv
import gzip
import io
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
PAUSE_S = 1.0          # one request per second per sponsor site


def say(m):
    print(f"[{datetime.now():%H:%M:%S}] {m}", flush=True)


def mdy(s):
    """'08/31/2026' or 'Aug 31, 2026' -> '2026-08-31'."""
    s = str(s or "").strip()
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m:
        return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    try:
        return datetime.strptime(s, "%b %d, %Y").strftime("%Y-%m-%d")
    except ValueError:
        return None


def pct(x):
    try:
        return float(str(x).replace("%", "").replace(",", "").strip())
    except ValueError:
        return None


# ---------------- name matching against the SEC list ----------------
STOP = {"inc", "corp", "corporation", "co", "company", "ltd", "limited", "plc", "sa", "ag", "nv", "se", "the", "class",
        "cl", "a", "b", "c", "holdings", "holding", "group", "of", "and", "&", "com", "shs", "ord", "adr", "lp", "llc",
        "cos", "companies"}


def toks(s):
    return {w for w in re.findall(r"[a-z0-9]+", (s or "").lower()) if w not in STOP}


def best_sec_match(name, sec_rows):
    """The SEC row with the most similar name (Jaccard >= 0.5). If the best-matching rows carry DIFFERENT tickers
    (one company, several preferreds / notes) the ticker is ambiguous: return the row without its ticker."""
    a = toks(name)
    if not a:
        return None
    scored = []
    for r in sec_rows:
        b = toks(r.get("n"))
        if b:
            scored.append((len(a & b) / len(a | b), r))
    if not scored:
        return None
    top = max(j for j, _ in scored)
    if top < 0.5:
        return None
    best = [r for j, r in scored if j == top]
    tickers = {r.get("t") for r in best}
    pick = max(best, key=lambda r: r.get("p") or 0)
    if len(tickers) > 1:
        return {**pick, "t": None, "ambiguous": True}
    return pick


# sponsor security type -> (class, stand-in ETF)
TYPE_MAP = [
    (r"common stock|reit common|depository receipt", ("equity", None)),
    (r"exchange traded fund|closed ended|mutual fund", ("fund", None)),
    (r"preferred|contingent capital", ("preferred", "PFF")),
    (r"term loan|delay draw|loan", ("loan", "BKLN")),
    (r"municipal|muni residual|tob", ("bond", "MUB")),
    (r"treasury|government", ("bond", "IEF")),
    (r"mortgage backed|cmo|collateralized mortgage", ("abs", "MBB")),
    (r"asset backed|clo|collateralized loan", ("abs", "BKLN")),
    (r"convertible", ("convertible", "CWB")),
    (r"corporate bond|reit debt|bond|note", ("bond", None)),          # HYG / LQD by coupon
    (r"option|warrant|swap|future|forward", ("derivative", None)),
    (r"cash|money market|repo", ("cash", None)),
]


NAME_HINTS = [(r"\bU?MBS\b|\bGNMA\b|\bFNMA\b|\bFHLMC\b|MORTGAGE POOL", "Mortgage Backed Security"),
              (r"\bTREASURY\b|\bT-?BILLS?\b", "Government"), (r"MONEY MARKET|\bCASH\b|LIQUIDITY FUND", "Cash")]


def classify_type(t, coupon=None, name=""):
    if not t:
        t = next((ty for rx, ty in NAME_HINTS if re.search(rx, name or "", re.I)), "")
    t = (t or "").lower()
    for rx, (cls, proxy) in TYPE_MAP:
        if re.search(rx, t):
            if cls == "bond" and proxy is None:
                proxy = "HYG" if (coupon or 0) >= 6.0 else "LQD"
            return cls, proxy
    return None, None


def finish(rows, sec_rows):
    """rows: [{n, p, t?, type?, cpn?}] -> app rows {n, t, c, p, proxy?, src?} + summary numbers."""
    out = []
    for r in rows:
        cls, proxy = classify_type(r.get("type"), r.get("cpn"), r["n"])
        t = r.get("t")
        m = best_sec_match(r["n"], sec_rows) if sec_rows else None
        if m and (not t or cls in (None, "preferred", "convertible")):
            t = t or m.get("t")
            if cls is None or (m.get("t") and cls in ("preferred", "convertible")):
                cls, proxy = m.get("c"), m.get("proxy")
            if m.get("ambiguous") and cls in ("preferred", "convertible", "bond") and not proxy:
                proxy = {"preferred": "PFF", "convertible": "CWB"}.get(cls, "LQD")
        if cls is None:
            cls = "equity" if t else "other"
        if t:
            proxy = None
        row = {"n": r["n"], "t": t, "c": cls, "p": r.get("p")}
        if proxy:
            row["proxy"] = proxy
        if m and not r.get("t") and t:
            row["tickerFrom"] = "SEC list"
        for k in ("cpn", "mat", "type"):
            if r.get(k) not in (None, ""):
                row[k] = r[k]
        if re.search(r"anthropic", r["n"], re.I):
            row["link"] = "https://app.hyperliquid.xyz/trade/io:ANTH"
        out.append(row)
    out.sort(key=lambda x: -(x["p"] or 0))
    total = lambda pred: round(sum((x["p"] or 0) for x in out if pred(x)), 2)  # noqa: E731
    return out, {"count": len(out), "pctTotal": total(lambda x: True), "pctPriceable": total(lambda x: x["t"]),
                 "pctProxy": total(lambda x: not x["t"] and x.get("proxy")),
                 "pctNoPrice": total(lambda x: not x["t"] and not x.get("proxy") and x["c"] not in ("derivative", "cash"))}


# ---------------- plugins ----------------
class BlackRock:
    """blackrock.com product screener -> closed-end funds -> holdings CSV (top 10, monthly)."""
    name = "BlackRock website"
    SCREENER = ("https://www.blackrock.com/us/individual/product-screener/product-screener-v3.jsn"
                "?dcrPath=/templatedata/config/product-screener-v3/data/en/one/one-v4")

    async def run(self, c, tickers):
        d = (await c.get(self.SCREENER)).json()["data"]["tableData"]
        cols = [x["name"] for x in d["columns"]]
        v = lambda x: x.get("r") if isinstance(x, dict) else x  # noqa: E731
        products = {}
        for row in d["data"]:
            r = dict(zip(cols, row))
            t = v(r.get("localExchangeTicker"))
            if t in tickers and v(r.get("productPageUrl")):
                products[t] = "https://www.blackrock.com" + v(r["productPageUrl"])
        out = {}
        for t, page in sorted(products.items()):
            url = f"{page}/1464253357814.ajax?fileType=csv&fileName={t}_holdings&dataType=fund"
            try:
                text = (await c.get(url)).content.decode("utf-8-sig")
                lines = [l for l in text.splitlines() if l.strip()]
                as_of = mdy(next(csv.reader([lines[0]]))[1]) if lines else None
                rows = [{"n": r[0], "p": pct(r[1])} for r in csv.reader(lines[2:]) if len(r) >= 2 and r[0].strip()]
                if as_of and rows:
                    out[t] = {"asOf": as_of, "url": page, "full": False, "rows": rows}
                else:
                    out[t] = {"error": "BlackRock file is empty"}
            except Exception as e:  # noqa: BLE001
                out[t] = {"error": f"{type(e).__name__}: {e}"}
            await asyncio.sleep(PAUSE_S)
        return out


class Nuveen:
    """documents.nuveen.com: one Excel workbook with the full holdings of every Nuveen closed-end fund."""
    name = "Nuveen website"
    URL = "https://documents.nuveen.com/Documents/Nuveen/Viewer.aspx?uniqueId=FBC31417-8297-4F60-AB45-58477BC5BF9C&download=1"
    PAGE = "https://www.nuveen.com/en-us/closed-end-funds"

    async def run(self, c, tickers):
        import xlrd
        r = await c.get(self.URL, timeout=180)
        r.raise_for_status()
        book = xlrd.open_workbook(file_contents=r.content)
        funds = {}
        for sh in book.sheets():
            hr = next((i for i in range(min(40, sh.nrows)) if sum(1 for x in sh.row_values(i) if str(x).strip()) >= 5
                       and str(sh.row_values(i)[0]).strip() == "Fund"), None)
            if hr is None:
                continue
            hdr = [str(x).strip() for x in sh.row_values(hr)]
            col = lambda *names: next((hdr.index(n) for n in names if n in hdr), None)  # noqa: E731
            i_f, i_d, i_n, i_t = col("Fund"), col("As Of Date"), col("Issuer"), col("Ticker")
            i_p, i_ty, i_c, i_m = col("% of Portfolio"), col("Strategy Class", "Security Type"), col("Coupon"), col("Maturity Date")
            for i in range(hr + 1, sh.nrows):
                v = sh.row_values(i)
                if len(v) != len(hdr):
                    continue
                t = str(v[i_f]).strip()
                if t not in tickers:
                    continue
                as_of = mdy(v[i_d]) if i_d is not None else None
                ty = str(v[i_ty]).strip() if i_ty is not None else ""
                row = {"n": str(v[i_n]).strip(), "p": pct(v[i_p]), "type": ty}
                tk = str(v[i_t]).strip() if i_t is not None else ""
                if tk and re.search(r"common stock|reit common|depository|exchange traded", ty, re.I) and re.fullmatch(r"[A-Z.\-]{1,6}", tk):
                    row["t"] = tk.replace(".", "-")        # Nuveen equity tickers are US listings (BRK.B style)
                if i_c is not None and pct(v[i_c]) is not None:
                    row["cpn"] = pct(v[i_c])
                if i_m is not None and mdy(v[i_m]):
                    row["mat"] = mdy(v[i_m])
                f = funds.setdefault(t, {"asOf": as_of, "url": self.PAGE, "full": True, "rows": []})
                f["asOf"] = max(f["asOf"] or "", as_of or "") or None
                f["rows"].append(row)
        return funds


PLUGINS = {"blackrock": BlackRock, "nuveen": Nuveen}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma list of plugins")
    ap.add_argument("--out", default=str(ROOT / "jobs" / "out"))
    ap.add_argument("--cefs", default=str(ROOT / "app" / "data" / "cefs.json"))
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    tickers = {c["ticker"] for c in json.loads(Path(a.cefs).read_text(encoding="utf-8"))}
    sec_path = out / "holdings-sec.json.gz"
    sec = json.loads(gzip.decompress(sec_path.read_bytes()))["funds"] if sec_path.exists() else {}
    res_path = out / "holdings-sponsor.json"
    prev = json.loads(res_path.read_text(encoding="utf-8")) if res_path.exists() else {"funds": {}, "problems": {}}
    funds, problems = dict(prev.get("funds", {})), {}
    stale_cut = (datetime.now(timezone.utc).replace(year=datetime.now(timezone.utc).year - 1)).strftime("%Y-%m-%d")

    names = [n.strip() for n in a.only.split(",")] if a.only else list(PLUGINS)
    async with httpx.AsyncClient(headers={"User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9"},
                                 timeout=60, follow_redirects=True) as c:
        for name in names:
            plug = PLUGINS[name]()
            t0 = time.time()
            try:
                got = await plug.run(c, tickers)
            except Exception as e:  # noqa: BLE001
                problems[name] = f"plugin failed: {type(e).__name__}: {e} (kept previous data)"
                say(f"{name}: FAILED {e}")
                continue
            ok = 0
            for t, f in got.items():
                if "error" in f:
                    problems[t] = f"{plug.name}: {f['error']}"
                    continue
                if (f["asOf"] or "") < stale_cut:
                    problems[t] = f"{plug.name}: list is as of {f['asOf']} — too old, not used"
                    continue
                old = funds.get(t)
                if old and old.get("source") == plug.name and (old.get("asOf") or "") > f["asOf"]:
                    problems[t] = f"{plug.name}: new list ({f['asOf']}) is older than the stored one — kept stored"
                    continue
                rows, summ = finish(f["rows"], (sec.get(t) or {}).get("holdings") or [])
                funds[t] = {"ticker": t, "source": plug.name, "url": f["url"], "asOf": f["asOf"], "full": f["full"],
                            "weightBasis": "% of portfolio (sponsor)", **summ, "holdings": rows,
                            "checkedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
                ok += 1
            say(f"{name}: {ok} funds in {time.time() - t0:.0f}s, {sum(1 for f in got.values() if 'error' in f)} problems")

    doc = {"ok": True, "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
           "source": "sponsor websites", "count": len(funds), "funds": funds, "problems": problems}
    tmp = out / "holdings-sponsor.tmp"
    tmp.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    tmp.replace(res_path)
    say(f"wrote {res_path} — {len(funds)} funds, {res_path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    asyncio.run(main())
