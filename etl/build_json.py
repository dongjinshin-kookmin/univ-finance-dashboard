# -*- coding: utf-8 -*-
"""실데이터 → 대시보드 JSON(full/lite) 생성.

입력(모두 U1·U2 산출):
  build/interim/tidy.csv.gz           (year, school_id, side, account_key, amount 천원)
  build/interim/schools.csv           (school_id, canonical, aliases, years, c100)
  build/interim/accounts.json         ({"in":[{code,name,lv,p,col_idx}], "ex":[...]})
  build/interim/schools_meta.csv      (canonical, sido, region, school_type, ... enroll_YYYY, scale)
  build/interim/validation_report.json

산출:
  build/dashboard_data.json       (full — 목 수준 포함)
  build/dashboard_data_lite.json  (lv3=목 제거, meta.lite=true)

columnar 스키마: rows=[[schoolId,year]] 정렬 공유, v/kpi 배열은 rows 인덱스 정렬.
희소 계정(비결측률<10%)은 {"s":1,"i":[행idx],"x":[값]} 로 인코딩.
"""
import csv
import gzip
import json
from datetime import datetime, timezone

import config
import ext_data
import metrics

# 희소 인코딩 임계(비결측률)
SPARSE_THRESHOLD = 0.10


def _load_tidy():
    """tidy.csv.gz → lookup[(school_id, year)][side][code] = amount(int)."""
    lookup = {}
    with gzip.open(config.INTERIM_DIR / "tidy.csv.gz", "rt", encoding="utf-8") as fh:
        r = csv.DictReader(fh)
        for row in r:
            sid = int(row["school_id"])
            yr = int(row["year"])
            amt = row["amount"]
            if amt == "" or amt is None:
                continue
            val = int(round(float(amt)))
            lookup.setdefault((sid, yr), {"in": {}, "ex": {}})[row["side"]][
                row["account_key"]
            ] = val
    return lookup


def _load_schools():
    rows = []
    with open(config.INTERIM_DIR / "schools.csv", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            rows.append(row)
    rows.sort(key=lambda x: int(x["school_id"]))
    return rows


def _load_meta():
    meta = {}
    with open(config.INTERIM_DIR / "schools_meta.csv", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            meta[row["canonical"]] = row
    return meta


def _load_accounts():
    with open(config.INTERIM_DIR / "accounts.json", encoding="utf-8") as fh:
        return json.load(fh)


def _num(s):
    if s is None or s == "":
        return None
    try:
        return int(round(float(s)))
    except ValueError:
        return None


def _build_schools(school_rows, meta):
    """schools 배열 + 미조인 수. 배열 인덱스 = school_id-1(정렬 순서)."""
    out = []
    unmatched = 0
    for s in school_rows:
        canon = s["canonical"]
        m = meta.get(canon)
        entry = {
            "n": canon,
            "c100": s.get("c100", "0") in ("1", "True", "true"),
            "kmu": canon == config.KMU_NAME,
        }
        if m is None:
            unmatched += 1
            entry.update(
                {"sido": None, "region": None, "type": None, "scale": None,
                 "scaleProxy": False, "enroll": None}
            )
        else:
            enroll = {}
            for y in config.YEARS:
                v = _num(m.get(f"enroll_{y}"))
                if v is not None:
                    enroll[str(y)] = v
            entry.update(
                {
                    "sido": m.get("sido") or None,
                    "region": m.get("region") or None,
                    "type": m.get("school_type") or None,
                    "scale": m.get("scale") or None,
                    "scaleProxy": False,
                    "enroll": enroll or None,
                }
            )
        out.append(entry)
    return out, unmatched


def _build_rows(lookup, school_rows):
    """rows=[[schoolId, year]] — school_id 순, 연도 순. schoolId = 배열 인덱스."""
    id_to_idx = {int(s["school_id"]): i for i, s in enumerate(school_rows)}
    rows = []
    for sid, yr in sorted(lookup.keys()):
        rows.append([id_to_idx[sid], yr, sid])  # sid 임시 보관(다음 단계용)
    # 스키마용 [schoolId, year] 과 조회용 (sid,yr) 분리
    pub_rows = [[r[0], r[1]] for r in rows]
    key_rows = [(r[2], r[1]) for r in rows]
    return pub_rows, key_rows


def _encode_column(values):
    """dense list 또는 sparse {s,i,x}. 비결측률<임계 → sparse."""
    n = len(values)
    nonnull = [(i, v) for i, v in enumerate(values) if v is not None]
    if n and (len(nonnull) / n) < SPARSE_THRESHOLD:
        return {"s": 1, "i": [i for i, _ in nonnull], "x": [v for _, v in nonnull]}
    return values


def _build_v(accounts, lookup, key_rows):
    """v = {side: {code: dense|sparse}}. accounts.json 코드 순서 유지."""
    v = {"in": {}, "ex": {}}
    for side in ("in", "ex"):
        for a in accounts[side]:
            code = a["code"]
            col = []
            for sid, yr in key_rows:
                cell = lookup.get((sid, yr))
                col.append(cell[side].get(code) if cell else None)
            v[side][code] = _encode_column(col)
    return v


def _build_kpi(lookup, key_rows, compiled):
    """kpi = {지표명: [rows 정렬]}."""
    names = list(compiled.keys())
    kpi = {name: [] for name in names}
    for sid, yr in key_rows:
        cell = lookup.get((sid, yr)) or {"in": {}, "ex": {}}

        def getval(side, key, _cell=cell):
            return _cell[side].get(key)

        res = metrics.compute_kpis(getval, compiled)
        for name in names:
            kpi[name].append(res[name])
    return kpi


def _quantiles(sorted_vals):
    """p25, p50, p75 (선형보간, numpy 미의존)."""
    def q(p):
        if not sorted_vals:
            return None
        if len(sorted_vals) == 1:
            return sorted_vals[0]
        idx = p * (len(sorted_vals) - 1)
        lo = int(idx)
        frac = idx - lo
        if lo + 1 < len(sorted_vals):
            return sorted_vals[lo] + (sorted_vals[lo + 1] - sorted_vals[lo]) * frac
        return sorted_vals[lo]

    return q(0.25), q(0.50), q(0.75)


def _build_agg(kpi, pub_rows, schools, compiled):
    """agg = {"all":{지표:{year:[p25,p50,p75,mean]}}, "c100":{...}}. null 제외."""
    fmt = {name: compiled[name][2] for name in compiled}
    c100_flags = [s["c100"] for s in schools]

    def agg_for(mask):
        result = {}
        for name in kpi:
            per_year = {}
            years = {}
            for i, (sid_idx, yr) in enumerate(pub_rows):
                if not mask(sid_idx):
                    continue
                val = kpi[name][i]
                if val is None:
                    continue
                years.setdefault(yr, []).append(val)
            for yr, vals in sorted(years.items()):
                vals.sort()
                p25, p50, p75 = _quantiles(vals)
                mean = sum(vals) / len(vals)
                if fmt[name] == "pct":
                    stat = [round(p25, 4), round(p50, 4), round(p75, 4), round(mean, 4)]
                else:
                    stat = [int(round(p25)), int(round(p50)),
                            int(round(p75)), int(round(mean))]
                per_year[str(yr)] = stat
            result[name] = per_year
        return result

    return {
        "all": agg_for(lambda idx: True),
        "c100": agg_for(lambda idx: c100_flags[idx]),
    }


def _build_validation(school_rows):
    """validation_report.json → {"summary":{I1,I2,I3},"top":[≤20]}."""
    with open(config.INTERIM_DIR / "validation_report.json", encoding="utf-8") as fh:
        rep = json.load(fh)
    idn = rep["identities"]

    i1 = idn["I1_수입총계=지출총계"]
    i2 = idn["I2_이월연속성"]
    i3a = idn["I3_수입관합=총계"]
    i3b = idn["I3_지출관합=총계"]

    summary = {
        "I1": {"pass": i1["pass"], "fail": i1["fail"]},
        "I2": {"pass": i2["pass"], "fail": i2["fail"]},
        "I3": {"pass": i3a["pass"] + i3b["pass"], "fail": i3a["fail"] + i3b["fail"]},
    }

    top = []
    rule_src = [("I1", i1), ("I2", i2), ("I3", i3a), ("I3", i3b)]
    for rule, block in rule_src:
        for v in block.get("top_violations", []):
            top.append(
                {
                    "rule": rule,
                    "year": v["year"],
                    "school": v["school"],
                    "lhs": v["lhs"],
                    "rhs": v["rhs"],
                    "diff": v["diff"],
                }
            )
    top.sort(key=lambda x: abs(x["diff"]), reverse=True)
    return {"summary": summary, "top": top[:20]}


def _accounts_public(accounts, drop_lv3=False):
    """col_idx 제외. drop_lv3 → lv==3(목) 제거."""
    out = {"in": [], "ex": []}
    for side in ("in", "ex"):
        for a in accounts[side]:
            if drop_lv3 and a["lv"] == 3:
                continue
            out[side].append({"code": a["code"], "name": a["name"],
                              "lv": a["lv"], "p": a["p"]})
    return out


def _lite_v(v, accounts):
    """lv3 계정 코드를 v 에서 제거한 새 dict."""
    lv3 = {"in": set(), "ex": set()}
    for side in ("in", "ex"):
        for a in accounts[side]:
            if a["lv"] == 3:
                lv3[side].add(a["code"])
    return {side: {c: col for c, col in v[side].items() if c not in lv3[side]}
            for side in ("in", "ex")}


def _assert_integrity(doc, accounts):
    """무결성 자동검증 — 실패 시 AssertionError."""
    nrows = len(doc["rows"])

    # 1) v/kpi 배열 길이 == rows 길이(sparse 제외)
    for side in ("in", "ex"):
        for code, col in doc["v"][side].items():
            if isinstance(col, dict):
                assert col.get("s") == 1
                assert len(col["i"]) == len(col["x"])
                assert all(0 <= i < nrows for i in col["i"])
            else:
                assert len(col) == nrows, f"v.{side}.{code} 길이 {len(col)}≠{nrows}"
    for name, arr in doc["kpi"].items():
        assert len(arr) == nrows, f"kpi.{name} 길이 {len(arr)}≠{nrows}"

    # 2) accounts 코드 참조 무결성: v 의 모든 코드가 accounts 에 존재
    acc_codes = {side: {a["code"] for a in doc["accounts"][side]}
                 for side in ("in", "ex")}
    for side in ("in", "ex"):
        for code in doc["v"][side]:
            assert code in acc_codes[side], f"v.{side}.{code} 미정의 계정"

    # 3) lv0 의사계정 필수 포함
    for c in ("T_IN", "OP_IN", "AL_IN", "CF_PREV"):
        assert c in doc["v"]["in"], f"필수 의사계정 {c} 누락"
    for c in ("T_EX", "OP_EX", "AL_EX", "CF_NEXT"):
        assert c in doc["v"]["ex"], f"필수 의사계정 {c} 누락"


def _colval(col, i):
    """dense/sparse 공통 조회."""
    if isinstance(col, dict):
        try:
            j = col["i"].index(i)
            return col["x"][j]
        except ValueError:
            return None
    return col[i]


def _assert_full_lite_consistency(full, lite):
    """full↔lite 관(lv1)·항(lv2) 값 일치."""
    nrows = len(full["rows"])
    assert full["rows"] == lite["rows"]
    keep = {side: {a["code"] for a in lite["accounts"][side]}
            for side in ("in", "ex")}
    for side in ("in", "ex"):
        for code in keep[side]:
            fc = full["v"][side].get(code)
            lc = lite["v"][side].get(code)
            assert lc is not None, f"lite v.{side}.{code} 누락"
            for i in range(nrows):
                assert _colval(fc, i) == _colval(lc, i), \
                    f"full/lite 불일치 {side}.{code}[{i}]"


def _assert_ext_integrity(doc):
    """ext 무결성 — 실패 시 AssertionError."""
    nrows = len(doc["rows"])
    nschools = len(doc["schools"])
    ext = doc["ext"]
    for name, arr in ext["series"].items():
        assert len(arr) == nrows, f"ext.series.{name} 길이 {len(arr)}≠{nrows}"
    for name, arr in ext["kpi2"].items():
        assert len(arr) == nrows, f"ext.kpi2.{name} 길이 {len(arr)}≠{nrows}"
    assert len(ext["schools_extra"]) == nschools, \
        f"ext.schools_extra 길이 {len(ext['schools_extra'])}≠{nschools}"
    pop = ext["population"]
    ns, ny = len(pop["sidos"]), len(pop["years"])
    for key in ("age18_21", "age6_21"):
        assert len(pop[key]) == ns, f"ext.population.{key} 시도수 불일치"
        assert all(len(r) == ny for r in pop[key]), f"ext.population.{key} 연도수 불일치"
    assert len(ext["region_outlook"]) == ns, "region_outlook 시도수 불일치"
    ct = ext["closure_traj"]
    for key in ("충원율", "운영수지율", "등록금의존율"):
        assert len(ct[key]) == len(ct["offsets"]), f"closure_traj.{key} 길이 불일치"


def _write(doc, path):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
    return path.stat().st_size


def run():
    """전체 실행. 반환: 요약 dict."""
    lookup = _load_tidy()
    school_rows = _load_schools()
    meta = _load_meta()
    accounts = _load_accounts()

    schools, unmatched = _build_schools(school_rows, meta)
    pub_rows, key_rows = _build_rows(lookup, school_rows)

    existing = {("in", a["code"]) for a in accounts["in"]}
    existing |= {("ex", a["code"]) for a in accounts["ex"]}
    compiled = metrics.compile_formulas(config.KPI_FORMULAS)
    missing = metrics.formula_missing_keys(config.KPI_FORMULAS, existing)

    v = _build_v(accounts, lookup, key_rows)
    kpi = _build_kpi(lookup, key_rows, compiled)
    agg = _build_agg(kpi, pub_rows, schools, compiled)
    validation = _build_validation(school_rows)
    ext = ext_data.build_ext(school_rows, key_rows, pub_rows, lookup, kpi)

    generated = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    def make(lite):
        return {
            "meta": {
                "unit": config.UNIT,
                "years": config.YEARS,
                "generated": generated,
                "lite": lite,
                "notes": config.TIMELINE_NOTES,
            },
            "schools": schools,
            "accounts": _accounts_public(accounts, drop_lv3=lite),
            "rows": pub_rows,
            "v": _lite_v(v, accounts) if lite else v,
            "kpi": kpi,
            "agg": agg,
            "validation": validation,
            "ext": ext,
        }

    full = make(False)
    lite = make(True)

    _assert_integrity(full, accounts)
    _assert_integrity(lite, accounts)
    _assert_full_lite_consistency(full, lite)
    _assert_ext_integrity(full)
    _assert_ext_integrity(lite)
    assert full["ext"] == lite["ext"], "full/lite ext 불일치"

    full_path = config.BUILD_DIR / "dashboard_data.json"
    lite_path = config.BUILD_DIR / "dashboard_data_lite.json"
    full_size = _write(full, full_path)
    lite_size = _write(lite, lite_path)

    # 재파싱 성공 검증
    with open(full_path, encoding="utf-8") as fh:
        json.load(fh)
    with open(lite_path, encoding="utf-8") as fh:
        json.load(fh)

    def _cov(arr):
        n = len(arr)
        return round(sum(1 for x in arr if x is not None) / n, 4) if n else 0.0

    ext_cov = {name: _cov(arr) for name, arr in ext["series"].items()}
    ext_cov.update({name: _cov(arr) for name, arr in ext["kpi2"].items()})

    return {
        "full_size": full_size,
        "lite_size": lite_size,
        "n_rows": len(pub_rows),
        "n_schools": len(schools),
        "unmatched": unmatched,
        "missing_keys": missing,
        "full_path": full_path,
        "lite_path": lite_path,
        "ext_cov": ext_cov,
        "closure_n": ext["closure_traj"]["n"],
    }


if __name__ == "__main__":
    s = run()
    print(f"full {s['full_size']/1e6:.2f}MB  lite {s['lite_size']/1e6:.2f}MB")
    print(f"rows {s['n_rows']}  schools {s['n_schools']}  미조인 {s['unmatched']}")
    print(f"0 처리 산식 키: {s['missing_keys'] or '없음'}")
