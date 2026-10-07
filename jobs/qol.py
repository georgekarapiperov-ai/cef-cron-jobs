"""QuantumOnline security page parser (port of qolParse in legacy quote.js). Shared by the app (add-issue profile)
and jobs/prefs_refresh.py. QuantumOnline's raw HTML misses a </td> ("NYSE Chart 5.00% $1.25" share one cell)."""
import html as htmllib
import re


# ---------------- QuantumOnline page parser (port of qolParse) ----------------
def _html_text(h):
    s = re.sub(r"<br\s*/?>", "\n", str(h or ""), flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&#39;", "'").replace("&rsquo;", "'")
    return re.sub(r"[ \t]+", " ", s)


def qol_parse(page):
    text = _html_text(page)
    m1 = re.search(r"Ticker Symbol:\s*([A-Z0-9.\-*]+)\s*CUSIP:\s*([0-9A-Z]{9})?", text)
    if not m1:
        return None
    out = {"qolTicker": m1.group(1), "cusip": m1.group(2)}
    st = re.search(r"Security Type:\s*([^\n]+)", text)
    out["secType"] = st.group(1).strip() if st else None
    nm = re.search(r"([^\n]{5,200})\s*\n?\s*Ticker Symbol:", text)
    out["name"] = re.sub(r"^.*?\bLOGIN\b\s*", "", re.sub(r".*\)\s*;\s*", "", nm.group(1)), flags=re.I).strip() if nm else None
    # the innermost table around "Cpn Rate" (QuantumOnline nests it inside a layout table)
    cpn_at = page.find("Cpn Rate")
    low = page.lower()
    t_start = low.rfind("<table", 0, cpn_at) if cpn_at > 0 else -1
    t_end = low.find("</table>", cpn_at) if cpn_at > 0 else -1
    tbl = page[t_start:t_end + 8] if t_start >= 0 and t_end > t_start else None
    if tbl:
        rows = [[[x.strip() for x in _html_text(c).split("\n") if x.strip()]
                 for c in re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", r, re.I)]
                for r in re.findall(r"<tr[\s\S]*?</tr>", tbl, re.I)]
        hi = next((i for i, r in enumerate(rows) if any("Cpn Rate" in " ".join(c) for c in r)), -1)
        if hi >= 0 and hi + 1 < len(rows):
            hdr = [" ".join(c) for c in rows[hi]]
            val = rows[hi + 1]
            # QuantumOnline's raw HTML misses a </td>: "NYSE Chart" and the coupon can share the first value cell
            off = min(0, len(val) - len(hdr))

            def get(label):
                i = next((k for k, h in enumerate(hdr) if label in h), -1)
                j = i + off
                return (val[j] if 0 <= j < len(val) else []) if i >= 0 else []
            lp, cd, rt, dd = get("LiqPref"), get("Call Date"), get("Moodys"), get("Distribution")
            cpn_text = " ".join((val[0] if val else []) + ([] if off < 0 else (val[1] if len(val) > 1 else [])))
            cm = re.search(r"(\d+(?:\.\d+)?%|FixFloat|Reset Rate|Variable|n\.a\.)\s*(\$[\d.,]+|n\.a\.)?", cpn_text, re.I)
            out["cpnRate"] = cm.group(1) if cm else None
            out["annAmt"] = cm.group(2) if cm and cm.group(2) else None
            out["liqPref"] = lp[0] if lp else None
            out["callPrice"] = lp[1] if len(lp) > 1 else None
            out["callDate"] = cd[0] if cd else None
            out["maturity"] = cd[1] if len(cd) > 1 else None
            r = " ".join(rt).split()
            out["moodys"] = r[0] if r else None
            out["sp"] = r[1] if len(r) > 1 else None
            out["distDates"] = re.sub(r"Click for.*$", "", dd[0] if dd else "", flags=re.I).strip() or None
    dm = re.search(r"SECURITY DESCRIPTION:\s*([\s\S]*?)(?:Stock\s*Exchange|$)", text)
    desc = dm.group(1) if dm else ""
    out["description"] = re.sub(r"\s+", " ", desc).strip()[:1200] or None
    out["cumulative"] = False if re.search(r"non-?cumulative", desc, re.I) else (True if re.search("cumulative", desc, re.I) else None)
    out["floating"] = bool(re.search(r"float|SOFR|LIBOR|reset", desc, re.I))
    ipo = re.search(r"IPO\s*-\s*(\d{1,2}/\d{1,2}/\d{4})", text)
    out["ipo"] = ipo.group(1) if ipo else None
    benches = [(r"five[- ]year U\.?\s?S\.? Treasury|5[- ]year (U\.?\s?S\.? )?Treasury|five[- ]year Treasury", "5Y Treasury"),
               (r"(three|3)[- ]month (CME )?Term SOFR", "3M Term SOFR"), (r"SOFR", "SOFR"),
               (r"(three|3)[- ]month (U\.S\. dollar )?LIBOR", "3M LIBOR (now SOFR+0.26%)"), (r"LIBOR", "LIBOR"), (r"treasury", "Treasury")]
    bench = ""
    if out["floating"]:
        bench = next((n for rx, n in benches if re.search(rx, desc, re.I)), "")
    sm = re.search(r"plus (?:a (?:fixed )?spread of )?(\d+\.\d+)%", desc, re.I)
    spread = sm.group(1) if sm else ""
    if spread.startswith("0.2616"):
        bench += " + 0.26161% adj. + issue margin (see QuantumOnline)"
        spread = ""
    fm = re.search(r"(?:will be|rate of|at a fixed rate of|at|equal to) (\d+\.\d+)%(?: per annum)?,? "
                   r"(?:until|through|to,? but (?:not )?(?:excluding|including))", desc, re.I)
    fixed = fm.group(1) if fm else ""
    reset = "every 5 yrs" if re.search(r"every (five|5) years", desc, re.I) else (
        "quarterly" if re.search("quarterly", desc, re.I) and out["floating"] else "")
    flm = re.search(r"(?:floor|minimum)[^.%]{0,40}?(\d+\.\d+)%", desc, re.I)
    floor = flm.group(1) if flm else ""
    out["terms"] = "|".join([fixed, bench, spread, reset, floor]) if out["floating"] else None
    out["suspended"] = bool(re.search("suspend", out.get("distDates") or "", re.I))
    out["called"] = bool(re.match("called", out.get("callDate") or "", re.I))
    out["name"] = htmllib.unescape(out["name"]) if out.get("name") else out.get("name")
    return out
