# -*- coding: utf-8 -*-
"""확장 ETL(E4) 데이터 로딩 + ext 블록 조립.

입력(모두 build/interim/):
  balance_sheet.csv        (canonical, year, reserve_total, ...)
  closed_schools.csv       (canonical, closed_year, ...)
  school_master.csv        (canonical, school_code, sido, ...)
  enrollment_metrics.csv   (canonical, year, admission_quota, admitted, fill_rate, ...)
  population_projection.csv(sido(전체명), year, age_group, population, is_projection)
  corp_accounts.csv        (corp_name, year=2024, revenue_net, transfer_to_school, levy_transfer)
  corp_school_map.csv      (corp_name, canonical)

산출: 기존 dashboard JSON 스키마에 추가되는 "ext" dict.
조인 키는 canonical(기존 schools.csv 정규화와 동일).
"""
import csv

import config
import metrics2

# 인구추계 sido 전체명 → 학교 sido 약칭
SIDO_FULL_TO_SHORT = {
    "강원도": "강원", "경기도": "경기", "경상남도": "경남", "경상북도": "경북",
    "광주광역시": "광주", "대구광역시": "대구", "대전광역시": "대전",
    "부산광역시": "부산", "서울특별시": "서울", "세종특별자치시": "세종",
    "울산광역시": "울산", "인천광역시": "인천", "전라남도": "전남",
    "전라북도": "전북", "제주특별자치도": "제주", "충청남도": "충남",
    "충청북도": "충북",
}
POP_YEARS = list(range(2022, 2053))
DECLINE_BASE, DECLINE_TARGET = 2024, 2040

_SOURCES = [
    "balance_sheet.csv(대차대조표 적립금·자산·부채)",
    "closed_schools.csv(폐교대학)",
    "school_master.csv(학교 기본정보·학교코드)",
    "enrollment_metrics.csv(입학정원·충원율)",
    "population_projection.csv(통계청 시도 장래인구추계 2022~2052)",
    "corp_accounts.csv·corp_school_map.csv(2024 법인회계 스냅샷)",
]


def _rows(name, enc="utf-8-sig"):
    with open(config.INTERIM_DIR / name, encoding=enc) as fh:
        return list(csv.DictReader(fh))


def _num(s):
    if s is None or s == "":
        return None
    try:
        return int(round(float(s)))
    except (ValueError, TypeError):
        return None


def _fnum(s):
    if s is None or s == "":
        return None
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


def _load():
    """모든 확장 CSV → 조인용 dict."""
    d = {}
    # balance_sheet: (canonical, year) → reserve_total(천원)
    reserve = {}
    for r in _rows("balance_sheet.csv"):
        y = _num(r.get("year"))
        rt = _num(r.get("reserve_total"))
        if y is not None:
            reserve[(r["canonical"], y)] = rt
    d["reserve"] = reserve

    # enrollment: (canonical, year) → {quota, admitted, fill}
    enroll = {}
    for r in _rows("enrollment_metrics.csv"):
        y = _num(r.get("year"))
        if y is None:
            continue
        enroll[(r["canonical"], y)] = {
            "quota": _num(r.get("admission_quota")),
            "admitted": _num(r.get("admitted")),
            "fill": _fnum(r.get("fill_rate")),
        }
    d["enroll"] = enroll

    # school_master: canonical → {code, sido}
    master = {}
    for r in _rows("school_master.csv"):
        master[r["canonical"]] = {
            "code": (r.get("school_code") or "").strip() or None,
            "sido": (r.get("sido") or "").strip() or None,
        }
    d["master"] = master

    # closed_schools: canonical → closed_year
    closed = {}
    for r in _rows("closed_schools.csv"):
        cy = _num(r.get("closed_year"))
        if cy is not None:
            closed[r["canonical"]] = cy
    d["closed"] = closed

    # corp_school_map: canonical → corp_name
    corp_of = {}
    for r in _rows("corp_school_map.csv"):
        corp_of[r["canonical"]] = r["corp_name"]
    d["corp_of"] = corp_of

    # corp_accounts(2024): corp_name → {transfer, levy, revenue}
    corp_acct = {}
    for r in _rows("corp_accounts.csv"):
        corp_acct[r["corp_name"]] = {
            "transfer": _num(r.get("transfer_to_school")),
            "levy": _num(r.get("levy_transfer")),
            "revenue": _num(r.get("revenue_net")),
        }
    d["corp_acct"] = corp_acct

    # population: sido(약칭) → {age_group_key: {year: population}}
    pop = {short: {"18_21": {}, "6_21": {}} for short in SIDO_FULL_TO_SHORT.values()}
    for r in _rows("population_projection.csv"):
        short = SIDO_FULL_TO_SHORT.get(r["sido"])
        if short is None:
            continue
        y = _num(r.get("year"))
        val = _num(r.get("population"))
        ag = r.get("age_group", "")
        key = "18_21" if ag.startswith("대학학령") else "6_21"
        if y is not None:
            pop[short][key][y] = val
    d["pop"] = pop
    return d


def _sido_decline18(pop, sido):
    """시도 18-21세 (2040-2024)/2024. 결측 → None."""
    ser = pop.get(sido, {}).get("18_21", {})
    base = ser.get(DECLINE_BASE)
    tgt = ser.get(DECLINE_TARGET)
    if not base or tgt is None:
        return None
    return round((tgt - base) / base, 4)


def _latest(school_years, value_fn):
    """school_years: 해당 학교의 연도 오름차순 목록. 최신 연도부터 non-null 반환."""
    for y in reversed(school_years):
        v = value_fn(y)
        if v is not None:
            return v
    return None


def build_ext(school_rows, key_rows, pub_rows, lookup, kpi):
    """ext 블록 조립.

    school_rows: schools.csv 정렬(schools 배열/인덱스와 동일 순서)
    key_rows: [(school_id, year)] — rows 정렬과 1:1
    pub_rows: [[schoolIdx, year]] — key_rows와 동일 순서
    lookup: (school_id, year) → {"in":{code:val}, "ex":{code:val}}
    kpi: {지표명: [rows 정렬 배열]}
    """
    data = _load()
    reserve, enroll, master = data["reserve"], data["enroll"], data["master"]
    closed, corp_of, corp_acct, pop = (
        data["closed"], data["corp_of"], data["corp_acct"], data["pop"])

    n = len(key_rows)
    # school_id → canonical, school_id → schools 배열 인덱스
    sid_to_canon = {int(s["school_id"]): s["canonical"] for s in school_rows}
    idx_to_canon = [s["canonical"] for s in school_rows]
    sid_to_idx = {int(s["school_id"]): i for i, s in enumerate(school_rows)}

    # 학교별 rows 인덱스(연도 오름차순으로 자연 정렬됨)
    rows_by_sid = {}
    for i, (sid, yr) in enumerate(key_rows):
        rows_by_sid.setdefault(sid, []).append((yr, i))

    # ── series ──────────────────────────────────────────────
    ser_reserve, ser_fill = [None] * n, [None] * n
    ser_quota, ser_admit = [None] * n, [None] * n
    for i, (sid, yr) in enumerate(key_rows):
        canon = sid_to_canon[sid]
        ser_reserve[i] = reserve.get((canon, yr))
        e = enroll.get((canon, yr))
        if e:
            ser_fill[i] = e["fill"]
            ser_quota[i] = e["quota"]
            ser_admit[i] = e["admitted"]

    # ── kpi2: 적립금지속월수 (per row) ───────────────────────
    months = [None] * n
    for i, (sid, yr) in enumerate(key_rows):
        cell = lookup.get((sid, yr))
        op_ex = cell["ex"].get("OP_EX") if cell else None
        months[i] = metrics2.reserve_months(ser_reserve[i], op_ex)

    # ── 위기스코어(학교 단위, 최신 가용 연도) ───────────────
    # kpi 배열에서 학교별 최신 non-null 조회용 헬퍼
    dep_arr = kpi.get("등록금의존율_총계", [None] * n)
    sur_arr = kpi.get("운영수지율", [None] * n)

    def latest_from_arr(sid, arr):
        for yr, i in sorted(rows_by_sid.get(sid, []), reverse=True):
            if arr[i] is not None:
                return arr[i]
        return None

    school_ids = sorted(rows_by_sid.keys())
    f_fill, f_dep, f_sur, f_mon, f_dec = {}, {}, {}, {}, {}
    for sid in school_ids:
        canon = sid_to_canon[sid]
        yrs = sorted(y for y, _ in rows_by_sid[sid])
        # ① 충원율(최신 가용) → risk = -fill
        fv = _latest(yrs, lambda y, _c=canon: (enroll.get((_c, y)) or {}).get("fill"))
        if fv is not None:
            f_fill[sid] = -fv
        # ② 등록금의존율_총계 → risk = +dep
        dv = latest_from_arr(sid, dep_arr)
        if dv is not None:
            f_dep[sid] = dv
        # ③ 운영수지율 → risk = -surplus
        sv = latest_from_arr(sid, sur_arr)
        if sv is not None:
            f_sur[sid] = -sv
        # ④ 적립금지속월수 → risk = -months
        mv = latest_from_arr(sid, months)
        if mv is not None:
            f_mon[sid] = -mv
        # ⑤ 시도 18-21세 감소율 → risk = -decline
        sido = (master.get(canon) or {}).get("sido")
        dec = _sido_decline18(pop, sido) if sido else None
        if dec is not None:
            f_dec[sid] = -dec

    factor_values = {
        "충원율": f_fill, "등록금의존율": f_dep, "운영수지율": f_sur,
        "적립금지속월수": f_mon, "시도인구감소": f_dec,
    }
    scores = metrics2.crisis_scores(school_ids, factor_values)
    crisis_arr = [scores.get(sid) for sid, _ in key_rows]  # 학교 단위 값을 각 행에 복제

    # ── schools_extra (schools 인덱스 정렬) ──────────────────
    schools_extra = []
    for idx, canon in enumerate(idx_to_canon):
        m = master.get(canon) or {}
        corp = corp_of.get(canon)
        acct = corp_acct.get(corp) if corp else None
        schools_extra.append({
            "code": m.get("code"),
            "corp": corp,
            "closed": closed.get(canon),
            "corp2024": ({"transfer": acct["transfer"], "levy": acct["levy"],
                          "revenue": acct["revenue"]} if acct else None),
        })

    # ── population 블록 ─────────────────────────────────────
    sidos = sorted(SIDO_FULL_TO_SHORT.values())
    age18 = [[pop[s]["18_21"].get(y) for y in POP_YEARS] for s in sidos]
    age6 = [[pop[s]["6_21"].get(y) for y in POP_YEARS] for s in sidos]

    # ── region_outlook ─────────────────────────────────────
    # 학교 sido별 집계(2024 충원율·등록금의존율). uni_count = 소재 학교 수.
    by_sido = {s: {"count": 0, "fills": [], "deps": []} for s in sidos}
    for sid in school_ids:
        canon = sid_to_canon[sid]
        sido = (master.get(canon) or {}).get("sido")
        if sido not in by_sido:
            continue
        by_sido[sido]["count"] += 1
        e = enroll.get((canon, 2024))
        if e and e["fill"] is not None:
            by_sido[sido]["fills"].append(e["fill"])
        # 2024 등록금의존율_총계
        for yr, i in rows_by_sid[sid]:
            if yr == 2024 and dep_arr[i] is not None:
                by_sido[sido]["deps"].append(dep_arr[i])

    region_outlook = []
    for s in sidos:
        agg = by_sido[s]
        af = metrics2.mean(agg["fills"])
        ad = metrics2.mean(agg["deps"])
        region_outlook.append({
            "sido": s,
            "region": _region_of(s),
            "decline18_2040": _sido_decline18(pop, s),
            "uni_count": agg["count"],
            "avg_fill": round(af, 4) if af is not None else None,
            "avg_dep": round(ad, 4) if ad is not None else None,
        })

    # ── closure_traj ────────────────────────────────────────
    offsets = [-5, -4, -3, -2, -1]
    contrib = {}  # canonical → {offset: {fill, opr, dep}}
    for canon, cy in closed.items():
        sid = next((k for k, v in sid_to_canon.items() if v == canon), None)
        if sid is None:
            continue
        contrib[canon] = {}
        for off in offsets:
            y = cy + off
            fill = (enroll.get((canon, y)) or {}).get("fill")
            opr = dep = None
            for yr, i in rows_by_sid.get(sid, []):
                if yr == y:
                    opr = sur_arr[i]
                    dep = dep_arr[i]
                    break
            contrib[canon][off] = {"fill": fill, "opr": opr, "dep": dep}

    def off_median(field):
        return [metrics2.median([contrib[c][off][field] for c in contrib])
                for off in offsets]

    closure_traj = {
        "offsets": offsets,
        "충원율": off_median("fill"),
        "운영수지율": off_median("opr"),
        "등록금의존율": off_median("dep"),
        "n": len(contrib),
    }

    notes = [
        "위기스코어는 학교 단위 값(최신 가용 연도)이며 kpi2.위기스코어 배열에는 "
        "해당 학교의 모든 연도 행에 동일 값을 복제해 저장한다.",
        "적립금총액(reserve_total)은 9개년 전체, 적립금 원금/재량·기본재산은 2024만 수집됨.",
        "충원율·입학정원·입학자수는 enrollment_metrics(2016~2024) 기준.",
    ]
    if closure_traj["n"] < 3:
        notes.append(f"closure_traj 표본 {closure_traj['n']}교로 3교 미만 — 궤적 중앙값 신뢰 한계.")
    else:
        notes.append(
            f"closure_traj 표본 {closure_traj['n']}교. tidy 범위(2016~2024) 밖 오프셋 연도는 "
            "운영수지율·등록금의존율이 결측이라 오프셋별 표본 수가 다를 수 있음.")

    return {
        "series": {
            "적립금총액": ser_reserve,
            "충원율": ser_fill,
            "입학정원": ser_quota,
            "입학자수": ser_admit,
        },
        "kpi2": {
            "적립금지속월수": months,
            "위기스코어": crisis_arr,
        },
        "schools_extra": schools_extra,
        "population": {
            "sidos": sidos,
            "years": POP_YEARS,
            "age18_21": age18,
            "age6_21": age6,
        },
        "region_outlook": region_outlook,
        "closure_traj": closure_traj,
        "meta2": {
            "위기스코어_정의": metrics2.CRISIS_DEF,
            "sources": _SOURCES,
            "notes": notes,
        },
    }


def _region_of(sido):
    for region, members in config.REGION_MAP.items():
        if sido in members:
            return region
    return "지방권"
