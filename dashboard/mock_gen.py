# -*- coding: utf-8 -*-
"""mock_gen.py — 프런트엔드 개발용 목데이터 생성기.

스키마 계약(ethereal-brewing-karp.md)을 정확히 준수한다.
학교 6개(국민대 포함 수도권 2·광역 2·지방 2, 대·중·소 규모 혼합), 9개년(2016~2024),
관·항·목 30여 계정, KPI 10종, agg(전체/100개), validation 포함.
값은 현실적 스케일(등록금수입 수백억~천억대, 천원 단위).

사용:
  python3 dashboard/mock_gen.py [--out build/dashboard_mock_data.json] [--lite]
"""
import argparse
import json
import math
import os
import random
from datetime import datetime, timezone

YEARS = list(range(2016, 2025))
random.seed(20240714)

# ── 학교 정의 ──────────────────────────────────────────────────────────
# (name, kmu, c100, sido, region, type, scale, enroll2016, enroll2024, 등록금베이스억)
SCHOOLS = [
    ("국민대학교",   True,  True,  "서울", "수도권", "대학", "대규모", 22000, 21500, 1400),
    ("명지대학교",   False, True,  "경기", "수도권", "대학", "중규모", 15800, 14200, 900),
    ("동아대학교",   False, True,  "부산", "광역권", "대학", "대규모", 19500, 18100, 1300),
    ("계명대학교",   False, True,  "대구", "광역권", "대학", "대규모", 24000, 22600, 1500),
    ("원광대학교",   False, True,  "전북", "지방권", "대학", "대규모", 15200, 13800, 1200),
    ("한라대학교",   False, False, "강원", "지방권", "대학", "소규모",  4200,  3400, 300),
]

# ── 계정 트리 (code, name, lv, parent) ────────────────────────────────
ACCOUNTS_IN = [
    ("T_IN", "자금수입총계", 0, None),
    ("OP_IN", "운영수입", 0, None),
    ("5100", "등록금및수강료수입", 1, None),
    ("5110", "등록금수입", 2, "5100"),
    ("5111", "입학금", 3, "5110"),
    ("5112", "수업료", 3, "5110"),
    ("5120", "수강료수입", 2, "5100"),
    ("5121", "수강료", 3, "5120"),
    ("5200", "전입및기부수입", 1, None),
    ("5210", "전입금수입", 2, "5200"),
    ("5211", "법인전입금", 3, "5210"),
    ("5220", "기부금수입", 2, "5200"),
    ("5221", "일반기부금", 3, "5220"),
    ("5300", "교육부대수입", 1, None),
    ("5310", "교육부대수입료", 2, "5300"),
    ("5400", "교육외수입", 1, None),
    ("5410", "예금이자수입", 2, "5400"),
    ("AL_IN", "자산및부채수입", 1, None),
    ("1250", "적립금인출", 2, "AL_IN"),
    ("1260", "기금인출", 2, "AL_IN"),
    ("F_기본금", "기본금", 1, None),
    ("CF_PREV", "미사용전기이월자금", 1, None),
]
ACCOUNTS_EX = [
    ("T_EX", "자금지출총계", 0, None),
    ("OP_EX", "운영지출", 0, None),
    ("4100", "보수", 1, None),
    ("4110", "교원보수", 2, "4100"),
    ("4120", "직원보수", 2, "4100"),
    ("4200", "관리운영비", 1, None),
    ("4210", "일반관리비", 2, "4200"),
    ("4300", "연구학생경비", 1, None),
    ("4310", "연구비", 2, "4300"),
    ("4320", "학생경비", 2, "4300"),
    ("4321", "장학금", 3, "4320"),
    ("4322", "교내장학금", 3, "4320"),
    ("4322#2", "학비감면", 3, "4320"),
    ("4322#3", "국가장학금", 3, "4320"),
    ("4330", "입시관리비", 2, "4300"),
    ("4400", "교육외비용", 1, None),
    ("4500", "전출금", 1, None),
    ("4600", "예비비", 1, None),
    ("AL_EX", "자산및부채지출", 1, None),
    ("1250", "적립금적립", 2, "AL_EX"),
    ("1260", "기금적립", 2, "AL_EX"),
    ("1314", "도서구입비", 2, "AL_EX"),
    ("1317", "기계기구매입비", 2, "AL_EX"),
    ("CF_NEXT", "미사용차기이월자금", 1, None),
]


def jitter(base, pct=0.06):
    return base * (1.0 + random.uniform(-pct, pct))


def gen_school_year(sch, year):
    """한 학교-연도의 모든 계정 값(천원 단위)을 dict로 반환."""
    (_, kmu, _, _, _, _, scale, e16, e24, tuition_eok) = sch
    yidx = year - 2016
    growth = 1.0 + 0.018 * yidx  # 연 1.8% 완만 성장
    EOK = 100000  # 1억 = 100,000 천원

    v = {}
    # 등록금: 입학금 단계적 폐지(2018~2022 감소, 이후 소액)
    tuition_total = tuition_eok * EOK * growth
    if year <= 2017:
        ipsi_ratio = 0.06
    elif year <= 2022:
        ipsi_ratio = 0.06 * (2022 - year) / 5.0  # 선형 감소
    else:
        ipsi_ratio = 0.0
    v["5111"] = jitter(tuition_total * ipsi_ratio)
    v["5112"] = jitter(tuition_total * (1 - ipsi_ratio))
    v["5110"] = v["5111"] + v["5112"]
    v["5121"] = jitter(tuition_total * 0.015)
    v["5120"] = v["5121"]
    v["5100"] = v["5110"] + v["5120"]

    # 전입및기부
    v["5211"] = jitter(v["5100"] * (0.05 if kmu else random.uniform(0.02, 0.09)))
    v["5210"] = v["5211"]
    v["5221"] = jitter(v["5100"] * random.uniform(0.01, 0.04))
    v["5220"] = v["5221"]
    v["5200"] = v["5210"] + v["5220"]

    # 교육부대·교육외
    v["5310"] = jitter(v["5100"] * random.uniform(0.06, 0.12))
    v["5300"] = v["5310"]
    v["5410"] = jitter(v["5100"] * random.uniform(0.02, 0.05))
    v["5400"] = v["5410"]

    v["OP_IN"] = v["5100"] + v["5200"] + v["5300"] + v["5400"]

    # 자산및부채수입(적립금 인출) — 희소, 일부 연도만
    if random.random() < 0.45:
        v["1250"] = jitter(v["5100"] * random.uniform(0.01, 0.05))
    else:
        v["1250"] = 0.0
    if random.random() < 0.25:
        v["1260"] = jitter(v["5100"] * random.uniform(0.005, 0.02))
    else:
        v["1260"] = 0.0
    v["AL_IN"] = v["1250"] + v["1260"]

    v["F_기본금"] = 0.0  # 대부분 0 → 희소 처리 확인용

    # ── 지출 ────────────────────────────────────────────────
    v["4110"] = jitter(v["5100"] * (0.42 if kmu else random.uniform(0.40, 0.52)))
    v["4120"] = jitter(v["5100"] * random.uniform(0.14, 0.20))
    v["4100"] = v["4110"] + v["4120"]

    v["4210"] = jitter(v["5100"] * random.uniform(0.10, 0.16))
    v["4200"] = v["4210"]

    v["4310"] = jitter(v["5100"] * random.uniform(0.04, 0.08))
    # 장학금: 국가장학금 확대(연도 증가)
    schol_base = v["5100"] * (0.14 + 0.010 * yidx)
    v["4321"] = jitter(schol_base * 0.35)
    v["4322"] = jitter(schol_base * 0.25)
    v["4322#2"] = jitter(schol_base * 0.15)
    v["4322#3"] = jitter(schol_base * 0.25 * (1 + 0.04 * yidx))
    v["4320"] = v["4321"] + v["4322"] + v["4322#2"] + v["4322#3"]
    v["4330"] = jitter(v["5100"] * random.uniform(0.008, 0.02))
    v["4300"] = v["4310"] + v["4320"] + v["4330"]

    v["4400"] = jitter(v["5100"] * random.uniform(0.02, 0.05))
    v["4500"] = jitter(v["5100"] * random.uniform(0.005, 0.02))
    v["4600"] = jitter(v["5100"] * random.uniform(0.002, 0.01))
    v["OP_EX"] = v["4100"] + v["4200"] + v["4300"] + v["4400"] + v["4500"] + v["4600"]

    # 자산및부채지출(적립·자산취득)
    v["1250"] = jitter(v["5100"] * random.uniform(0.02, 0.07))  # 적립금적립(지출측)
    v["1260"] = jitter(v["5100"] * random.uniform(0.005, 0.02))
    v["1314"] = jitter(v["5100"] * random.uniform(0.005, 0.015))
    v["1317"] = jitter(v["5100"] * random.uniform(0.008, 0.02))
    v["AL_EX"] = v["1250"] + v["1260"] + v["1314"] + v["1317"]

    return v


def build():
    schools = []
    for i, sch in enumerate(SCHOOLS):
        (name, kmu, c100, sido, region, typ, scale, e16, e24, _) = sch
        enroll = {}
        for y in YEARS:
            frac = (y - 2016) / 8.0
            enroll[str(y)] = int(round(e16 + (e24 - e16) * frac))
        schools.append({
            "n": name, "c100": c100, "kmu": kmu, "sido": sido,
            "region": region, "type": typ, "scale": scale,
            "scaleProxy": False, "enroll": enroll,
        })

    rows = [[i, y] for i in range(len(SCHOOLS)) for y in YEARS]
    row_index = {(sid, y): k for k, (sid, y) in enumerate(rows)}

    in_codes = [a[0] for a in ACCOUNTS_IN]
    ex_codes = [a[0] for a in ACCOUNTS_EX]
    vin = {c: [None] * len(rows) for c in in_codes}
    vex = {c: [None] * len(rows) for c in ex_codes}

    # 이월 연결용: 학교별 이전 CF_NEXT 보관
    prev_cf = {}
    # 검증 실패 주입 대상: (schoolId, year) 몇 건
    inject_fail_i1 = {(2, 2019), (4, 2021)}
    inject_fail_i2 = {(3, 2020)}

    for sid, sch in enumerate(SCHOOLS):
        for y in YEARS:
            v = gen_school_year(sch, y)
            k = row_index[(sid, y)]
            # 이월 연결(I2): CF_PREV[y] = CF_NEXT[y-1]
            cf_prev = prev_cf.get(sid)
            if cf_prev is None:
                cf_prev = jitter(v["5100"] * random.uniform(0.10, 0.20))
            if (sid, y) in inject_fail_i2:
                cf_prev = cf_prev * 1.03  # I2 위반 주입
            v["CF_PREV"] = cf_prev
            v["T_IN"] = v["OP_IN"] + v["AL_IN"] + v["F_기본금"] + v["CF_PREV"]

            # 균형(I1): CF_NEXT = T_IN - (OP_EX + AL_EX)
            cf_next = v["T_IN"] - (v["OP_EX"] + v["AL_EX"])
            if cf_next < 0:
                cf_next = v["T_IN"] * 0.05
            v["CF_NEXT"] = cf_next
            v["T_EX"] = v["OP_EX"] + v["AL_EX"] + v["CF_NEXT"]
            if (sid, y) in inject_fail_i1:
                v["T_EX"] = v["T_EX"] * 1.015  # I1 위반 주입
            prev_cf[sid] = v["CF_NEXT"]

            for c in in_codes:
                val = v.get(c)
                vin[c][k] = None if val is None else int(round(val))
            for c in ex_codes:
                val = v.get(c)
                vex[c][k] = None if val is None else int(round(val))

    # 희소 인코딩: null 비율이 높거나 0이 많은 계정
    def maybe_sparse(arr):
        nonzero = [(i, x) for i, x in enumerate(arr) if x]
        # 절반 이상 비어있으면 희소 인코딩
        if len(nonzero) <= len(arr) * 0.5 and len(nonzero) < len(arr):
            return {"s": 1, "i": [i for i, _ in nonzero], "x": [x for _, x in nonzero]}
        return arr

    v_in_out = {c: maybe_sparse(vin[c]) for c in in_codes}
    v_ex_out = {c: maybe_sparse(vex[c]) for c in ex_codes}

    # ── KPI 계산 ─────────────────────────────────────────
    def gv(side, code, k):
        d = vin if side == "in" else vex
        x = d[code][k]
        return 0.0 if x is None else float(x)

    def ratio(num, den):
        if den == 0:
            return None
        return num / den

    kpi = {name: [None] * len(rows) for name in [
        "등록금의존율_총계", "등록금의존율_운영", "운영수지", "운영수지율",
        "법인전입금비율", "장학금지원율", "인건비부담률", "이월금비율",
        "적립금순증", "교육비환원율",
    ]}
    for k in range(len(rows)):
        t_in = gv("in", "T_IN", k)
        op_in = gv("in", "OP_IN", k)
        op_ex = gv("ex", "OP_EX", k)
        reg = gv("in", "5100", k)
        kpi["등록금의존율_총계"][k] = ratio(reg, t_in)
        kpi["등록금의존율_운영"][k] = ratio(reg, op_in)
        kpi["운영수지"][k] = int(round(op_in - op_ex))
        kpi["운영수지율"][k] = ratio(op_in - op_ex, op_in)
        kpi["법인전입금비율"][k] = ratio(gv("in", "5210", k), op_in)
        schol = (gv("ex", "4321", k) + gv("ex", "4322", k)
                 + gv("ex", "4322#2", k) + gv("ex", "4322#3", k))
        kpi["장학금지원율"][k] = ratio(schol, reg)
        kpi["인건비부담률"][k] = ratio(gv("ex", "4100", k), reg)
        kpi["이월금비율"][k] = ratio(gv("ex", "CF_NEXT", k), gv("ex", "T_EX", k))
        acc_add = (gv("ex", "1250", k) + gv("ex", "1260", k)
                   - gv("in", "1250", k) - gv("in", "1260", k))
        kpi["적립금순증"][k] = int(round(acc_add))
        edu = (gv("ex", "4100", k) + gv("ex", "4200", k) + gv("ex", "4300", k)
               - gv("ex", "4330", k) + gv("ex", "1317", k) + gv("ex", "1314", k))
        kpi["교육비환원율"][k] = ratio(edu, reg)

    # 비율 반올림(용량 절감)
    for name, arr in kpi.items():
        for k, x in enumerate(arr):
            if isinstance(x, float):
                arr[k] = round(x, 4)

    # ── agg (전체 / 100개) × 연도 × KPI 사분위 ──────────────
    def quantiles(vals):
        vals = sorted(v for v in vals if v is not None)
        if not vals:
            return None
        n = len(vals)

        def q(p):
            if n == 1:
                return vals[0]
            idx = p * (n - 1)
            lo = int(math.floor(idx))
            hi = min(lo + 1, n - 1)
            frac = idx - lo
            return vals[lo] * (1 - frac) + vals[hi] * frac
        mean = sum(vals) / n
        return [round(q(0.25), 4), round(q(0.5), 4), round(q(0.75), 4), round(mean, 4)]

    def build_agg(school_filter):
        out = {}
        for name, arr in kpi.items():
            per_year = {}
            for y in YEARS:
                vals = []
                for k, (sid, yy) in enumerate(rows):
                    if yy != y:
                        continue
                    if school_filter(sid):
                        vals.append(arr[k])
                per_year[str(y)] = quantiles(vals)
            out[name] = per_year
        return out

    agg = {
        "all": build_agg(lambda sid: True),
        "c100": build_agg(lambda sid: SCHOOLS[sid][2]),  # c100 flag
    }

    # ── validation ───────────────────────────────────────
    TOL = 1
    val_top = []
    summary = {}
    # I1: T_IN == T_EX
    i1_pass = i1_fail = 0
    for k, (sid, y) in enumerate(rows):
        lhs = gv("in", "T_IN", k)
        rhs = gv("ex", "T_EX", k)
        diff = lhs - rhs
        if abs(diff) <= max(TOL, abs(lhs) * 1e-6):
            i1_pass += 1
        else:
            i1_fail += 1
            val_top.append({"rule": "I1", "year": y, "school": SCHOOLS[sid][0],
                            "lhs": int(round(lhs)), "rhs": int(round(rhs)),
                            "diff": int(round(diff))})
    summary["I1"] = {"pass": i1_pass, "fail": i1_fail}

    # I2: CF_PREV[y] == CF_NEXT[y-1] (동일 학교)
    i2_pass = i2_fail = 0
    for sid in range(len(SCHOOLS)):
        for y in YEARS:
            if y == YEARS[0]:
                continue
            k = row_index[(sid, y)]
            kp = row_index[(sid, y - 1)]
            lhs = gv("in", "CF_PREV", k)
            rhs = gv("ex", "CF_NEXT", kp)
            diff = lhs - rhs
            if abs(diff) <= max(TOL, abs(rhs) * 1e-6):
                i2_pass += 1
            else:
                i2_fail += 1
                val_top.append({"rule": "I2", "year": y, "school": SCHOOLS[sid][0],
                                "lhs": int(round(lhs)), "rhs": int(round(rhs)),
                                "diff": int(round(diff))})
    summary["I2"] = {"pass": i2_pass, "fail": i2_fail}

    # I3: 재무상태표 항목 부재로 적용 불가(표기용 0/0)
    summary["I3"] = {"pass": 0, "fail": 0, "na": True}

    val_top.sort(key=lambda r: -abs(r["diff"]))
    validation = {"summary": summary, "top": val_top[:20]}

    data = {
        "meta": {
            "unit": "천원", "years": YEARS,
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "lite": False,
            "notes": [{"span": [2018, 2022], "label": "입학금 단계적 폐지"}],
        },
        "schools": schools,
        "accounts": {
            "in": [{"code": c, "name": n, "lv": l, "p": p} for (c, n, l, p) in ACCOUNTS_IN],
            "ex": [{"code": c, "name": n, "lv": l, "p": p} for (c, n, l, p) in ACCOUNTS_EX],
        },
        "rows": rows,
        "v": {"in": v_in_out, "ex": v_ex_out},
        "kpi": kpi,
        "agg": agg,
        "validation": validation,
    }
    return data


def make_lite(data):
    """lite: v에서 lv3(목) 계정 제거, meta.lite=true."""
    lite = json.loads(json.dumps(data))
    lite["meta"]["lite"] = True
    for side in ("in", "ex"):
        lv3 = {a["code"] for a in lite["accounts"][side] if a["lv"] == 3}
        for c in list(lite["v"][side].keys()):
            if c in lv3:
                del lite["v"][side][c]
        lite["accounts"][side] = [a for a in lite["accounts"][side] if a["lv"] != 3]
    return lite


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    default_out = os.path.join(here, "..", "build", "dashboard_mock_data.json")
    ap.add_argument("--out", default=default_out)
    ap.add_argument("--lite", action="store_true")
    args = ap.parse_args()

    data = build()
    if args.lite:
        data = make_lite(data)

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(out)
    print("wrote", out, "({:.1f} KB)".format(size / 1024))
    print("  schools=%d rows=%d in_codes=%d ex_codes=%d" % (
        len(data["schools"]), len(data["rows"]),
        len(data["v"]["in"]), len(data["v"]["ex"])))
    print("  validation:", data["validation"]["summary"])


if __name__ == "__main__":
    main()
