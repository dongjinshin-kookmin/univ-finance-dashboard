# -*- coding: utf-8 -*-
"""입학정원 감소 시뮬레이션 — 학교별 사전계산 파라미터 모듈 (WBS A3).

설계 근거: docs/시뮬레이션_모델_설계.md (0장 인덱싱 계약, 1장 세그먼트 분해·p_ug 3방법,
2장 잔존곡선 s_k, 4장 단가·price_cap, 10.2절 sim 블록 스키마, 부록 수식).
선행 산출: build/d5_report.md (A1 — grad_out.csv: H_grad·A_out·q_ug 학위분해).

역할: 전 학교의 시뮬레이션 파라미터(세그먼트·단가 p_ug·φ·잔존 m_in/g/s_k·base 스칼라)를
사전계산해 `sim` 블록(10.2절 스키마 동형, bt=null)으로 조립한다. build_json 통합(A6)은 별도.

단위 계약(중요):
  - dashboard_data.json 금액 = 천원. base 스칼라·p_ug 모두 **천원**으로 저장(기존 계약 일치).
  - tuition.csv avg_tuition = 원 → /1000 해서 천원으로 환산(공시 교차검증에만 사용).

키 명명: 설계 스키마의 유니코드 키(ρ_g, φ)는 JS 프로퍼티 접근 편의를 위해 ASCII로 저장한다.
  ρ_g → rho_g,  φ.{in,out,grad} → phi.{in,out,grad}. (보고서 d8 §명명 대조표 참조)

독립 실행: `python3 etl/sim_params.py` → build/interim/sim_params.json 저장 + 요약 출력.
"""
import csv
import json
import statistics as _st
from pathlib import Path

import config

# ── 상수 ────────────────────────────────────────────────────────────
RHO_G_DEFAULT = 1.4          # 대학원/학부 등록금 배율(설계 1.4·부록). φ 분해 핵심 민감모수.
UNIT_PRICE = "천원"           # p_ug·base 스칼라 저장 단위

# 정원외 재학 배율 m_out (설계 2.3: 편입·외국인 재원기간 ≈ 정규과정). 유형별.
M_OUT_BY_TYPE = {"대학": 4.0, "사이버대학": 4.0, "전문대학": 2.5, "대학원대학": 4.0}
M_OUT_DEFAULT = 4.0

# 무결성 상식 범위 — 유형별(전문대 2~3년제·사이버 저단가 반영). 설계 검증 §2 기준을
# 4년제 대학에 맞춘 값(m_in 3.5~7, p_ug 200만~1,200만)으로 두고 타 유형은 학제/단가에 맞춰 조정.
#   m_in: (lo, hi) 배율,  p_ug: (lo, hi) 천원
RANGE_BY_TYPE = {
    "대학":       {"m_in": (3.5, 7.0), "p_ug": (3000, 12000)},
    "전문대학":   {"m_in": (1.5, 4.5), "p_ug": (3000, 11000)},
    "사이버대학": {"m_in": (1.5, 6.0), "p_ug": (1000, 5000)},
}
RANGE_DEFAULT = {"m_in": (1.5, 7.0), "p_ug": (1000, 12000)}

# 시나리오 기본값(설계 8장·10.2 defaults)
DEFAULTS = {"beta": 0.5, "gamma": 0.15, "eta_5120": 0.3, "dropout": 0.0, "lambda_": 0.0}

# 그룹 폴백 최소 표본(설계 10.2 group_fallback)
GROUP_MIN = 3

# base 스칼라 계정(설계 10.2 base 목록)
BASE_IN = {"c5111": "5111", "c5112": "5112", "c5120": "5120", "c5100": "5100",
           "c5210": "5210", "cOP_IN": "OP_IN", "cT_IN": "T_IN"}
BASE_EX = {"c4100": "4100", "cOP_EX": "OP_EX", "c4321": "4321", "c4322": "4322"}
EDU_COST_EX = {"c4200": "4200", "c4300": "4300", "c4330": "4330",
               "c1317": "1317", "c1314": "1314"}


# ── 소형 유틸 ────────────────────────────────────────────────────────
def _num(x):
    if x in ("", None):
        return None
    try:
        return float(x)
    except (ValueError, TypeError):
        return None


def _colval(col, i):
    """dashboard v 컬럼(dense list 또는 sparse {s,i,x}) 공통 조회."""
    if isinstance(col, dict):
        try:
            return col["x"][col["i"].index(i)]
        except ValueError:
            return None
    return col[i]


def _median(vals):
    vals = [v for v in vals if v is not None]
    return _st.median(vals) if vals else None


# ── 잔존곡선 s_k (설계 2.2a 파라메트릭) ───────────────────────────────
def survival(m_in):
    """m_in(정원내 배율=Σs_k, Little의 법칙) → (s_k 리스트, g).

    설계 2.2(a): s_k=1(k=0..3), g^(k-3)(k≥4), g=(m_in−4)/(m_in−3), Σs_k=m_in.
    m_in<4(전문대 2~3년제)는 사각형 축소: floor(m_in)년 만재 + 잔여 분수년(g=0).
    (b)휴학 스프레드·(c)디컨볼루션은 A4로 이연 — 휴학 순효과는 m_in에 이미 흡수(설계 2.1).
    """
    if m_in is None or m_in <= 0:
        return [], 0.0
    if m_in >= 4:
        g = (m_in - 4.0) / (m_in - 3.0)
        s = [1.0, 1.0, 1.0, 1.0]
        sk, k = g, 4
        while sk > 1e-4 and k < 40:
            s.append(round(sk, 6))
            sk *= g
            k += 1
        return s, round(g, 6)
    # m_in < 4
    k_full = int(m_in)
    s = [1.0] * k_full
    frac = m_in - k_full
    if frac > 1e-9:
        s.append(round(frac, 6))
    return s, 0.0


def _monotone(s):
    return all(s[i] >= s[i + 1] - 1e-9 for i in range(len(s) - 1))


# ── 데이터 로딩 ──────────────────────────────────────────────────────
def _load_csv(interim, name):
    with open(interim / name, encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def _load_inputs(interim, dashboard_path):
    doc = json.load(open(dashboard_path, encoding="utf-8"))
    grad = {(r["canonical"], int(r["year"])): r
            for r in _load_csv(interim, "grad_out.csv")}
    sb = {(r["canonical"], int(r["year"])): r
          for r in _load_csv(interim, "student_body.csv")}
    tui = {r["canonical"]: r for r in _load_csv(interim, "tuition.csv")}

    price_cap = {}
    for r in _load_csv(interim, "price_cap.csv"):
        cap = _num(r.get("cap_rate"))
        if r.get("year") and cap is not None:
            price_cap[r["year"]] = round(cap, 6)

    pop_corr, pop18 = {}, {}
    try:  # A7 산출물(있으면 meta에 동봉; 최종 통합·재계산은 A7 담당)
        for r in _load_csv(interim, "pop_correction.csv"):
            c = _num(r.get("c_sido"))
            if r.get("sido") and c is not None:
                pop_corr[r["sido"]] = round(c, 4)
        for r in _load_csv(interim, "pop_drift.csv"):
            d = _num(r.get("d_sido"))
            if r.get("sido") and r.get("year") and d is not None:
                pop18.setdefault(r["sido"], {})[r["year"]] = round(d, 6)
    except FileNotFoundError:
        pass
    return doc, grad, sb, tui, price_cap, pop_corr, pop18


def _latest_rows(rows):
    """schoolIdx → (row_i, year) 최신 연도."""
    latest = {}
    for i, (sidx, yr) in enumerate(rows):
        if sidx not in latest or yr > latest[sidx][1]:
            latest[sidx] = (i, yr)
    return latest


def _base_scalars(doc, row_i):
    """설계 10.2 base 스칼라(천원). dense/sparse 공통. 결측=None."""
    base = {}
    for key, code in BASE_IN.items():
        col = doc["v"]["in"].get(code)
        base[key] = _colval(col, row_i) if col is not None else None
    for key, code in BASE_EX.items():
        col = doc["v"]["ex"].get(code)
        base[key] = _colval(col, row_i) if col is not None else None
    edu = {}
    for key, code in EDU_COST_EX.items():
        col = doc["v"]["ex"].get(code)
        edu[key] = _colval(col, row_i) if col is not None else None
    base["edu_cost"] = edu
    return base


# ── 학교별 원시 파라미터 계산 ─────────────────────────────────────────
def _seg_row(grad, sb, canon, base_year):
    """base_year 우선, 없으면 각 소스 최신 연도의 seg/재학 행 + 사용 연도."""
    g = grad.get((canon, base_year))
    gyear = base_year
    if g is None:
        yrs = [y for (c, y) in grad if c == canon]
        if yrs:
            gyear = max(yrs)
            g = grad[(canon, gyear)]
    sbrow = sb.get((canon, base_year))
    if sbrow is None:
        yrs = [y for (c, y) in sb if c == canon]
        if yrs:
            sbrow = sb[(canon, max(yrs))]
    return g, sbrow, gyear


def _deflate_factor(price_cap, base_year, snap_year):
    """공시 스냅샷연도 → base_year 환산 계수 Π(1+cap_rate). 법정상한을 실인상 상한으로 사용."""
    f = 1.0
    for y in range(base_year + 1, snap_year + 1):
        f *= (1 + price_cap.get(str(y), 0.0))
    return f


def _compute_raw(school, base, seg_row, sbrow, tui_row, rho_g, price_cap, base_year):
    """단일 학교 원시 파라미터(폴백 전). 반환 dict + status.

    status: ok | no_ug(학부 없음·비반응) | nodata(seg/5112/재학 결측) | invalid(범위/비음수 위반)
    """
    typ = school.get("type")
    c5112 = base.get("c5112")

    # 재학 스톡 H_ug: student_body.attending_total 우선(A1), 없으면 dashboard enroll
    H_ug = _num(sbrow["attending_total"]) if sbrow else None
    if H_ug is None:
        en = school.get("enroll") or {}
        # base_year enroll은 상위에서 넘기지 않으므로 최신값 근사
        vals = [(_num(v)) for v in en.values() if _num(v) is not None]
        H_ug = vals[-1] if vals else None

    if seg_row is None or c5112 in (None, 0) or H_ug in (None, 0):
        return {"status": "nodata"}

    Q = _num(seg_row["q_ug"])
    A_in = _num(seg_row["a_in"])
    A_out = _num(seg_row["a_out"]) or 0.0
    H_grad = _num(seg_row["h_grad"]) or 0.0

    # 학부 미보유(대학원대학 등, q_ug=0 또는 학부 입학자 없음) → 비반응 세그먼트
    if Q in (None, 0) or A_in in (None, 0):
        return {
            "status": "no_ug",
            "seg": {"H_ug": _r(H_ug), "H_grad": _r(H_grad), "A_in": _r(A_in),
                    "A_out": _r(A_out), "Q": _r(Q), "H_ug_in": 0.0, "H_ug_out": _r(H_ug)},
            "phi": {"in": 0.0, "out": 0.0, "grad": 1.0},  # 5112 전액 비반응(대학원/정원외)
            "price": {"p_ug": None, "p_ug_src": "없음(학부미보유)", "rho_g": rho_g},
            "surv": {"m_in": None, "g": None, "s_k": []},
        }

    m_out = M_OUT_BY_TYPE.get(typ, M_OUT_DEFAULT)
    H_ug_out = A_out * m_out
    H_ug_in = H_ug - H_ug_out
    denom = H_ug + rho_g * H_grad                      # 대학원 환산 분모(설계 1.4 방법 A)
    p_ug = c5112 / denom                               # 천원/인·년

    # φ 분해(방법 A p_ug 사용 시 Σφ=1 항등, 설계 1.4)
    phi_in = H_ug_in / denom
    phi_out = H_ug_out / denom
    phi_grad = (rho_g * H_grad) / denom
    m_in = H_ug_in / A_in if H_ug_in > 0 else None
    s_k, g = survival(m_in)

    # 공시단가 교차검증(설계 1.4 방법 B 게이트) — 저장 단가는 방법 A(연도·단위 정합), 공시는 검증만.
    # 공시=tuition.csv 스냅샷연도(주로 2026)라 base_year(주로 2024)로 price_cap 디플레이트 후 비교.
    p_disc = p_disc_adj = rho_disc = cross_ratio = None
    if tui_row:
        pd = _num(tui_row.get("avg_tuition"))
        snap_y = _num(tui_row.get("year"))
        if pd:
            p_disc = pd / 1000.0                       # 원 → 천원(스냅샷연도)
            fac = _deflate_factor(price_cap, base_year, int(snap_y)) if snap_y else 1.0
            p_disc_adj = p_disc / fac                  # base_year 환산 공시 학부단가
            back = (c5112 - p_disc_adj * H_ug)         # 공시 역산 대학원 총수업료
            if H_grad > 0 and p_disc_adj > 0:
                rho_disc = round(back / (H_grad * p_disc_adj), 4)  # 게이트: ∈[1.2,1.8]
            if p_disc_adj:
                cross_ratio = round((c5112 / denom) / p_disc_adj, 4)  # 파생/공시(±10% 기대)

    raw = {
        "status": "ok",
        "seg": {"H_ug": _r(H_ug), "H_grad": _r(H_grad), "A_in": _r(A_in),
                "A_out": _r(A_out), "Q": _r(Q),
                "H_ug_in": _r(H_ug_in), "H_ug_out": _r(H_ug_out)},
        "price": {"p_ug": _r(p_ug), "p_ug_src": "파생", "rho_g": rho_g},
        "surv": {"m_in": _r(m_in), "g": g, "s_k": s_k},
        "phi": {"in": _r(phi_in), "out": _r(phi_out), "grad": _r(phi_grad)},
        "xcheck": {"p_disc": _r(p_disc), "p_disc_adj": _r(p_disc_adj),
                   "rho_disc": rho_disc, "cross_ratio": cross_ratio},
    }
    ok, reasons = _check_integrity(raw, typ)
    if not ok:
        raw["status"] = "invalid"
        raw["_reasons"] = reasons
    return raw


def _r(x, nd=4):
    return round(x, nd) if isinstance(x, (int, float)) else x


# ── 무결성 검증(설계 검증 §2·task) ───────────────────────────────────
def _check_integrity(raw, typ):
    """단일 학교 파라미터 상식성 검사 → (ok, [위반사유])."""
    rng = RANGE_BY_TYPE.get(typ, RANGE_DEFAULT)
    reasons = []
    seg, price, surv, phi = raw["seg"], raw["price"], raw["surv"], raw["phi"]

    # 비음수
    for k in ("H_ug", "H_grad", "A_in", "A_out", "H_ug_in", "H_ug_out"):
        v = seg.get(k)
        if v is not None and v < 0:
            reasons.append(f"neg_{k}")
    if price.get("p_ug") is not None and price["p_ug"] < 0:
        reasons.append("neg_p_ug")
    for k in ("in", "out", "grad"):
        if phi[k] is not None and phi[k] < -1e-6:
            reasons.append(f"neg_phi_{k}")

    # φ 합 ≤ 1 (방법 A는 =1; 부동소수 허용)
    phis = [phi[k] for k in ("in", "out", "grad") if phi[k] is not None]
    if phis and sum(phis) > 1 + 1e-3:
        reasons.append("phi_sum>1")

    # s_k 감쇠 단조
    if surv["s_k"] and not _monotone(surv["s_k"]):
        reasons.append("s_k_nonmonotone")
    # Σs_k ≈ m_in
    if surv["s_k"] and surv["m_in"] is not None:
        if abs(sum(surv["s_k"]) - surv["m_in"]) > 0.05:
            reasons.append("s_k_sum!=m_in")

    # m_in 상식 범위
    m = surv.get("m_in")
    if m is not None and not (rng["m_in"][0] <= m <= rng["m_in"][1]):
        reasons.append(f"m_in_oob({m:.2f})")
    # p_ug 상식 범위
    p = price.get("p_ug")
    if p is not None and not (rng["p_ug"][0] <= p <= rng["p_ug"][1]):
        reasons.append(f"p_ug_oob({p:.0f})")

    return (len(reasons) == 0, reasons)


# ── 그룹 폴백(설계 10.2 group_fallback) ──────────────────────────────
def _group_key(school):
    return f"{school.get('type')}|{school.get('scale')}"


def _build_group_fallback(records, schools):
    """유효(ok) 학교로 (유형|규모) 그룹 중앙값 산출. 표본<GROUP_MIN → 유형→전역 폭넓힘."""
    by_key, by_type, glob = {}, {}, []
    for idx, raw in records:
        if raw["status"] != "ok":
            continue
        s = schools[idx]
        entry = (raw["price"]["p_ug"], raw["surv"]["m_in"],
                 raw["phi"]["in"], raw["phi"]["out"], raw["phi"]["grad"])
        by_key.setdefault(_group_key(s), []).append(entry)
        by_type.setdefault(s.get("type"), []).append(entry)
        glob.append(entry)

    def _agg(entries):
        if not entries:
            return None
        p_ug = _median([e[0] for e in entries])
        m_in = _median([e[1] for e in entries])
        s_k, g = survival(m_in)
        pin = _median([e[2] for e in entries]) or 0.0
        pout = _median([e[3] for e in entries]) or 0.0
        pgr = _median([e[4] for e in entries]) or 0.0
        tot = pin + pout + pgr
        if tot > 0:  # 재정규화(Σφ=1)
            pin, pout, pgr = pin / tot, pout / tot, pgr / tot
        return {"p_ug": _r(p_ug), "m_in": _r(m_in), "g": g, "s_k": s_k,
                "phi": {"in": _r(pin), "out": _r(pout), "grad": _r(pgr)},
                "n": len(entries)}

    out = {}
    for key, entries in by_key.items():
        if len(entries) >= GROUP_MIN:
            out[key] = _agg(entries)
    out["_by_type"] = {t: _agg(e) for t, e in by_type.items()}
    out["_global"] = _agg(glob)
    return out


def _resolve_fallback(school, group_fb):
    """폴백 파라미터 선택: 그룹 → 유형 → 전역."""
    key = _group_key(school)
    if key in group_fb:
        return group_fb[key], "그룹"
    bt = group_fb["_by_type"].get(school.get("type"))
    if bt:
        return bt, "유형"
    return group_fb["_global"], "전역"


# ── 조립 ────────────────────────────────────────────────────────────
def compute_sim_params(doc=None, interim_dir=None, dashboard_path=None):
    """sim 블록(10.2 스키마 동형) 반환: {"meta":..., "bySchool":{idx: {...}}}.

    doc 미지정 시 dashboard_data.json 로드. interim csv는 interim_dir(기본 config)에서 읽음.
    """
    interim = Path(interim_dir) if interim_dir else config.INTERIM_DIR
    dpath = Path(dashboard_path) if dashboard_path else (config.BUILD_DIR / "dashboard_data.json")
    loaded, grad, sb, tui, price_cap, pop_corr, pop18 = _load_inputs(interim, dpath)
    if doc is None:
        doc = loaded

    schools, rows = doc["schools"], doc["rows"]
    latest = _latest_rows(rows)

    # pass1: 원시 파라미터
    records = []                       # (idx, raw)
    base_by_idx, year_by_idx = {}, {}
    for idx, s in enumerate(schools):
        canon = s["n"]
        if idx not in latest:
            records.append((idx, {"status": "nodata"}))
            base_by_idx[idx] = _empty_base()
            year_by_idx[idx] = None
            continue
        row_i, base_year = latest[idx]
        base = _base_scalars(doc, row_i)
        base_by_idx[idx] = base
        year_by_idx[idx] = base_year
        seg_row, sbrow, _gy = _seg_row(grad, sb, canon, base_year)
        raw = _compute_raw(s, base, seg_row, sbrow, tui.get(canon),
                           RHO_G_DEFAULT, price_cap, base_year)
        records.append((idx, raw))

    # pass2: 그룹 폴백 테이블
    group_fb = _build_group_fallback(records, schools)

    # pass3: bySchool 조립 + 폴백 적용
    by_school = {}
    counts = {"ok": 0, "no_ug": 0, "fallback": 0, "nodata": 0}
    fb_reasons = {}
    for idx, raw in records:
        s = schools[idx]
        status = raw["status"]
        entry = {"base": base_by_idx[idx], "bt": None,
                 "flags": {"year": year_by_idx[idx]}}

        if status == "ok":
            counts["ok"] += 1
            entry.update({"seg": raw["seg"], "price": _price_pub(raw["price"]),
                          "surv": raw["surv"], "phi": raw["phi"]})
            entry["flags"]["status"] = "ok"
            entry["flags"]["xcheck"] = raw.get("xcheck")

        elif status == "no_ug":
            counts["no_ug"] += 1
            entry.update({"seg": raw["seg"], "price": _price_pub(raw["price"]),
                          "surv": raw["surv"], "phi": raw["phi"]})
            entry["flags"]["status"] = "no_ug"

        else:  # nodata / invalid → 그룹 폴백
            counts["fallback"] += 1
            fb, scope = _resolve_fallback(s, group_fb)
            for r in raw.get("_reasons", [status]):
                fb_reasons[r] = fb_reasons.get(r, 0) + 1
            # seg: 가용 원시 seg 유지, H_ug_in/out은 폴백 m_in으로 재구성
            seg = raw.get("seg") or _empty_seg()
            entry.update(_apply_fallback(seg, fb, scope, RHO_G_DEFAULT))
            entry["flags"]["status"] = "fallback"
            entry["flags"]["fallback_scope"] = scope
            entry["flags"]["fallback_reason"] = raw.get("_reasons", [status])

        by_school[str(idx)] = entry

    meta = {
        "rho_g_default": RHO_G_DEFAULT,
        "unit_price": UNIT_PRICE,
        "price_cap": price_cap,
        "pop_corr": pop_corr,
        "pop18_decline": pop18,
        "group_fallback": {k: v for k, v in group_fb.items() if not k.startswith("_")},
        "defaults": {**DEFAULTS, "m_out": M_OUT_BY_TYPE},
        "counts": counts,
        "notes": _META_NOTES,
    }
    sim = {"meta": meta, "bySchool": by_school}
    return sim


def _price_pub(price):
    """공개용 price(내부 진단 키 p_disc/rho_disc 제외, 교차검증값은 flags로 별도 보존 안함)."""
    return {"p_ug": price.get("p_ug"), "p_ug_src": price.get("p_ug_src"),
            "rho_g": price.get("rho_g")}


def _empty_seg():
    return {"H_ug": None, "H_grad": None, "A_in": None, "A_out": None,
            "Q": None, "H_ug_in": None, "H_ug_out": None}


def _empty_base():
    b = {k: None for k in list(BASE_IN) + list(BASE_EX)}
    b["edu_cost"] = {k: None for k in EDU_COST_EX}
    return b


def _apply_fallback(seg, fb, scope, rho_g):
    """폴백 파라미터로 entry 구성. seg의 H_ug_in/out을 폴백 m_in으로 재구성."""
    H_ug = seg.get("H_ug")
    A_in = seg.get("A_in")
    m_in = fb["m_in"] if fb else None
    H_ug_in = _r(A_in * m_in) if (A_in and m_in) else None
    if H_ug_in is not None and H_ug is not None:
        H_ug_out = _r(max(0.0, H_ug - H_ug_in))
    else:
        H_ug_out = seg.get("H_ug_out")
    seg2 = dict(seg)
    seg2["H_ug_in"], seg2["H_ug_out"] = H_ug_in, H_ug_out
    return {
        "seg": seg2,
        "price": {"p_ug": fb["p_ug"] if fb else None, "p_ug_src": f"그룹({scope})",
                  "rho_g": rho_g},
        "surv": {"m_in": fb["m_in"] if fb else None, "g": fb["g"] if fb else None,
                 "s_k": fb["s_k"] if fb else []},
        "phi": dict(fb["phi"]) if fb else {"in": None, "out": None, "grad": None},
    }


_META_NOTES = [
    "금액·단가 단위=천원(dashboard 계약 일치). tuition.csv는 원 단위 → p_ug 교차검증 시 /1000.",
    "p_ug 저장값=방법 A(파생: 5112/(H_ug+rho_g·H_grad)). 공시단가는 교차검증 게이트로만 사용"
    "(공시=2026 스냅샷·원, base=최신 자금계산서 연도·천원이라 연도·단위 정합 위해 파생 채택).",
    "φ_in은 rho_g=1.4 가정의 분해값이며 '정원 감축 반응 가능 수입' 비중(설계 9장). "
    "방법 A p_ug 사용 시 φ_in+φ_out+φ_grad=1 항등.",
    "s_k는 파라메트릭(설계 2.2a): Σs_k=m_in. 휴학 스프레드(2.2b)·디컨볼루션(2.2c)은 A4 이연 — "
    "휴학 순효과는 m_in에 이미 흡수(2.1).",
    "대학원대학 등 q_ug=0 학교는 학부 비반응(status=no_ug): φ_in=0, 정원 감축 델타=0.",
    "무결성 위반(m_in·p_ug 범위·비음수·φ합) 학교는 (유형|규모) 그룹 중앙값으로 폴백(status=fallback).",
    "무결성 상식 범위는 유형별(전문대 2~3년제·사이버 저단가 반영). 4년제 대학 기준 m_in 3.5~7, "
    "p_ug 200만~1,200만.",
    "pop_corr·pop18_decline은 A7(D4 인구 실적) 산출물 동봉 — 최종 통합·재계산은 A7 담당.",
    "bt(백테스트 지표)는 D1에서 채움(현재 null).",
]


# ── 최종 무결성 검증(조립 후) ────────────────────────────────────────
def validate_sim(sim):
    """조립된 sim 블록 무결성 검사 → 리포트 dict(위반 시 violations 채움)."""
    v = {"n_schools": len(sim["bySchool"]), "violations": [], "counts": sim["meta"]["counts"]}
    for idx, e in sim["bySchool"].items():
        phi = e.get("phi") or {}
        phis = [phi.get(k) for k in ("in", "out", "grad") if phi.get(k) is not None]
        if phis and sum(phis) > 1 + 1e-3:
            v["violations"].append((idx, "phi_sum>1", round(sum(phis), 4)))
        seg = e.get("seg") or {}
        for k in ("H_ug_in", "H_ug_out", "H_grad"):
            if seg.get(k) is not None and seg[k] < -1e-6:
                v["violations"].append((idx, f"neg_{k}", seg[k]))
        p = (e.get("price") or {}).get("p_ug")
        if p is not None and p < 0:
            v["violations"].append((idx, "neg_p_ug", p))
        sk = (e.get("surv") or {}).get("s_k") or []
        if sk and not _monotone(sk):
            v["violations"].append((idx, "s_k_nonmonotone", None))
    v["ok"] = len(v["violations"]) == 0
    return v


# ── 독립 실행 ────────────────────────────────────────────────────────
def run(interim_dir=None, dashboard_path=None, out_path=None):
    sim = compute_sim_params(interim_dir=interim_dir, dashboard_path=dashboard_path)
    rep = validate_sim(sim)
    interim = Path(interim_dir) if interim_dir else config.INTERIM_DIR
    out = Path(out_path) if out_path else (interim / "sim_params.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(sim, fh, ensure_ascii=False, separators=(",", ":"))
    return sim, rep, out


if __name__ == "__main__":
    sim, rep, out = run()
    c = sim["meta"]["counts"]
    n = len(sim["bySchool"])
    ug = c["ok"] + c["fallback"]  # 학부 보유(반응 가능) 모집단
    print(f"sim_params.json 저장: {out}  ({out.stat().st_size/1024:.0f} KB)")
    print(f"학교 {n}  | ok {c['ok']}  no_ug {c['no_ug']}  fallback {c['fallback']}")
    print(f"학부보유 {ug}교 중 폴백 {c['fallback']} = {c['fallback']/ug*100:.1f}%")
    print(f"무결성 검증: {'통과' if rep['ok'] else '위반 '+str(len(rep['violations']))}")
