"""sim_reference.py — dashboard/src/sim_model.js의 파이썬 참조 구현 (D4 동형성 검증용).

sim_model.js의 project / computeKPIs / kpisForRow / recalcSeries / scenarios /
residualBand 를 **연산 순서까지 동일하게** 포팅한 순수 참조 구현이다. 이 모듈과
JS 엔진의 수치가 상대 1e-9 이내로 일치해야 한다(부동소수점 연산 순서 차이만 허용).

설계 근거: docs/시뮬레이션_모델_설계.md 2·3·4·5·7장·부록.
임의보정 6건(build/d10_report.md §3.4)을 동일 반영:
  1. fMaxEff = max(fMax, f0)                         — 정원초과 학교 허위손실 방지
  2. capCarryForward (기본 True)                     — price_cap 마지막 공고값 캐리포워드
  3. s_k 꼬리 절단                                   — sim_params.py 저장값을 그대로 사용(별도 처리 불요)
  4. dropout 스트레스: s_k[k>=1] *= (1-dropout)      — 균일 축소
  5. λ 드리프트 누적: d_sido(t)=Π(1+d_annual)-1      — YoY 감소율 누적
  6. KPI null 전파: 산식 항 중 하나라도 None이면 KPI=None

JS의 `x != null`(null도 undefined도 아님) 의미는 파이썬에서 `x is not None`으로 표현한다.
JS의 `a || b`(falsy 폴백)는 `a if <truthy> else b`로, `a ?? b`는 `a if a is not None else b`로 옮긴다.
"""

import math


# ── 소형 유틸 (sim_model.js num/n0/clamp0 동형) ─────────────────────────────
def num(x):
    """typeof x==='number' && isFinite(x) ? x : null."""
    if isinstance(x, bool):
        return None
    if isinstance(x, (int, float)) and math.isfinite(x):
        return x
    return None


def n0(x):
    """null → 0 (금액 합산용)."""
    v = num(x)
    return 0 if v is None else v


def clamp0(x):
    return 0 if x < 0 else x


# ── 감축 스케줄 r(c) (sim_model.js reductionOf 동형) ───────────────────────
def reduction_of(params, c):
    t0 = params["t0"]
    r = params.get("r") or 0            # params.r || 0
    rsched = params.get("rSchedule")
    if rsched:                          # 명시 스케줄 우선
        v = rsched.get(str(c))
        if v is not None:
            return v
        return 0 if c < t0 else r
    if c < t0:
        return 0
    if (params.get("profile") or "immediate") == "linear":
        ramp = params.get("rampYears") or 5
        return r * min(1, (c - t0 + 1) / ramp)
    return r                            # immediate


# ── 단가 상승 π(t) (sim_model.js piRateOf 동형) ────────────────────────────
def pi_rate_of(mode, params, meta, year, cap_carry_forward):
    if (not mode) or mode == "freeze":
        return 0
    if mode == "custom":
        return params.get("piRate") or 0
    cap = (meta.get("price_cap") if meta else None) or {}
    v = cap.get(str(year))
    if v is None and cap_carry_forward is not False:
        yrs = [int(k) for k in cap.keys()]
        if yrs:
            v = cap.get(str(max(yrs)))
    v = v or 0
    return v / 2 if mode == "half" else v      # 'cap'


# ── f0 인구 드리프트 누적 (sim_model.js cumDrift 동형) ─────────────────────
def cum_drift(meta, sido, t0, t):
    if (not meta) or (not meta.get("pop18_decline")) or (not sido) or t <= t0:
        return 0
    s = meta["pop18_decline"].get(sido)
    if not s:
        return 0
    idx = 1
    for y in range(t0 + 1, t + 1):
        d = s.get(str(y))
        idx *= (1 + (d or 0))
    return idx - 1


# ── 파라미터 해상 (sim_model.js resolveParams 동형) ────────────────────────
def resolve_params(params, meta):
    params = params or {}
    d = (meta.get("defaults") if meta else None) or {}

    def pv(key):                 # params.<key> (없으면 None)
        return params.get(key)

    def dd(key):                 # defaults.<key>
        return d.get(key)

    return {
        "t0": pv("t0") if pv("t0") is not None else 2025,
        "r": pv("r") if pv("r") is not None else 0,
        "horizon": pv("horizon") if pv("horizon") is not None else 10,
        "profile": pv("profile") or "immediate",
        "rampYears": pv("rampYears") or 5,
        "rSchedule": pv("rSchedule") or None,
        "fillMode": pv("fillMode") or "realistic",
        "beta": pv("beta") if pv("beta") is not None else (dd("beta") if dd("beta") is not None else 0.5),
        "fMax": pv("fMax") if pv("fMax") is not None else 1.0,
        "piMode": pv("piMode") or "freeze",
        "piRate": pv("piRate") if pv("piRate") is not None else 0,
        "capCarryForward": pv("capCarryForward") is not False,
        "eta5120": pv("eta5120") if pv("eta5120") is not None else (dd("eta_5120") if dd("eta_5120") is not None else 0.3),
        "gamma": pv("gamma") if pv("gamma") is not None else (dd("gamma") if dd("gamma") is not None else 0.15),
        "gammaLabor": pv("gammaLabor"),
        "dropout": pv("dropout") if pv("dropout") is not None else (dd("dropout") or 0),
        "lambda": pv("lambda") if pv("lambda") is not None else (dd("lambda_") or 0),
    }


# ══════════════════════════════════════════════════════════════════════════
#  B1 — 코어 투영 project (sim_model.js project 동형)
# ══════════════════════════════════════════════════════════════════════════
def project(school_sim, params, opts=None):
    opts = opts or {}
    meta = opts.get("meta") or {}
    P = resolve_params(params, meta)
    gamma_labor = P["gammaLabor"] if P["gammaLabor"] is not None else P["gamma"]

    seg = school_sim.get("seg") or {}
    price = school_sim.get("price") or {}
    surv = school_sim.get("surv") or {}
    base = school_sim.get("base") or {}
    phi = school_sim.get("phi") or {}
    status = (school_sim.get("flags") or {}).get("status")

    A_in = num(seg.get("A_in"))
    Q = num(seg.get("Q"))
    H_in0 = num(seg.get("H_ug_in"))
    p_ug0 = num(price.get("p_ug"))
    m_in = num(surv.get("m_in"))
    s_k = surv.get("s_k") or []

    # 반응 세그먼트 존재 여부 (설계 1.5·2.5)
    responsive = (status != "no_ug" and p_ug0 is not None and A_in is not None and A_in > 0
                  and H_in0 is not None and H_in0 > 0 and len(s_k) > 0)

    # 이탈률 스트레스: s_k(k>=1) 균일 축소 (기본 dropout=0 → 무변화)
    dropout = P["dropout"]
    sEff = [(v * (1 - dropout)) if k >= 1 else v for k, v in enumerate(s_k)]

    # 기준 충원율 f0 = A_in/Q, f_max 하한 가드
    f0 = (A_in / Q) if (Q and Q > 0) else 1.0
    fMaxEff = max(P["fMax"], f0)

    lam = P["lambda"]
    beta = P["beta"]
    t0 = P["t0"]
    horizon = P["horizon"]

    def f_ceiling(c):
        d = cum_drift(meta, opts.get("sido"), t0, c) if lam else 0
        f0c = f0 * (1 + lam * d)
        return min(fMaxEff, f0c + beta * reduction_of(P, c))

    def a_prime(c):
        rc = reduction_of(P, c)
        if P["fillMode"] == "conservative":
            return A_in * (1 - rc)                      # 옵션1 보수
        return min(A_in, Q * (1 - rc) * f_ceiling(c))   # 옵션2 현실(수요앵커 min)

    def dA(c):
        return (a_prime(c) - A_in) if responsive else 0

    # π 누적계수 piFactor(t)
    years = []
    piFactor = {}
    acc = 1
    for t in range(t0, t0 + horizon + 1):
        if t > t0:
            acc *= (1 + pi_rate_of(P["piMode"], P, meta, t, P["capCarryForward"]))
        piFactor[t] = acc
        years.append(t)

    c5111 = n0(base.get("c5111"))
    c5112 = n0(base.get("c5112"))
    c5120 = n0(base.get("c5120"))
    c5100 = n0(base.get("c5100"))  # noqa: F841 (JS와 동형 유지; 미사용)
    c5110 = c5111 + c5112          # noqa: F841

    rows = []
    for t in years:
        # 컨볼루션 ΔH_ug_in(t) = Σ_c ΔA_in(c)·s_{t-c}
        dH = 0
        if responsive:
            for c in range(t0, t + 1):
                k = t - c
                if k < len(sEff):
                    dH += dA(c) * sEff[k]
        pf = piFactor[t]
        pUgT = (p_ug0 * pf) if p_ug0 is not None else None
        d5112 = (pUgT * dH) if responsive else 0
        d5120 = (c5120 * P["eta5120"] * (dH / H_in0) * pf) if (responsive and H_in0) else 0
        d5100 = d5112 + d5120

        b5112 = c5112 * pf
        b5120 = c5120 * pf
        b5110 = c5111 + b5112
        b5100 = b5110 + b5120

        rows.append({
            "year": t,
            "dA_in": (dA(t) if responsive else 0),
            "dH_ug_in": dH,
            "d5112": d5112, "d5120": d5120, "d5100": d5100,
            "lvl5112": b5112 + d5112,
            "lvl5110": b5110 + d5112,
            "lvl5120": b5120 + d5120,
            "lvl5100": b5100 + d5100,
            "base5112": b5112, "base5110": b5110, "base5120": b5120, "base5100": b5100,
            "p_ug": pUgT,
            "H_ug_in": clamp0(H_in0 + dH) if H_in0 is not None else 0,
            "piFactor": pf,
        })

    return {
        "years": years, "rows": rows, "responsive": responsive, "status": status,
        "params": P,
        "meta": {
            "t0": t0, "f0": f0, "fMaxEff": fMaxEff, "m_in": m_in, "p_ug0": p_ug0,
            "phi_in": num(phi.get("in")), "phi_out": num(phi.get("out")), "phi_grad": num(phi.get("grad")),
            "H_ug_in0": H_in0, "A_in0": A_in, "Q0": Q, "gammaLabor": gamma_labor,
        },
    }


# ══════════════════════════════════════════════════════════════════════════
#  B2 — KPI 재계산 (sim_model.js 동형; config.py KPI_FORMULAS 포팅)
# ══════════════════════════════════════════════════════════════════════════
KPI_DEFS = {
    "등록금의존율_총계": {"num": ["c5100"], "den": ["cT_IN"], "fmt": "pct"},
    "등록금의존율_운영": {"num": ["c5100"], "den": ["cOP_IN"], "fmt": "pct"},
    "운영수지": {"num": ["cOP_IN", "-cOP_EX"], "den": None, "fmt": "krw"},
    "운영수지율": {"num": ["cOP_IN", "-cOP_EX"], "den": ["cOP_IN"], "fmt": "pct"},
    "법인전입금비율": {"num": ["c5210"], "den": ["cOP_IN"], "fmt": "pct"},
    "장학금지원율": {"num": ["c4321", "c4322"], "den": ["c5100"], "fmt": "pct"},
    "인건비부담률": {"num": ["c4100"], "den": ["c5100"], "fmt": "pct"},
    "교육비환원율": {"num": ["c4100", "c4200", "c4300", "-c4330", "c1317", "c1314"], "den": ["c5100"], "fmt": "pct"},
}


def _sum_terms(acc, terms):
    """항 중 하나라도 None이면 None 반환(null 전파)."""
    s = 0
    any_ = False
    for t in terms:
        neg = t[0] == "-"
        key = t[1:] if neg else t
        v = acc.get(key)
        if v is None:
            return None
        s += (-v) if neg else v
        any_ = True
    return s if any_ else None


def compute_kpis(acc):
    out = {}
    for name, dfn in KPI_DEFS.items():
        nu = _sum_terms(acc, dfn["num"])
        if nu is None:
            out[name] = None
            continue
        if not dfn["den"]:
            out[name] = nu
            continue
        de = _sum_terms(acc, dfn["den"])
        out[name] = None if (de is None or de == 0) else nu / de
    return out


def flat_accounts(base, overrides=None):
    e = base.get("edu_cost") or {}
    acc = {
        "c5100": num(base.get("c5100")), "cT_IN": num(base.get("cT_IN")),
        "cOP_IN": num(base.get("cOP_IN")), "cOP_EX": num(base.get("cOP_EX")),
        "c4100": num(base.get("c4100")), "c5210": num(base.get("c5210")),
        "c4321": num(base.get("c4321")), "c4322": num(base.get("c4322")),
        "c4200": num(e.get("c4200")), "c4300": num(e.get("c4300")), "c4330": num(e.get("c4330")),
        "c1317": num(e.get("c1317")), "c1314": num(e.get("c1314")),
    }
    if overrides:
        for k, v in overrides.items():
            acc[k] = v
    return acc


def kpis_for_row(school_sim, row, proj_meta, params, opts=None):
    base = school_sim.get("base") or {}
    orig_acc = flat_accounts(base)
    orig = compute_kpis(orig_acc)

    d5100 = row["d5100"]
    H0 = proj_meta["H_ug_in0"]
    ratio = (row["dH_ug_in"] / H0) if (H0 and H0 > 0) else 0
    gamma_labor = proj_meta["gammaLabor"]
    gamma = proj_meta.get("gammaGeneral")
    if gamma is None:
        gamma = params.get("gamma") if params else None
    if gamma is None:
        gamma = 0.15

    c4100 = n0(base.get("c4100"))
    cOP_EX = n0(base.get("cOP_EX"))
    d4100 = gamma_labor * ratio * c4100
    dOpEx = d4100 + gamma * ratio * (cOP_EX - c4100)

    prime_acc = flat_accounts(base, {
        "c5100": n0(base.get("c5100")) + d5100,
        "cOP_IN": n0(base.get("cOP_IN")) + d5100,
        "cT_IN": n0(base.get("cT_IN")) + d5100,
        "c4100": c4100 + d4100,
        "cOP_EX": cOP_EX + dOpEx,
    })
    primed = compute_kpis(prime_acc)

    delta = {}
    for name in KPI_DEFS:
        delta[name] = (None if (orig[name] is None or primed[name] is None)
                       else (primed[name] - orig[name]))
    return {
        "original": orig, "primed": primed, "delta": delta,
        "aux": {"d4100": d4100, "dOpEx": dOpEx, "ratio": ratio,
                "fmt": {k: v["fmt"] for k, v in KPI_DEFS.items()}},
    }


def recalc_series(school_sim, projection, params, opts=None):
    pm = projection["meta"]
    pm["gammaGeneral"] = projection["params"]["gamma"]
    out = []
    for row in projection["rows"]:
        k = kpis_for_row(school_sim, row, pm, projection["params"], opts)
        out.append({"year": row["year"], "original": k["original"],
                    "primed": k["primed"], "delta": k["delta"], "aux": k["aux"]})
    return out


# ══════════════════════════════════════════════════════════════════════════
#  B3 — 시나리오 3종 + 잔차 밴드 (sim_model.js 동형)
# ══════════════════════════════════════════════════════════════════════════
SCENARIO_BUNDLES = {
    "optimistic": {"fillMode": "realistic", "beta": 1.0, "piMode": "cap", "gamma": 0.3},
    "base": {"fillMode": "realistic", "beta": 0.5, "piMode": "freeze", "gamma": 0.15},
    "pessimistic": {"fillMode": "conservative", "beta": 0.0, "piMode": "freeze", "gamma": 0.0},
}


def scenarios(school_sim, user_params, opts=None):
    user_params = user_params or {}
    shared_keys = ["r", "t0", "horizon", "profile", "rampYears", "rSchedule",
                   "eta5120", "dropout", "lambda", "fMax", "capCarryForward"]
    shared = {k: user_params.get(k) for k in shared_keys if user_params.get(k) is not None}
    out = {}
    for key, b in SCENARIO_BUNDLES.items():
        p = dict(shared)
        for q, val in b.items():
            p[q] = val
        proj = project(school_sim, p, opts)
        out[key] = {"projection": proj, "kpis": recalc_series(school_sim, proj, p, opts), "bundle": b}
    return out


def residual_band(values, bt, opts=None):
    opts = opts or {}
    z = opts.get("z") if opts.get("z") is not None else 1.28
    if bt:
        field = opts.get("field")
        if field:
            mape = bt.get(field)
        else:
            mape = bt.get("mape_rev") if bt.get("mape_rev") is not None else bt.get("mape_enroll")
    else:
        mape = None
    if bt is None or mape is None:
        return {"omitted": True, "reason": "bt_null", "lo": None, "hi": None, "z": z}
    lo, hi = [], []
    for v in values:
        if v is None:
            lo.append(None)
            hi.append(None)
            continue
        half = z * mape * abs(v)
        lo.append(v - half)
        hi.append(v + half)
    return {"omitted": False, "lo": lo, "hi": hi, "z": z, "sigma_rel": mape}
