"""Preferreds, baby bonds and trusts from live sources (Phase 7). The Excel sheet (app/data/prefs.json) stays the seed.

    py jobs\\prefs_refresh.py                 QuantumOnline (every issue) + Nasdaq dividend calendar + Yahoo dividends
    py jobs\\prefs_refresh.py --only nasdaq   just one source (qol / nasdaq / yahoo)
    py jobs\\prefs_refresh.py --syms COF-I,BWNB

  QuantumOnline  every weekday, one public security page per issue, 1 request/s (~12 min for 690): coupon, par, call
                 date & price, maturity, cumulative, pay dates, ratings, CUSIP, reset terms, CALLED / SUSPENDED.
                 (Its "called" and "suspended" list pages need a login, so each issue is checked — that is what makes
                 "called within a day" work.)
  Nasdaq         dividend calendar, next 30 days: CONFIRMED ex-dates, amounts, record and pay dates
  Yahoo          last dividend paid (date, amount), weekly

Output: holdings-style file prefs-live.json — every field keeps {v: value, src: source, at: checked date}; a source that
finds nothing never blanks a field; changes are logged per issue (last 15).
"""
import argparse
import asyncio
import json
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qol import qol_parse  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
NASDAQ = {"User-Agent": UA, "Accept": "application/json, text/plain, */*", "Origin": "https://www.nasdaq.com",
          "Referer": "https://www.nasdaq.com/"}
QOL_TYPES = {"Traditional Preferred Stock": "Pfd", "Exchange-Traded Debt Security": "Debt",
             "Third Party Trust Preferred": "3P-Trust", "Trust Preferred Securities": "TruPS"}


def say(m):
    print(f"[{datetime.now():%H:%M:%S}] {m}", flush=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def money(s):
    try:
        return float(str(s if s is not None else "").replace("$", "").replace(",", "").strip())
    except ValueError:
        return None


def mdy(s):
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", str(s or ""))
    return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else None


def freq_of(dist):
    """'3/1, 6/1, 9/1 & 12/1' -> 4 (same rule as the add-issue button)."""
    if not dist or re.search("suspend", dist, re.I):
        return None
    if re.search("month", dist, re.I):
        return 12
    if re.search("annual", dist, re.I):
        return 1
    n = len([x for x in re.split(r",|&", dist) if re.search(r"\d", x)])
    return n if n in (1, 2, 4, 12) else None


def qol_fields(q):
    """QuantumOnline profile -> app fields (mirrors profileToRow in legacy addissue.js)."""
    f = {}
    liq, ann = money(q.get("liqPref")), money(q.get("annAmt"))
    m = re.fullmatch(r"\s*([\d.]+)%\s*", q.get("cpnRate") or "")
    cpn = float(m.group(1)) / 100 if m else None
    fixed = cpn is not None and cpn <= 0.5
    if q.get("cusip"):
        f["cusip"] = q["cusip"]
    if q.get("secType"):
        f["qtype"] = QOL_TYPES.get(q["secType"], q["secType"])
    if liq:
        f["par"] = liq
    if fixed:
        f["rate"] = round(ann / liq, 6) if ann and liq else cpn
        if ann:
            f["qann"] = ann
    elif q.get("cpnRate"):
        f["rateText"] = q["cpnRate"]            # FixFloat / Reset Rate — the coupon follows a benchmark
    if ann:
        f["qann0"] = ann
    if money(q.get("callPrice")):
        f["qcallpx"] = money(q["callPrice"])
    if q.get("called"):
        f["qcalled"] = mdy(q.get("maturity")) or date.today().isoformat()   # QuantumOnline puts the redemption date there
    else:
        cd = q.get("callDate") or ""
        if mdy(cd):
            f["call"] = mdy(cd)
        elif re.search(r"not|non|unredeem", cd, re.I):
            f["call"] = "Not Redeemable"
        elif re.search("any", cd, re.I):
            f["call"] = "Any Time"
        mat = q.get("maturity") or ""
        if mdy(mat):
            f["mat"] = mdy(mat)
        elif re.search(r"none|perp", mat, re.I):
            f["mat"] = "Perpetual"
    mo, sp = (q.get("moodys") or "").strip(), (q.get("sp") or "").strip()
    moody_like = lambda r: bool(re.fullmatch(r"(Aaa|Aa[123]|A[123]|Baa[123]|Ba[123]|B[123]|Caa[123]|Ca|C)", r))  # noqa: E731
    sp_like = lambda r: bool(re.fullmatch(r"(AAA|AA|A|BBB|BB|B|CCC|CC|C|D)[+-]?", r))                        # noqa: E731
    if sp_like(mo) and moody_like(sp):
        mo, sp = sp, mo                            # QuantumOnline sometimes lists them the other way round (COF-K)
    norm = lambda r: r.upper() if r.upper() in ("NR", "NF", "WR") else r  # noqa: E731
    if mo:
        f["mdy"] = norm(mo)
    if sp:
        f["sp"] = norm(sp)
    if q.get("distDates"):
        f["qdist"] = q["distDates"]
        if freq_of(q["distDates"]):
            f["qfreq"] = freq_of(q["distDates"])
    if q.get("cumulative") is not None:
        f["qcum"] = q["cumulative"]
    if q.get("terms"):
        f["qterms"] = q["terms"]
    f["qsusp"] = bool(q.get("suspended"))
    if q.get("ipo") and mdy(q["ipo"]):
        f["ipo"] = mdy(q["ipo"])
    return f


def nasdaq_symbol(sym):
    m = re.fullmatch(r"([A-Z]+)-([A-Z]+)", sym)
    return f"{m.group(1)}^{m.group(2)}" if m else sym


# ---------------- sources ----------------
async def run_qol(c, prefs, say):
    out = {}
    for i, p in enumerate(prefs):
        if i % 100 == 0:
            say(f"QuantumOnline {i}/{len(prefs)}")
        tried = []
        # the sheet symbol first; then the Yahoo-style one (DCOM- -> DCOMP) and without the dash (FITB-A -> FITBA)
        for sym in dict.fromkeys([p["sym"], p.get("ysym") or "", p["sym"].replace("-", "")]):
            if not sym:
                continue
            tried.append(sym)
            try:
                r = await c.get("https://www.quantumonline.com/search.cfm", params={"tickersymbol": sym, "sopt": "symbol"})
                q = qol_parse(r.text) if r.status_code == 200 else None
            except Exception:  # noqa: BLE001
                q = None
            await asyncio.sleep(1.0)               # QuantumOnline: one request per second
            if q:
                out[p["sym"]] = qol_fields(q)
                if sym != p["sym"]:
                    out[p["sym"]]["qolSymbol"] = sym
                break
        else:
            out[p["sym"]] = {"_error": "no QuantumOnline page for " + " / ".join(tried)}
    return out


async def run_nasdaq(c, prefs, say, days=30):
    want = {nasdaq_symbol(p["sym"]): p["sym"] for p in prefs}
    want.update({p["sym"].replace("-", ""): p["sym"] for p in prefs})       # some calendars write COFPI-style
    out, d = {}, date.today()
    end = d + timedelta(days=days)
    while d <= end:
        if d.weekday() < 5:
            try:
                j = (await c.get(f"https://api.nasdaq.com/api/calendar/dividends?date={d.isoformat()}", headers=NASDAQ)).json()
                for r in (((j.get("data") or {}).get("calendar") or {}).get("rows") or []):
                    sym = want.get((r.get("symbol") or "").upper())
                    if sym:
                        out[sym] = {"exdivNext": mdy(r.get("dividend_Ex_Date")) or d.isoformat(), "exdivAmt": money(r.get("dividend_Rate")),
                                    "paydtNext": mdy(r.get("payment_Date")), "recordNext": mdy(r.get("record_Date"))}
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(0.5)
        d += timedelta(days=1)
    say(f"Nasdaq: confirmed upcoming ex-dates for {len(out)} issues")
    return out


async def run_yahoo(c, prefs, say):
    sem = asyncio.Semaphore(4)
    out = {}

    async def one(p):
        async with sem:
            try:
                r = await c.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{p['ysym']}",
                                params={"range": "1y", "interval": "1d", "events": "div"})
                res = ((r.json().get("chart") or {}).get("result") or [None])[0] or {}
                divs = sorted(((datetime.fromtimestamp(v["date"], timezone.utc).date().isoformat(), v["amount"])
                               for v in ((res.get("events") or {}).get("dividends") or {}).values()))
                if divs:
                    out[p["sym"]] = {"lastDivDate": divs[-1][0], "lastDivAmt": round(divs[-1][1], 6), "divs12m": len(divs)}
            except Exception:  # noqa: BLE001
                pass
    await asyncio.gather(*(one(p) for p in prefs))
    say(f"Yahoo: last dividend for {len(out)} issues")
    return out


# ---------------- merge (never blank, log changes) ----------------
def merge(store, sym, fields, src):
    rec = store.setdefault(sym, {"fields": {}, "checks": {}, "changes": []})
    at = now_iso()
    if "_error" in fields:
        rec["checks"][src] = {"at": at, "result": "problem: " + fields["_error"]}
        return 0
    n = 0
    for k, v in fields.items():
        if v is None:
            continue                                # a source that misses a field never blanks it
        old = rec["fields"].get(k)
        if old is None or old.get("v") != v:
            if old is not None:
                rec["changes"].insert(0, {"field": k, "from": old.get("v"), "to": v, "src": src, "at": at})
                n += 1
            rec["fields"][k] = {"v": v, "src": src, "at": at}
        else:
            old["at"] = at                          # same value, confirmed again
            old["src"] = src
    del rec["changes"][15:]
    rec["checks"][src] = {"at": at, "result": f"{n} change(s)" if n else "no change"}
    return n


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="qol,nasdaq,yahoo")
    ap.add_argument("--syms")
    ap.add_argument("--out", default=str(ROOT / "jobs" / "out"))
    ap.add_argument("--prefs", default=str(ROOT / "app" / "data" / "prefs.json"))
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    prefs = json.loads(Path(a.prefs).read_text(encoding="utf-8"))
    if a.syms:
        want = {s.strip().upper() for s in a.syms.split(",")}
        prefs = [p for p in prefs if p["sym"] in want]
    srcs = [s.strip() for s in a.only.split(",")] if a.only else ["qol", "nasdaq", "yahoo"]
    path = out / "prefs-live.json"
    doc = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"prefs": {}}
    store = doc.get("prefs") or {}
    t0 = time.time()
    async with httpx.AsyncClient(headers={"User-Agent": UA}, timeout=25, follow_redirects=True) as c:
        changes = 0
        if "nasdaq" in srcs:
            got = await run_nasdaq(c, prefs, say)
            for p in prefs:            # issues not on the calendar: clear only the "next ex-date" block, never the rest
                rec = store.get(p["sym"])
                if rec and p["sym"] not in got:
                    for k in ("exdivNext", "exdivAmt", "paydtNext", "recordNext"):
                        f = rec["fields"].get(k)
                        if f and (f.get("v") or "9999") < date.today().isoformat():
                            rec["fields"].pop(k, None)          # that ex-date has passed
            for s, f in got.items():
                changes += merge(store, s, f, "Nasdaq")
        if "yahoo" in srcs:
            for s, f in (await run_yahoo(c, prefs, say)).items():
                changes += merge(store, s, f, "Yahoo")
        if "qol" in srcs:
            for s, f in (await run_qol(c, prefs, say)).items():
                changes += merge(store, s, f, "QuantumOnline")
    called = sorted(s for s, r in store.items() if (r["fields"].get("qcalled") or {}).get("v"))
    susp = sorted(s for s, r in store.items() if (r["fields"].get("qsusp") or {}).get("v"))
    doc = {"ok": True, "generatedAt": now_iso(), "source": "QuantumOnline + Nasdaq dividend calendar + Yahoo",
           "count": len(store), "called": called, "suspended": susp, "prefs": store}
    tmp = out / "prefs-live.tmp"
    tmp.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)
    say(f"wrote {path} — {len(store)} issues, {changes} field changes, called {len(called)}, suspended {len(susp)}, "
        f"{time.time() - t0:.0f}s")


if __name__ == "__main__":
    asyncio.run(main())
