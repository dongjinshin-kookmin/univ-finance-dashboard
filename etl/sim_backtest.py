# -*- coding: utf-8 -*-
"""입학정원 감소 시뮬레이션 — 백테스트 하니스 (WBS D1).

설계 근거: docs/시뮬레이션_모델_설계.md 6장(백테스트: 분할·3층 검증·오차지표·합격기준·구조단절),
2장(잔존곡선·전개 마스터 방정식), 4.2(단가 동결 기본), 부록 수식.
재사용: etl/sim_params.py 의 survival()·M_OUT_BY_TYPE·RHO_G_DEFAULT (수식 정합 — 별도 재구현 금지).

절차(설계 6.1):
  1. 적합 2016~2020 → 학교별 m_in(Little)·s_k(파라메트릭)·p_ug(2020)·ρ_g 적합.
  2. 예측 2021~2024 → **실측 입학자 a_in**을 코호트 전개에 투입, H_ug_in·5112·5110·5100 예측.
  3. 3층 분리 검증(설계 6.2):
       L1 재학 전개  : 예측 H_ug_in vs 실측 H_ug_in            (목표 MAPE<3%)
       L2 수입(인원 given): 예측 5112 = p_ug·실측denom vs 실측 5112 (목표 MAPE<4%, 단가드리프트 격리)
       L3 종단 5110/5100  : 코호트 heads로 재구성한 5112'→5110'/5100' vs 실측 (목표 MAPE<5%)
  4. 오차지표(6.3): 수입가중 MAPE·MPE(<1.5%)·RMSPE·학교별 p90, naive(전년유지/선형추세 중 우수) 대비 skill.
  5. 합격(6.3): L1<3% & L2<4% & L3<5% & |MPE|<1.5% & skill>0.
  6. 구조단절(6.4): 5111 외생(실측 고정), COVID(2021~2022) 잔차 별도 표기·민감도(2023~24만).

Look-ahead 누출 금지: 적합은 2016~2020 데이터만 사용. 2026 공시단가·price_cap·2021+ 정보 미사용
(기본 시나리오 단가 동결 π=0 → p_ug(2020) 고정). tuition.csv·price_cap.csv 미참조.

대상 코호트: fit(2016~2020)+predict(2021~2024) 자금계산서 완비 & sim status∈{ok,fallback} & type∈{대학,전문대학}.
  실측상 완비 학교는 전부 '대학' 145교(국민대·c100 98교 포함) — 전문대는 9개년 자금 커버리지 0교(리포트 명시).

독립 실행: `cd etl && python3 sim_backtest.py` → build/interim/backtest.json 저장 + 요약 출력.
"""
import csv
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # 표준 standalone import
import config
import sim_params as SP

# ── 백테스트 상수 ────────────────────────────────────────────────────
FIT_YEARS = list(range(2016, 2021))       # 적합 구간 2016~2020
PRED_YEARS = list(range(2021, 2025))      # 예측·검증 구간 2021~2024
ALL_YEARS = list(range(2016, 2025))
COVID_YEARS = {2021, 2022}                # 예측 구간 내 COVID 교란(설계 6.4). 민감도: 제외 시 2023~24.
RHO_G = SP.RHO_G_DEFAULT                   # 1.4 (sim_params와 동일)
TARGET_TYPES = {"대학", "전문대학"}        # 유형별 분리 집계 대상

# 합격 기준(설계 6.3)
PASS = {"L1": 0.03, "L2": 0.04, "L3": 0.05, "MPE": 0.015, "SKILL": 0.0}


# ── 데이터 로딩 ──────────────────────────────────────────────────────
def _num(x):
    if x in ("", None):
        return None
    try:
        return float(x)
    except (ValueError, TypeError):
        return None


def _load_csv(interim, name):
    with open(interim / name, encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def _colval(col, i):
    """dashboard v 컬럼(dense list 또는 sparse {s,i,x}) 공통 조회."""
    if isinstance(col, dict):
        try:
            return col["x"][col["i"].index(i)]
        except ValueError:
            return None
    return col[i]


def load_panel(interim, dashboard_path):
    """학교별 연도 패널 조립. 반환: (schools, sim, panel).

    panel[idx][year] = {a_in, a_out, h_grad, h_ug, c5112, c5110, c5100, c5111, c5120}
    (h_ug = student_body.attending_total = 학부 재학 정원내+정원외; 자금 스칼라는 천원)
    """
    doc = json.load(open(dashboard_path, encoding="utf-8"))
    sim = json.load(open(interim / "sim_params.json", encoding="utf-8"))
    grad = {(r["canonical"], int(r["year"])): r for r in _load_csv(interim, "grad_out.csv")}
    sb = {(r["canonical"], int(r["year"])): r for r in _load_csv(interim, "student_body.csv")}

    schools, rows = doc["schools"], doc["rows"]
    # rows→(idx,year)→행인덱스 역참조로 자금 스칼라 조회
    row_of = {(r[0], r[1]): i for i, r in enumerate(rows)}
    vin = doc["v"]["in"]
    codes = ("5112", "5110", "5100", "5111", "5120")

    panel = {}
    for idx, s in enumerate(schools):
        canon = s["n"]
        per = {}
        for y in ALL_YEARS:
            g = grad.get((canon, y))
            b = sb.get((canon, y))
            ri = row_of.get((idx, y))
            rec = {"a_in": _num(g["a_in"]) if g else None,
                   "a_out": (_num(g["a_out"]) if g else None) or 0.0,
                   "h_grad": (_num(g["h_grad"]) if g else None) or 0.0,
                   "h_ug": _num(b["attending_total"]) if b else None}
            for c in codes:
                col = vin.get(c)
                rec["c" + c] = _colval(col, ri) if (col is not None and ri is not None) else None
            per[y] = rec
        panel[idx] = per
    return schools, sim, panel


# ── 코호트 선정 ──────────────────────────────────────────────────────
def _fund_complete(per):
    return all(per[y].get("c5112") not in (None, 0) for y in ALL_YEARS)


def _enroll_complete(per):
    return all(per[y].get("a_in") not in (None, 0) and per[y].get("h_ug") not in (None, 0)
               for y in ALL_YEARS)


def select_cohort(schools, sim, panel):
    """설계 6장 대상: fit+predict 자금·재학·입학 완비 & sim status∈{ok,fallback} & type∈{대학,전문대}."""
    out, reasons = [], {"type": 0, "status": 0, "fund": 0, "enroll": 0}
    for idx, s in enumerate(schools):
        if s.get("type") not in TARGET_TYPES:
            reasons["type"] += 1
            continue
        st = sim["bySchool"].get(str(idx), {}).get("flags", {}).get("status")
        if st not in ("ok", "fallback"):
            reasons["status"] += 1
            continue
        per = panel[idx]
        if not _fund_complete(per):
            reasons["fund"] += 1
            continue
        if not _enroll_complete(per):
            reasons["enroll"] += 1
            continue
        out.append(idx)
    return out, reasons


# ── 학교별 적합 → 예측 ───────────────────────────────────────────────
def fit_predict_school(s, per):
    """단일 학교: 2016~20 적합 → 21~24 예측. 반환 dict(연도별 예측·실측·naive) 또는 None(불가)."""
    typ = s.get("type")
    m_out = SP.M_OUT_BY_TYPE.get(typ, SP.M_OUT_DEFAULT)

    # 실측 H_ug_in(t) = attending − a_out·m_out (정원외 재학 스톡 분리; 설계 1.3)
    def h_in_actual(y):
        return per[y]["h_ug"] - per[y]["a_out"] * m_out

    # 코호트 전개용 a_in 시계열(pre-2016은 최초 관측치로 backfill; 꼬리가중 g^k≪1이라 민감도 무시)
    a_first = per[2016]["a_in"]

    def a_in_of(c):
        return per[c]["a_in"] if c in per and per[c]["a_in"] is not None else a_first

    def conv(t, s_k):
        return sum(sk * a_in_of(t - k) for k, sk in enumerate(s_k))

    # ── 적합(2016~2020만) ──
    # (1) 잔존곡선 형태: Little의 법칙 정상상태 비율(적합구간 합계). Σs_k=m_in 항등.
    sum_hin = sum(h_in_actual(y) for y in FIT_YEARS)
    sum_ain = sum(per[y]["a_in"] for y in FIT_YEARS)
    if sum_ain <= 0 or sum_hin <= 0:
        return None
    m_shape = sum_hin / sum_ain
    s0, _ = SP.survival(m_shape)
    if not s0:
        return None
    # (2) 레벨 편향보정(설계 6.3 진단 처방 i, look-ahead 없음): 적합 형태로 컨볼루션한 H_ug_in(2020)이
    #     실측 H_ug_in(2020)에 일치하도록 m_in 스케일 보정. 재학 하락기 적합구간-평균의 +2.6%p 과대편향 제거.
    hp20 = conv(2020, s0)
    hin20 = h_in_actual(2020)
    m_in = m_shape * (hin20 / hp20) if (hp20 > 0 and hin20 > 0) else m_shape
    s_k, g = SP.survival(m_in)             # 보정 스케일에서 잔존곡선 재도출(sim_params 재사용)
    if not s_k:
        return None
    # p_ug(2020): 방법 A(파생), 적합구간 마지막 연도. 단가 동결 기준(설계 4.2·6.1)
    d20 = per[2020]["h_ug"] + RHO_G * per[2020]["h_grad"]
    if d20 <= 0:
        return None
    p_ug = per[2020]["c5112"] / d20

    def h_in_pred(t):
        return conv(t, s_k)

    # ── naive 벤치마크(적합구간으로 구성; 설계 6.3) ──
    def linfit(ys):  # 2016~2020 선형추세 → (slope, intercept)
        n = len(FIT_YEARS)
        mx = sum(FIT_YEARS) / n
        my = sum(ys) / n
        den = sum((x - mx) ** 2 for x in FIT_YEARS)
        b = sum((x - mx) * (y - my) for x, y in zip(FIT_YEARS, ys)) / den if den else 0.0
        return b, my - b * mx

    def naives(series_of):  # series_of(year)->값 ; 반환 (b0(2020유지), b1(선형추세) 함수)
        y20 = series_of(2020)
        b, a = linfit([series_of(y) for y in FIT_YEARS])
        return (lambda t: y20), (lambda t: a + b * t)

    b0_hin, b1_hin = naives(h_in_actual)
    b0_5112, b1_5112 = naives(lambda y: per[y]["c5112"])
    b0_5110, b1_5110 = naives(lambda y: per[y]["c5110"])
    b0_5100, b1_5100 = naives(lambda y: per[y]["c5100"])

    # ── 예측(2021~2024) ──
    rows = []
    for t in PRED_YEARS:
        hin_a = h_in_actual(t)
        hin_p = h_in_pred(t)
        hout_a = per[t]["a_out"] * m_out          # 정원외 재학(실측 a_out 기반, 기준경로 고정)
        hgrad_a = per[t]["h_grad"]
        denom_a = per[t]["h_ug"] + RHO_G * hgrad_a  # 실측 denom(=H_ug+ρ_g·H_grad)
        denom_p = hin_p + hout_a + RHO_G * hgrad_a   # 코호트 heads로 재구성한 denom(L3)
        # L2: 인원 given(실측 denom) — 단가 드리프트만 격리
        rev5112_L2 = p_ug * denom_a
        # L3: 코호트 heads → 5112'→5110'→5100' (5111·5120 외생 실측 고정; 설계 6.4)
        rev5112_L3 = p_ug * denom_p
        rev5110_L3 = per[t]["c5111"] + rev5112_L3
        rev5100_L3 = rev5110_L3 + per[t]["c5120"]
        rows.append({
            "year": t, "covid": t in COVID_YEARS,
            # L1
            "hin_actual": hin_a, "hin_pred": hin_p,
            "hin_b0": b0_hin(t), "hin_b1": b1_hin(t),
            # L2 (5112, 인원 given)
            "r5112_actual": per[t]["c5112"], "r5112_L2pred": rev5112_L2,
            "r5112_b0": b0_5112(t), "r5112_b1": b1_5112(t),
            # L3 5110
            "r5110_actual": per[t]["c5110"], "r5110_pred": rev5110_L3,
            "r5110_b0": b0_5110(t), "r5110_b1": b1_5110(t),
            # L3 5100
            "r5100_actual": per[t]["c5100"], "r5100_pred": rev5100_L3,
            "r5100_b0": b0_5100(t), "r5100_b1": b1_5100(t),
            # L3 5112(코호트 heads) — 종단 5112 잔차 밴드용
            "r5112_L3pred": rev5112_L3,
        })
    return {"m_in": m_in, "g": g, "p_ug": p_ug, "m_out": m_out,
            "s_k_len": len(s_k), "rows": rows}


# ── 오차지표 ─────────────────────────────────────────────────────────
def _ape(a, p):
    return abs(p - a) / abs(a) if a not in (0, None) and a != 0 else None


def _pe(a, p):
    return (p - a) / a if a not in (0, None) and a != 0 else None


def _pctl(vals, q):
    if not vals:
        return None
    xs = sorted(vals)
    k = (len(xs) - 1) * q
    lo = int(math.floor(k))
    hi = int(math.ceil(k))
    if lo == hi:
        return xs[lo]
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def agg_metrics(points):
    """points: [{a, p, w}] → 수입가중 MAPE·MPE·RMSPE. w=가중치(수입 or heads, w>0만)."""
    points = [pt for pt in points if pt["w"] is not None and pt["w"] > 0
              and _ape(pt["a"], pt["p"]) is not None]
    W = sum(pt["w"] for pt in points if _ape(pt["a"], pt["p"]) is not None)
    if W <= 0:
        return None
    mape = sum(pt["w"] * _ape(pt["a"], pt["p"]) for pt in points if _ape(pt["a"], pt["p"]) is not None) / W
    mpe = sum(pt["w"] * _pe(pt["a"], pt["p"]) for pt in points if _pe(pt["a"], pt["p"]) is not None) / W
    sq = [_ape(pt["a"], pt["p"]) ** 2 for pt in points if _ape(pt["a"], pt["p"]) is not None]
    rmspe = math.sqrt(sum(sq) / len(sq)) if sq else None
    return {"mape": mape, "mpe": mpe, "rmspe": rmspe, "n": len(sq), "w": W}


def school_dist(per_school_ape):
    """학교별 MAPE 분포 → p50/p90/max."""
    vals = [v for v in per_school_ape if v is not None]
    return {"p50": _pctl(vals, 0.5), "p90": _pctl(vals, 0.9),
            "max": max(vals) if vals else None, "n": len(vals)}


# ── 층 집계 ──────────────────────────────────────────────────────────
# 각 층: (실측키, 예측키, b0키, b1키, 가중키) — 가중=실측 수입(L2/L3) 또는 실측 heads(L1)
LAYERS = {
    "L1": ("hin_actual", "hin_pred", "hin_b0", "hin_b1", "hin_actual"),
    "L2": ("r5112_actual", "r5112_L2pred", "r5112_b0", "r5112_b1", "r5112_actual"),
    "L3_5110": ("r5110_actual", "r5110_pred", "r5110_b0", "r5110_b1", "r5110_actual"),
    "L3_5100": ("r5100_actual", "r5100_pred", "r5100_b0", "r5100_b1", "r5100_actual"),
}


def eval_layer(fits, year_filter=None):
    """한 층군 전체를 집계. fits: [(idx, fitres)]. year_filter: 연도 집합(None=전체 예측구간).

    반환: {layer: {model, naive, skill, dist, ...}}
    """
    result = {}
    for lname, (ka, kp, kb0, kb1, kw) in LAYERS.items():
        pts_m, pts_b0, pts_b1 = [], [], []
        per_school_ape, per_school_skill = [], []
        for idx, fr in fits:
            sch_m, sch_b0, sch_b1 = [], [], []
            for r in fr["rows"]:
                if year_filter and r["year"] not in year_filter:
                    continue
                a, w = r[ka], r[kw]
                if a in (None, 0) or w in (None, 0) or w <= 0:
                    continue
                pm = {"a": a, "p": r[kp], "w": w}
                p0 = {"a": a, "p": r[kb0], "w": w}
                p1 = {"a": a, "p": r[kb1], "w": w}
                pts_m.append(pm); pts_b0.append(p0); pts_b1.append(p1)
                sch_m.append(pm); sch_b0.append(p0); sch_b1.append(p1)
            mm = agg_metrics(sch_m) if sch_m else None
            if mm:
                per_school_ape.append(mm["mape"])
                nb0 = agg_metrics(sch_b0); nb1 = agg_metrics(sch_b1)
                nbest = min((x["mape"] for x in (nb0, nb1) if x), default=None)
                if nbest and nbest > 0:
                    per_school_skill.append(1 - mm["mape"] / nbest)
        m = agg_metrics(pts_m)
        b0 = agg_metrics(pts_b0)
        b1 = agg_metrics(pts_b1)
        naive_best = min((x for x in (b0, b1) if x), key=lambda z: z["mape"]) if (b0 or b1) else None
        naive_which = ("B0_persist" if (naive_best and b0 and naive_best is b0) else "B1_trend")
        skill = (1 - m["mape"] / naive_best["mape"]) if (m and naive_best and naive_best["mape"] > 0) else None
        result[lname] = {
            "model": m, "naive_best": naive_best, "naive_which": naive_which,
            "b0": b0, "b1": b1, "skill": skill,
            "dist": school_dist(per_school_ape),
            "skill_dist": school_dist([-x for x in per_school_skill]) if False else
                          {"p50": _pctl(per_school_skill, 0.5), "p10": _pctl(per_school_skill, 0.1),
                           "n": len(per_school_skill)},
        }
    return result


def judge(layers):
    """합격 판정(설계 6.3). L3는 5110 기준(종단 대표)."""
    def mape(l):
        return layers[l]["model"]["mape"] if layers.get(l) and layers[l]["model"] else None
    def mpe(l):
        return abs(layers[l]["model"]["mpe"]) if layers.get(l) and layers[l]["model"] else None
    def skill(l):
        return layers[l]["skill"] if layers.get(l) else None
    l1, l2, l3 = mape("L1"), mape("L2"), mape("L3_5110")
    checks = {
        "L1<3%": (l1 is not None and l1 < PASS["L1"], l1),
        "L2<4%": (l2 is not None and l2 < PASS["L2"], l2),
        "L3<5%": (l3 is not None and l3 < PASS["L3"], l3),
        "|MPE_L3|<1.5%": (mpe("L3_5110") is not None and mpe("L3_5110") < PASS["MPE"], mpe("L3_5110")),
        "skill_L3>0": (skill("L3_5110") is not None and skill("L3_5110") > PASS["SKILL"], skill("L3_5110")),
    }
    checks["_overall"] = (all(v[0] for v in checks.values()), None)
    return checks


# ── 학교별 bt 필드(sim 스키마 동형) ──────────────────────────────────
def per_school_bt(fits):
    """학교별 bt: {mape_enroll(L1), mape_rev(L2·5112), mpe(L3_5110), skill(L3_5110)}."""
    out = {}
    for idx, fr in fits:
        def layer_pts(ka, kp, kw):
            return [{"a": r[ka], "p": r[kp], "w": r[kw]} for r in fr["rows"]
                    if r[ka] not in (None, 0)]
        me = agg_metrics(layer_pts("hin_actual", "hin_pred", "hin_actual"))
        mr = agg_metrics(layer_pts("r5112_actual", "r5112_L2pred", "r5112_actual"))
        m3 = agg_metrics(layer_pts("r5110_actual", "r5110_pred", "r5110_actual"))
        # 학교 skill(L3_5110 vs 우수 naive)
        nb0 = agg_metrics(layer_pts("r5110_actual", "r5110_b0", "r5110_actual"))
        nb1 = agg_metrics(layer_pts("r5110_actual", "r5110_b1", "r5110_actual"))
        nbest = min((x["mape"] for x in (nb0, nb1) if x), default=None)
        skill = (1 - m3["mape"] / nbest) if (m3 and nbest and nbest > 0) else None  # noqa
        out[str(idx)] = {
            "mape_enroll": round(me["mape"], 4) if me else None,
            "mape_rev": round(mr["mape"], 4) if mr else None,
            "mpe": round(m3["mpe"], 4) if m3 else None,
            "skill": round(skill, 4) if skill is not None else None,
        }
    return out


# ── 국민대 앵커(D3 일부) ─────────────────────────────────────────────
def kookmin_table(schools, fits):
    idx = next((i for i, s in enumerate(schools) if s.get("kmu")), None)
    if idx is None:
        idx = next((i for i, s in enumerate(schools) if s["n"] == "국민대학교"), None)
    fr = dict(fits).get(idx)
    if fr is None:
        return None
    yrs = []
    for r in fr["rows"]:
        yrs.append({
            "year": r["year"], "covid": r["covid"],
            "hin_actual": round(r["hin_actual"]), "hin_pred": round(r["hin_pred"]),
            "hin_ape": round(_ape(r["hin_actual"], r["hin_pred"]) * 100, 2),
            "r5112_actual": round(r["r5112_actual"]), "r5112_L2pred": round(r["r5112_L2pred"]),
            "r5112_ape": round(_ape(r["r5112_actual"], r["r5112_L2pred"]) * 100, 2),
            "r5110_actual": round(r["r5110_actual"]), "r5110_pred": round(r["r5110_pred"]),
            "r5110_ape": round(_ape(r["r5110_actual"], r["r5110_pred"]) * 100, 2),
            "r5110_pe": round(_pe(r["r5110_actual"], r["r5110_pred"]) * 100, 2),
            "r5100_actual": round(r["r5100_actual"]), "r5100_pred": round(r["r5100_pred"]),
            "r5100_ape": round(_ape(r["r5100_actual"], r["r5100_pred"]) * 100, 2),
        })
    return {"idx": idx, "m_in": round(fr["m_in"], 4), "g": round(fr["g"], 4),
            "p_ug": round(fr["p_ug"], 1), "years": yrs}


# ── 잔차 분위수(설계 7.2 밴드용) ─────────────────────────────────────
def residual_quantiles(fits, key_a, key_p):
    """L3 종단 잔차(PE) 분위수 — 시나리오 밴드 ±1.28σ(P10~P90) 근거."""
    pes = []
    for _, fr in fits:
        for r in fr["rows"]:
            pe = _pe(r[key_a], r[key_p])
            if pe is not None:
                pes.append(pe)
    if not pes:
        return None
    mean = sum(pes) / len(pes)
    sd = math.sqrt(sum((x - mean) ** 2 for x in pes) / len(pes)) if len(pes) > 1 else 0.0
    return {"p10": _pctl(pes, 0.1), "p25": _pctl(pes, 0.25), "p50": _pctl(pes, 0.5),
            "p75": _pctl(pes, 0.75), "p90": _pctl(pes, 0.9),
            "mean": mean, "sd": sd, "n": len(pes)}


# ── ρ_g 민감도(진단 iv, 설계 6.3) ────────────────────────────────────
def rho_sensitivity(schools, panel, cohort, rhos=(1.2, 1.4, 1.7)):
    """ρ_g를 바꿔 재적합·재예측 → L2/L3_5110 aggregate MAPE 변화(진단용)."""
    global RHO_G
    saved = RHO_G
    out = {}
    for rg in rhos:
        RHO_G = rg
        fits = []
        for idx in cohort:
            fr = fit_predict_school(schools[idx], panel[idx])
            if fr:
                fits.append((idx, fr))
        L = eval_layer(fits)
        out[str(rg)] = {"L2": round(L["L2"]["model"]["mape"] * 100, 3),
                        "L3_5110": round(L["L3_5110"]["model"]["mape"] * 100, 3),
                        "L3_5110_mpe": round(L["L3_5110"]["model"]["mpe"] * 100, 3)}
    RHO_G = saved
    return out


# ── 조립·저장 ────────────────────────────────────────────────────────
def _round_layers(layers):
    def rm(m):
        return None if not m else {k: (round(v, 6) if isinstance(v, float) else v)
                                   for k, v in m.items()}
    out = {}
    for ln, d in layers.items():
        out[ln] = {
            "model": rm(d["model"]), "naive_best": rm(d["naive_best"]),
            "naive_which": d["naive_which"], "skill": round(d["skill"], 4) if d["skill"] is not None else None,
            "dist": {k: (round(v, 6) if isinstance(v, float) else v) for k, v in d["dist"].items()},
            "skill_dist": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in d["skill_dist"].items()},
        }
    return out


def run(interim_dir=None, dashboard_path=None, out_path=None):
    interim = Path(interim_dir) if interim_dir else config.INTERIM_DIR
    dpath = Path(dashboard_path) if dashboard_path else (config.BUILD_DIR / "dashboard_data.json")
    schools, sim, panel = load_panel(interim, dpath)
    cohort, sel_reasons = select_cohort(schools, sim, panel)

    fits = []
    dropped = 0
    for idx in cohort:
        fr = fit_predict_school(schools[idx], panel[idx])
        if fr:
            fits.append((idx, fr))
        else:
            dropped += 1
    cohort = [idx for idx, _ in fits]

    by_type = {}
    for t in sorted(TARGET_TYPES):
        sub = [(i, fr) for i, fr in fits if schools[i].get("type") == t]
        by_type[t] = {"n": len(sub), "layers": _round_layers(eval_layer(sub))} if sub else {"n": 0}

    c100 = [(i, fr) for i, fr in fits if schools[i].get("c100")]

    overall = eval_layer(fits)
    excovid_years = set(PRED_YEARS) - COVID_YEARS   # 2023~2024
    excovid = eval_layer(fits, year_filter=excovid_years)
    covid_only = eval_layer(fits, year_filter=COVID_YEARS)

    verdict = judge(overall)
    verdict_excovid = judge(excovid)

    aggregate = {
        "overall": _round_layers(overall),
        "by_type": by_type,
        "c100": {"n": len(c100), "layers": _round_layers(eval_layer(c100))} if c100 else {"n": 0},
        "ex_covid_2023_24": _round_layers(excovid),
        "covid_only_2021_22": _round_layers(covid_only),
        "verdict": {k: {"pass": v[0], "value": (round(v[1], 6) if isinstance(v[1], float) else v[1])}
                    for k, v in verdict.items()},
        "verdict_ex_covid": {k: {"pass": v[0], "value": (round(v[1], 6) if isinstance(v[1], float) else v[1])}
                             for k, v in verdict_excovid.items()},
        "rho_sensitivity": rho_sensitivity(schools, panel, cohort),
        "residual_L3_5110": residual_quantiles(fits, "r5110_actual", "r5110_pred"),
        "residual_L3_5112": residual_quantiles(fits, "r5112_actual", "r5112_L3pred"),
    }

    bt = per_school_bt(fits)
    km = kookmin_table(schools, fits)

    result = {
        "meta": {
            "design": "docs/시뮬레이션_모델_설계.md 6장",
            "fit_years": FIT_YEARS, "pred_years": PRED_YEARS,
            "covid_years": sorted(COVID_YEARS), "rho_g": SP.RHO_G_DEFAULT,
            "m_out_by_type": SP.M_OUT_BY_TYPE,
            "cohort_n": len(cohort), "dropped_fit": dropped,
            "select_reasons_excluded": sel_reasons,
            "cohort_types": {t: sum(1 for i in cohort if schools[i].get("type") == t)
                             for t in TARGET_TYPES},
            "c100_in_cohort": sum(1 for i in cohort if schools[i].get("c100")),
            "pass_thresholds": PASS,
            "weight": "L1=실측 heads, L2/L3=실측 수입(5112/5110/5100). MAPE·MPE 모두 수입/heads 가중.",
            "notes": [
                "적합은 2016~2020만 사용(look-ahead 금지). 기본 시나리오 단가 동결 → p_ug(2020) 고정, "
                "tuition.csv·price_cap 미참조.",
                "L1=예측 H_ug_in(코호트 전개) vs 실측 H_ug_in(=attending−a_out·m_out).",
                "L2=p_ug(2020)·실측denom vs 실측 5112 (인원 given, 단가 드리프트만 격리).",
                "L3=코호트 heads로 재구성한 denom_p → 5112'→5110'(+5111 실측)→5100'(+5120 실측) vs 실측.",
                "5111 입학금은 외생 실측 고정(구조단절, 설계 6.4). COVID 2021~2022 잔차 별도·민감도(2023~24).",
                "m_in 적합=2단계: 형태=Little(적합구간 Σh_in/Σa_in) → 레벨 편향보정(2020 컨볼루션=실측 일치, "
                "설계 6.3 처방 i, look-ahead 없음). s_k=survival(m_in) sim_params 재사용.",
                "9개년 자금 완비 코호트는 전부 '대학'(전문대는 완비 0교) → 유형별 전문대 그룹 공집합(데이터 한계).",
            ],
        },
        "aggregate": aggregate,
        "bySchool": bt,
        "kookmin": km,
    }

    out = Path(out_path) if out_path else (interim / "backtest.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, separators=(",", ":"))
    return result, out


def _pct(x):
    return f"{x*100:.2f}%" if isinstance(x, (int, float)) else "—"


if __name__ == "__main__":
    result, out = run()
    m = result["meta"]
    ov = result["aggregate"]["overall"]
    v = result["aggregate"]["verdict"]
    print(f"backtest.json 저장: {out} ({out.stat().st_size/1024:.0f} KB)")
    print(f"코호트 {m['cohort_n']}교 (대학 {m['cohort_types'].get('대학',0)} / "
          f"전문대 {m['cohort_types'].get('전문대학',0)}), c100 {m['c100_in_cohort']}교, "
          f"적합실패 드롭 {m['dropped_fit']}")
    print("── 층별 (전체 2021~2024, 수입가중) ──")
    for ln in ("L1", "L2", "L3_5110", "L3_5100"):
        d = ov[ln]
        print(f"  {ln:9s} MAPE {_pct(d['model']['mape'])}  MPE {_pct(d['model']['mpe'])}  "
              f"skill {d['skill']:.3f}({d['naive_which']})  p90 {_pct(d['dist']['p90'])}")
    print("── 합격 판정(설계 6.3) ──")
    for k, val in v.items():
        if k.startswith("_"):
            continue
        print(f"  {'PASS' if val['pass'] else 'FAIL'}  {k}: {_pct(val['value']) if val['value'] is not None else ''}")
    print(f"  ==> 최종 {'합격' if v['_overall']['pass'] else '불합격'}")
    ex = result["aggregate"]["verdict_ex_covid"]
    print(f"  (COVID 제외 2023~24 재판정: {'합격' if ex['_overall']['pass'] else '불합격'})")
    if result["kookmin"]:
        km = result["kookmin"]
        print(f"── 국민대(idx {km['idx']}) m_in {km['m_in']} p_ug {km['p_ug']} ──")
        for y in km["years"]:
            print(f"  {y['year']}{'*' if y['covid'] else ' '} 5110 실측 {y['r5110_actual']:>12,} "
                  f"예측 {y['r5110_pred']:>12,} APE {y['r5110_ape']:.2f}%")
