"""What changed between two holdings lists of the same fund: added / removed / re-weighted.

Holdings are compared per issuer: matched by normalised name first (several preferreds or notes of one company count
together), then by ticker for names written differently ("NVIDIA CORPORATION" / "NVIDIA Corp" already match by name).
Weights are compared after scaling each list to 100%, so a % of net assets list and a % of portfolio list compare fairly.
"""
import re

REWEIGHT_PP = 0.25      # a change of at least 0.25 percentage points counts as "re-weighted"
STOP = {"inc", "corp", "corporation", "co", "company", "ltd", "limited", "plc", "sa", "ag", "nv", "the", "class",
        "holdings", "holding", "group", "of", "and", "cos", "companies", "llc", "lp", "a", "b", "c", "se", "de"}


def _name_key(n):
    words = [w for w in re.findall(r"[a-z0-9]+", (n or "").lower()) if w not in STOP]
    return " ".join(words[:3])


def _collapse(rows):
    """{name_key: {"n", "t", "tickers", "w"}} with weights scaled to 100%."""
    tot = sum(max(r.get("p") or 0, 0) for r in rows if r.get("c") not in ("derivative", "cash")) or 1.0
    out = {}
    for r in rows:
        if r.get("c") in ("derivative", "cash"):
            continue
        k = _name_key(r.get("n")) or ("T:" + (r.get("t") or ""))
        e = out.setdefault(k, {"n": r.get("n"), "t": r.get("t"), "tickers": set(), "w": 0.0})
        if r.get("t"):
            e["tickers"].add(r["t"].upper())
            e["t"] = e["t"] or r["t"]
        e["w"] += max(r.get("p") or 0, 0) * 100 / tot
    return out


def _rescale(d):
    tot = sum(e["w"] for e in d.values()) or 1.0
    for e in d.values():
        e["w"] = e["w"] * 100 / tot
    return d


def diff_lists(old_rows, new_rows, top=None):
    """Changes from old -> new. top=N compares only the N biggest of each list (for top-10 sources)."""
    a, b = _collapse(old_rows), _collapse(new_rows)
    if top:      # top-N per issuer (SEC splits Databricks into 3 lines — add them up first, then cut)
        a = _rescale(dict(sorted(a.items(), key=lambda kv: -kv[1]["w"])[:top]))
        b = _rescale(dict(sorted(b.items(), key=lambda kv: -kv[1]["w"])[:top]))
    pairs = {k: k for k in a.keys() & b.keys()}
    # second pass: same ticker under a differently written name
    by_t = {}
    for k, e in b.items():
        if k not in pairs.values():
            for t in e["tickers"]:
                by_t.setdefault(t, k)
    for k, e in a.items():
        if k in pairs:
            continue
        hit = next((by_t[t] for t in e["tickers"] if t in by_t and by_t[t] not in pairs.values()), None)
        if hit:
            pairs[k] = hit
    # last pass: legal names written differently ("AerCap Holdings" / "AerCap Ireland Capital"): same first word,
    # and that first word belongs to only one unmatched issuer on each side
    first = lambda k: k.split(" ")[0] if k and not k.startswith("T:") else None  # noqa: E731
    left = [k for k in a if k not in pairs]
    right = [k for k in b if k not in pairs.values()]
    for k in left:
        f = first(k)
        if not f or len(f) < 4:
            continue
        la = [x for x in left if first(x) == f]
        rb = [x for x in right if first(x) == f and x not in pairs.values()]
        if len(la) == 1 and len(rb) == 1:
            pairs[k] = rb[0]
    matched_b = set(pairs.values())
    item = lambda e: {"n": e["n"], "t": e["t"], "w": round(e["w"], 2)}  # noqa: E731
    added = sorted((item(e) for k, e in b.items() if k not in matched_b), key=lambda x: -x["w"])
    removed = sorted((item(e) for k, e in a.items() if k not in pairs), key=lambda x: -x["w"])
    rew = []
    for ka, kb in pairs.items():
        w0, w1 = a[ka]["w"], b[kb]["w"]
        if abs(w1 - w0) >= REWEIGHT_PP:
            rew.append({"n": b[kb]["n"], "t": b[kb]["t"] or a[ka]["t"], "from": round(w0, 2), "to": round(w1, 2)})
    rew.sort(key=lambda x: -abs(x["to"] - x["from"]))
    return {"added": added[:40], "removed": removed[:40], "reweighted": rew[:40],
            "counts": {"added": len(added), "removed": len(removed), "reweighted": len(rew)}}
