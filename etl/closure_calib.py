# -*- coding: utf-8 -*-
"""폐교 보정 데이터셋 조립 (WBS A9).

설계: docs/폐교위험_판정_설계.md §0(폐교 패널)·§5(역검증)·§7-6(대학원대 미분류)·§9(A9).
D6 역검증 하니스(민감도·특이도·lead-time·LOO)의 입력. 여기서는 look-ahead 없이
관측 지표만 적재하고, 판정 로직(매트릭스·오버라이드)은 B5/D6가 담당한다.

산출: build/interim/closure_calib.json
  positives : 관측창 내 폐교교 × {T-1, T-2} 지표(운영수지율·충원율·적립금·적립금월수·reserve_avail)
  survivors : 명시 생존 대조군 5교(2024 스냅샷)
  disputes_I2: I2(이월연속성) 위반 13건 — 분규/회계불연속 신호(생존·폐교 혼재)
  closure_traj: ext 폐교궤적 중앙값(참조)
  reference_stats: positives/survivors 지표 중앙값 요약

look-ahead 금지: 각 지표는 해당 연도(T-k) 실측값만. 폐교 연도 이후 데이터 미사용.
폐교교는 최종연도 자금계산서 미제출이 흔해 T-1 재무지표가 결측일 수 있음(충원율은
enrollment_metrics로 별도 확보). last_fin_year에 폐교 전 마지막 재무관측 연도를 기록.

독립 실행: `python3 etl/closure_calib.py`  (선행: build/dashboard_data.json = A8 반영본)
"""
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

import config
import sim_params  # RESERVE_HAIRCUT 단일 소스

HAIRCUT = sim_params.RESERVE_HAIRCUT

# 설계 §0 폐교 패널(관측창 2016~2024 ∩ 자금계산서 보유). closed_year는 closed_schools.csv 실측으로 대조.
POSITIVE_NAMES = [
    "대구외국어대학교", "한중대학교", "한려대학교",
    "한국국제대학교", "강원관광대학교", "계약신학대학원대학교",
]
# 설계 §5 생존 대조군(명시)
SURVIVOR_NAMES = [
    "총신대학교", "국민대학교", "선린대학교", "상지대학교", "화성의과학대학교",
]
IND_KEYS = ("운영수지율", "충원율", "적립금총액", "적립금월수", "reserve_avail")


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _colval(col, i):
    if isinstance(col, dict):
        try:
            return col["x"][col["i"].index(i)]
        except (ValueError, KeyError):
            return None
    return col[i] if col is not None else None


def _load(interim, build_dir):
    doc = json.load(open(build_dir / "dashboard_data.json", encoding="utf-8"))
    enroll = {}
    for r in csv.DictReader(open(interim / "enrollment_metrics.csv", encoding="utf-8-sig")):
        y = _num(r.get("year"))
        if y is not None:
            enroll[(r["canonical"], int(y))] = _num(r.get("fill_rate"))
    bs = {}
    for r in csv.DictReader(open(interim / "balance_sheet.csv", encoding="utf-8-sig")):
        y = _num(r.get("year"))
        if y is not None:
            bs[(r["canonical"], int(y))] = {
                "reserve_total": _num(r.get("reserve_total")),
                "reserve_discretionary": _num(r.get("reserve_discretionary")),
            }
    closed = {}
    for r in csv.DictReader(open(interim / "closed_schools.csv", encoding="utf-8-sig")):
        cy = _num(r.get("closed_year"))
        if cy is not None:
            closed[r["canonical"]] = {
                "closed_year": int(cy),
                "sido": (r.get("sido") or "").strip() or None,
                "corp_status": (r.get("corp_status") or "").strip() or None,
                "school_type": (r.get("school_type") or "").strip() or None,
            }
    vr = json.load(open(interim / "validation_report.json", encoding="utf-8"))
    i2 = vr["identities"]["I2_이월연속성"].get("top_violations", [])
    return doc, enroll, bs, closed, i2


def _reserve_avail(bs_row, year):
    """설계 §7-5 haircut. 2024 재량적립금 실측 있으면 직접, 없으면 reserve_total×HAIRCUT."""
    if not bs_row:
        return None, "none"
    disc = bs_row.get("reserve_discretionary")
    total = bs_row.get("reserve_total")
    if year == 2024 and disc is not None:
        return disc, "discretionary"
    if total is not None:
        return round(total * HAIRCUT, 4), "haircut"
    return None, "none"


def _indicators(doc, rowmap, opr_arr, opex_col, enroll, bs, idx, canon, year):
    """(idx, canon, year)의 관측 지표. look-ahead 없음 — year 값만 조회."""
    ri = rowmap.get((idx, year))
    opr = opr_arr[ri] if ri is not None else None
    fill = enroll.get((canon, year))
    bs_row = bs.get((canon, year))
    reserve = bs_row.get("reserve_total") if bs_row else None
    op_ex = _colval(opex_col, ri) if ri is not None else None
    months = (round(reserve * 12.0 / op_ex, 4)
              if (reserve is not None and op_ex not in (None, 0)) else None)
    ravail, src = _reserve_avail(bs_row, year)
    return {
        "year": year,
        "운영수지율": opr,
        "충원율": fill,
        "적립금총액": reserve,
        "적립금월수": months,
        "reserve_avail": ravail,
        "reserve_avail_src": src,
        "has_fund_row": ri is not None,
    }


def _median(vals):
    xs = sorted(v for v in vals if v is not None)
    if not xs:
        return None
    m = len(xs) // 2
    return xs[m] if len(xs) % 2 else round((xs[m - 1] + xs[m]) / 2.0, 6)


def build(interim=None, build_dir=None):
    interim = Path(interim) if interim else config.INTERIM_DIR
    build_dir = Path(build_dir) if build_dir else config.BUILD_DIR
    doc, enroll, bs, closed, i2 = _load(interim, build_dir)

    schools = doc["schools"]
    name2idx = {s["n"]: i for i, s in enumerate(schools)}
    rowmap = {(si, yr): ri for ri, (si, yr) in enumerate(doc["rows"])}
    opr_arr = doc["kpi"]["운영수지율"]
    opex_col = doc["v"]["ex"].get("OP_EX")
    sim_bs = doc["sim"]["bySchool"]

    def last_fin_year(idx, before):
        yrs = [yr for (si, yr) in rowmap if si == idx and yr < before]
        return max(yrs) if yrs else None

    # ── positives ───────────────────────────────────────────
    positives = []
    reconcile = []
    for n in POSITIVE_NAMES:
        idx = name2idx.get(n)
        meta_c = closed.get(n) or {}
        cy = meta_c.get("closed_year")
        stype = schools[idx].get("type") if idx is not None else None
        status = (sim_bs[str(idx)]["flags"].get("status") if idx is not None else None)
        no_ug = bool(status == "no_ug" or (stype and "대학원" in stype))
        rec = {
            "school": n, "idx": idx,
            "closed_year": cy,
            "school_type": stype,
            "closed_school_type": meta_c.get("school_type"),
            "corp_status": meta_c.get("corp_status"),
            "sido": meta_c.get("sido"),
            "sim_status": status,
            "no_ug": no_ug,
            "last_fin_year": last_fin_year(idx, cy) if (idx is not None and cy) else None,
        }
        if idx is not None and cy is not None:
            rec["T1"] = _indicators(doc, rowmap, opr_arr, opex_col, enroll, bs,
                                    idx, n, cy - 1)
            rec["T2"] = _indicators(doc, rowmap, opr_arr, opex_col, enroll, bs,
                                    idx, n, cy - 2)
            rec["T1"]["offset"] = -1
            rec["T2"]["offset"] = -2
        positives.append(rec)
        reconcile.append(f"{n}: 설계 폐교연도 vs closed_schools.csv={cy} ({meta_c.get('school_type')}, {meta_c.get('corp_status')})")

    # ── survivors (2024 스냅샷) ──────────────────────────────
    survivors = []
    for n in SURVIVOR_NAMES:
        idx = name2idx.get(n)
        if idx is None:
            survivors.append({"school": n, "idx": None})
            continue
        snap = _indicators(doc, rowmap, opr_arr, opex_col, enroll, bs, idx, n, 2024)
        stock = sim_bs[str(idx)].get("stock") or {}
        survivors.append({
            "school": n, "idx": idx,
            "sim_status": sim_bs[str(idx)]["flags"].get("status"),
            "snapshot": snap,
            "stock_reserve_avail": stock.get("reserve_avail"),
            "stock_corp_capacity": stock.get("corp_capacity"),
        })

    # ── I2 위반 분규교 13건 ─────────────────────────────────
    closed_names = set(closed)
    survivor_set = set(SURVIVOR_NAMES)
    positive_set = set(POSITIVE_NAMES)
    disputes = []
    for v in i2:
        sn = v.get("school")
        disputes.append({
            "school": sn, "idx": name2idx.get(sn),
            "year": v.get("year"),
            "lhs": v.get("lhs"), "rhs": v.get("rhs"), "diff": v.get("diff"),
            "is_closed": sn in closed_names,
            "is_positive": sn in positive_set,
            "is_survivor": sn in survivor_set,
        })

    # ── reference_stats ─────────────────────────────────────
    def med_over(records, tk, key):
        return _median([(r.get(tk) or {}).get(key) for r in records if r.get(tk)])
    ref = {
        "positives_n": sum(1 for r in positives if r.get("T1") or r.get("T2")),
        "positive_median": {
            "T1": {k: med_over(positives, "T1", k) for k in IND_KEYS},
            "T2": {k: med_over(positives, "T2", k) for k in IND_KEYS},
        },
        "survivor_median": {
            k: _median([(s.get("snapshot") or {}).get(k) for s in survivors])
            for k in IND_KEYS
        },
    }

    notes = [
        "look-ahead 금지: positives 각 지표는 T-1/T-2 해당 연도 실측만. 폐교연도 이후 미사용.",
        "폐교교는 최종연도 자금계산서 미제출이 흔해 T-1 운영수지율·적립금이 결측일 수 있음"
        "(has_fund_row=false). 충원율은 enrollment_metrics로 별도 확보되어 커버리지가 높음.",
        f"reserve_avail haircut={HAIRCUT}(sim_params.RESERVE_HAIRCUT). positives는 모두 2024 이전 "
        "연도라 재량적립금 실측이 없어 전부 haircut 적용.",
        "disputes_I2는 이월연속성(I2) 위반 13건 — 회계 불연속(분규·구조조정) 신호로 폐교/생존 혼재. "
        "특이도 계산 시 '분규교 제외' 대조군 구성에 사용(설계 §5).",
        "survivors는 2024 스냅샷(생존 관측). 계약신학대학원대는 학부 미보유(no_ug)로 미분류 대상(설계 §7-6).",
    ]

    return {
        "meta": {
            "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "haircut": HAIRCUT,
            "observation_window": [2016, 2024],
            "reconcile": reconcile,
            "notes": notes,
            "sources": [
                "build/dashboard_data.json(운영수지율·rows·sim.stock·ext.closure_traj)",
                "build/interim/closed_schools.csv(폐교연도·법인상태 실측)",
                "build/interim/enrollment_metrics.csv(충원율)",
                "build/interim/balance_sheet.csv(적립금총액·재량적립금)",
                "build/interim/validation_report.json(I2 위반 13건)",
            ],
        },
        "positives": positives,
        "survivors": survivors,
        "disputes_I2": disputes,
        "closure_traj": doc["ext"]["closure_traj"],
        "reference_stats": ref,
    }


def run(interim=None, build_dir=None, out_path=None):
    data = build(interim, build_dir)
    interim = Path(interim) if interim else config.INTERIM_DIR
    out = Path(out_path) if out_path else (interim / "closure_calib.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    return data, out


if __name__ == "__main__":
    data, out = run()
    print(f"closure_calib.json 저장: {out}  ({out.stat().st_size/1024:.0f} KB)")
    print(f"positives {len(data['positives'])}  survivors {len(data['survivors'])}  "
          f"disputes_I2 {len(data['disputes_I2'])}  closure_traj n={data['closure_traj']['n']}")
    for r in data["positives"]:
        t1 = r.get("T1") or {}
        print(f"  {r['school']}({r['closed_year']}) no_ug={r['no_ug']} "
              f"T-1 충원율={t1.get('충원율')} 운영수지율={t1.get('운영수지율')} "
              f"적립금={t1.get('적립금총액')} r_avail={t1.get('reserve_avail')}")
