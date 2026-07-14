# -*- coding: utf-8 -*-
"""검증 단계: 항등식(I1/I2/I3), 표본(S1), 중복열 프로브(S2), 부모=자식합(S3).

산출: build/interim/validation_report.json + validation_report.md
S2 프로브 판정이 config.DUP_RESOLUTION 과 다르면 config.py 의 DUP_RESOLUTION 만
수정 허용하고 리포트에 명시한다.
"""
import json
import re
import time

import config


def _num(v):
    if v is None or v == "":
        return 0
    try:
        return int(round(float(v)))
    except (ValueError, TypeError):
        return 0


def _base_key(key):
    return key.split("#", 1)[0]


def build_values(extracted, registry, name_to_id):
    """반환: values[(year, sid)][side][account_key] = int, present[(year,sid,side)]."""
    values = {}
    present = set()
    for side in ("in", "ex"):
        _, rows = extracted[side]
        cols = [(a["code"], a["col_idx"]) for a in registry[side]]
        for r in rows:
            year = int(str(r[0]))
            sid = name_to_id[r[1]]
            key = (year, sid)
            slot = values.setdefault(key, {}).setdefault(side, {})
            for k, ci in cols:
                slot[k] = _num(r[ci])
            present.add((year, sid, side))
    return values, present


# ── 항등식 ─────────────────────────────────────────────────────────────
def _check_identity(values, present, id2name):
    tol = config.TOL
    lv1 = _lv1_keys()

    results = {"I1": [], "I2": [], "I3_in": [], "I3_ex": []}

    for (year, sid), sides in values.items():
        vin = sides.get("in")
        vex = sides.get("ex")
        name = id2name.get(sid, str(sid))

        # I1: T_IN == T_EX
        if vin and vex:
            lhs, rhs = vin.get("T_IN", 0), vex.get("T_EX", 0)
            results["I1"].append((abs(lhs - rhs) <= tol, year, name, lhs, rhs))

        # I2: CF_PREV(y) == CF_NEXT(y-1)  (y-1 에 지출 존재 시)
        if vin and (year - 1, sid, "ex") in present:
            lhs = vin.get("CF_PREV", 0)
            rhs = values[(year - 1, sid)]["ex"].get("CF_NEXT", 0)
            results["I2"].append((abs(lhs - rhs) <= tol, year, name, lhs, rhs))

        # I3_in: Σ(lv1 관) + 기본금 + CF_PREV == T_IN
        if vin:
            s = sum(vin.get(k, 0) for k in lv1["in"])
            lhs = s + vin.get("F_기본금", 0) + vin.get("CF_PREV", 0)
            rhs = vin.get("T_IN", 0)
            results["I3_in"].append((abs(lhs - rhs) <= tol, year, name, lhs, rhs))

        # I3_ex: Σ(lv1 관) + CF_NEXT == T_EX
        if vex:
            s = sum(vex.get(k, 0) for k in lv1["ex"])
            lhs = s + vex.get("CF_NEXT", 0)
            rhs = vex.get("T_EX", 0)
            results["I3_ex"].append((abs(lhs - rhs) <= tol, year, name, lhs, rhs))

    return results


_LV1_CACHE = {}


def _lv1_keys():
    return _LV1_CACHE


def _init_lv1(registry):
    _LV1_CACHE["in"] = [a["code"] for a in registry["in"] if a["lv"] == 1]
    _LV1_CACHE["ex"] = [a["code"] for a in registry["ex"] if a["lv"] == 1]


# ── S2 dup-probe ───────────────────────────────────────────────────────
def _dup_probe(values, registry):
    """DUP_RESOLUTION 각 base 에 대해 실측 판정. 반환: {side:{base:{...}}}."""
    verdicts = {"in": {}, "ex": {}}
    for side in ("in", "ex"):
        # base -> [keys...] (등장 순)
        groups = {}
        for a in registry[side]:
            b = _base_key(a["code"])
            groups.setdefault(b, []).append(a["code"])
        for base, cfg_res in config.DUP_RESOLUTION.get(side, {}).items():
            keys = groups.get(base, [])
            if len(keys) < 2:
                verdicts[side][base] = {"config": cfg_res, "probe": "single",
                                        "match": False, "n_cols": len(keys)}
                continue
            # split 판정: 추가 열이 (공란/0 이 아니면서) 첫 열과 다른 값을 갖는
            # 행이 하나라도 있으면 실질 세목 분할. #2·#3 이 공란 패딩일 뿐이면 equal.
            is_split = False
            for (year, sid), sides in values.items():
                slot = sides.get(side)
                if not slot:
                    continue
                base_v = slot.get(keys[0], 0)
                for k in keys[1:]:
                    e = slot.get(k, 0)
                    if e != 0 and e != base_v:
                        is_split = True
                        break
                if is_split:
                    break
            probe = "split" if is_split else "equal"
            verdicts[side][base] = {
                "config": cfg_res, "probe": probe,
                "match": (probe == cfg_res), "n_cols": len(keys),
            }
    return verdicts


def _apply_config_fix(verdicts):
    """프로브 판정이 config 와 다르면 config.py 의 DUP_RESOLUTION 값만 교체."""
    changes = []
    for side in ("in", "ex"):
        for base, info in verdicts[side].items():
            if info["probe"] in ("equal", "split") and not info["match"]:
                changes.append((side, base, info["config"], info["probe"]))
    if not changes:
        return changes
    path = config.__file__
    with open(path, encoding="utf-8") as f:
        src = f.read()
    for side, base, old, new in changes:
        # DUP_RESOLUTION 블록 내 해당 base 라인만 치환
        pat = re.compile(
            r'("' + re.escape(base) + r'"\s*:\s*)"' + re.escape(old) + r'"'
        )
        src, n = pat.subn(r'\1"' + new + '"', src, count=1)
        if n == 0:
            changes = [(s, b, o, nv) for (s, b, o, nv) in changes
                       if not (s == side and b == base)]
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)
    return changes


# ── S3 부모=자식합 ─────────────────────────────────────────────────────
def _check_parent_sum(values, registry, id2name):
    tol = config.TOL
    violations = []
    total = 0
    ok = 0
    for side in ("in", "ex"):
        # parent code -> child keys
        children = {}
        for a in registry[side]:
            if a["p"]:
                children.setdefault(a["p"], []).append(a["code"])
        # parent code -> its own key (lv1/lv2 만 대상)
        parent_keys = {a["code"]: a for a in registry[side] if a["lv"] in (1, 2)}
        for (year, sid), sides in values.items():
            slot = sides.get(side)
            if not slot:
                continue
            name = id2name.get(sid, str(sid))
            for pcode, pinfo in parent_keys.items():
                kids = children.get(pcode)
                if not kids:
                    continue
                csum = sum(slot.get(k, 0) for k in kids)
                pval = slot.get(pcode, 0)
                total += 1
                allow = tol * len(kids)
                if abs(csum - pval) <= allow:
                    ok += 1
                else:
                    violations.append((abs(csum - pval), year, name, side,
                                       pcode, csum, pval))
    violations.sort(key=lambda x: -x[0])
    return {"total": total, "ok": ok, "violations": violations}


# ── S1 표본 ────────────────────────────────────────────────────────────
def _check_sample(values, school_records, raw_name_count):
    year_counts = {}
    for (year, sid), sides in values.items():
        if "in" in sides:
            year_counts.setdefault(year, set()).add(sid)
    year_n = {y: len(s) for y, s in year_counts.items()}

    # 고유 학교 = 원본 distinct 학교명(391). 병합 후 school_id 수는 별도 보고.
    unique = raw_name_count
    merged = len(school_records)

    kmu_sid = None
    for s in school_records:
        if s["canonical"] == config.KMU_NAME:
            kmu_sid = s["school_id"]
            break
    kmu_years = sorted(y for (y, sid) in values if sid == kmu_sid) if kmu_sid else []

    checks = []
    ok = True
    for y in config.YEARS:
        n = year_n.get(y, 0)
        lo, hi = (147, 154) if y <= 2020 else (332, 335)
        p = lo <= n <= hi
        ok &= p
        checks.append({"year": y, "n": n, "range": [lo, hi], "pass": p})
    unique_ok = unique == 391
    kmu_ok = kmu_years == config.YEARS
    ok = ok and unique_ok and kmu_ok
    return {
        "pass": bool(ok),
        "year_counts": year_n,
        "year_checks": checks,
        "unique": unique, "unique_pass": unique_ok,
        "merged_schools": merged,
        "kmu_years": kmu_years, "kmu_pass": kmu_ok,
    }


# ── 리포트 조립 ────────────────────────────────────────────────────────
def _rate(rows):
    n = len(rows)
    p = sum(1 for r in rows if r[0])
    return {"total": n, "pass": p, "fail": n - p,
            "rate": (p / n) if n else None}


def _yearly(rows):
    d = {}
    for ok, year, *_ in rows:
        e = d.setdefault(year, [0, 0])
        if ok:
            e[0] += 1
        else:
            e[1] += 1
    return {y: {"pass": v[0], "fail": v[1]} for y, v in sorted(d.items())}


def _top_viol(rows, n=20):
    fails = [r for r in rows if not r[0]]
    fails.sort(key=lambda r: -abs(r[3] - r[4]))
    return [{"year": y, "school": s, "lhs": lhs, "rhs": rhs, "diff": lhs - rhs}
            for (_, y, s, lhs, rhs) in fails[:n]]


def run(extracted, registry, name_to_id, school_records, write=True):
    t0 = time.time()
    _init_lv1(registry)
    id2name = {s["school_id"]: s["canonical"] for s in school_records}

    values, present = build_values(extracted, registry, name_to_id)

    idr = _check_identity(values, present, id2name)
    dup = _dup_probe(values, registry)
    dup_changes = _apply_config_fix(dup)
    s3 = _check_parent_sum(values, registry, id2name)
    raw_names = set()
    for side in ("in", "ex"):
        for r in extracted[side][1]:
            if r[1] is not None and r[1] != "":
                raw_names.add(r[1])
    s1 = _check_sample(values, school_records, len(raw_names))

    report = {
        "identities": {
            "I1_수입총계=지출총계": {**_rate(idr["I1"]), "yearly": _yearly(idr["I1"]),
                                 "top_violations": _top_viol(idr["I1"])},
            "I2_이월연속성": {**_rate(idr["I2"]), "yearly": _yearly(idr["I2"]),
                          "top_violations": _top_viol(idr["I2"])},
            "I3_수입관합=총계": {**_rate(idr["I3_in"]), "yearly": _yearly(idr["I3_in"]),
                             "top_violations": _top_viol(idr["I3_in"]), "note": "리포트 전용"},
            "I3_지출관합=총계": {**_rate(idr["I3_ex"]), "yearly": _yearly(idr["I3_ex"]),
                             "top_violations": _top_viol(idr["I3_ex"]), "note": "리포트 전용"},
        },
        "S1_sample": s1,
        "S2_dup_probe": {"verdicts": dup, "config_changes": [
            {"side": s, "base": b, "from": o, "to": nv} for (s, b, o, nv) in dup_changes]},
        "S3_parent_sum": {
            "total": s3["total"], "ok": s3["ok"],
            "fail": s3["total"] - s3["ok"],
            "rate": s3["ok"] / s3["total"] if s3["total"] else None,
            "top_violations": [
                {"year": y, "school": s, "side": sd, "parent": pc,
                 "child_sum": cs, "parent_val": pv, "diff": cs - pv}
                for (_, y, s, sd, pc, cs, pv) in s3["violations"][:20]],
        },
        "elapsed_sec": round(time.time() - t0, 2),
    }

    if write:
        config.INTERIM_DIR.mkdir(parents=True, exist_ok=True)
        with open(config.INTERIM_DIR / "validation_report.json", "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
        _write_md(report)

    return report, s1["pass"]


def _pct(x):
    return f"{x*100:.2f}%" if x is not None else "n/a"


def _write_md(rep):
    L = []
    L.append("# 자금계산서 ETL 검증 리포트\n")
    L.append("## 항등식 검증\n")
    L.append("| 규칙 | 통과 | 실패 | 통과율 |")
    L.append("|---|---|---|---|")
    for name, r in rep["identities"].items():
        L.append(f"| {name} | {r['pass']} | {r['fail']} | {_pct(r['rate'])} |")
    L.append("")
    for name, r in rep["identities"].items():
        if r["fail"]:
            L.append(f"### {name} 상위 위반 (최대 20)\n")
            L.append("| 연도 | 학교 | lhs | rhs | diff |")
            L.append("|---|---|---|---|---|")
            for v in r["top_violations"]:
                L.append(f"| {v['year']} | {v['school']} | {v['lhs']:,} | {v['rhs']:,} | {v['diff']:,} |")
            L.append("")

    s1 = rep["S1_sample"]
    L.append("## S1 표본 검증\n")
    L.append(f"- 전체 통과: **{s1['pass']}**")
    L.append(f"- 고유 학교명(원본 distinct): {s1['unique']} (기대 391, {'OK' if s1['unique_pass'] else 'FAIL'})")
    L.append(f"- 병합 후 school_id 수: {s1['merged_schools']} (연도별 개명 {s1['unique'] - s1['merged_schools']}건 병합)")
    L.append(f"- 국민대 연도: {s1['kmu_years']} ({'OK' if s1['kmu_pass'] else 'FAIL'})")
    L.append("\n| 연도 | 학교수 | 허용범위 | 통과 |")
    L.append("|---|---|---|---|")
    for c in s1["year_checks"]:
        L.append(f"| {c['year']} | {c['n']} | {c['range'][0]}~{c['range'][1]} | {'OK' if c['pass'] else 'FAIL'} |")
    L.append("")

    L.append("## S2 중복열 프로브\n")
    L.append("| side | base | config | 실측 | 일치 | 열수 |")
    L.append("|---|---|---|---|---|---|")
    for side in ("in", "ex"):
        for base, info in rep["S2_dup_probe"]["verdicts"][side].items():
            L.append(f"| {side} | {base} | {info['config']} | {info['probe']} | "
                     f"{'OK' if info['match'] else 'MISMATCH'} | {info['n_cols']} |")
    ch = rep["S2_dup_probe"]["config_changes"]
    if ch:
        L.append("\n**config 수정됨:** " + ", ".join(
            f"{c['side']}.{c['base']} {c['from']}→{c['to']}" for c in ch))
    else:
        L.append("\nconfig 수정 없음 (전 항목 실측과 일치).")
    L.append("")

    s3 = rep["S3_parent_sum"]
    L.append("## S3 부모=자식합 (관·항)\n")
    L.append(f"- 검사 {s3['total']}건 중 통과 {s3['ok']} / 실패 {s3['fail']} "
             f"(통과율 {_pct(s3['rate'])})\n")
    if s3["top_violations"]:
        L.append("| 연도 | 학교 | side | parent | 자식합 | 부모값 | diff |")
        L.append("|---|---|---|---|---|---|---|")
        for v in s3["top_violations"]:
            L.append(f"| {v['year']} | {v['school']} | {v['side']} | {v['parent']} | "
                     f"{v['child_sum']:,} | {v['parent_val']:,} | {v['diff']:,} |")
    L.append("")
    with open(config.INTERIM_DIR / "validation_report.md", "w", encoding="utf-8") as f:
        f.write("\n".join(L))
