# -*- coding: utf-8 -*-
"""학령인구 실적·추계 보정계수 산출 (WBS A7, 순수 계산·네트워크 없음).

설계 근거: docs/시뮬레이션_모델_설계.md 3.3(f0 드리프트)·3.4(실적 기준·추계 편향 보정)·10.2(sim.meta.pop_*).

입력(build/interim/):
  population_actual.csv     (sido전체명, year 2016~2024, age_group, population)  등록지 **실적**
  population_projection.csv (sido전체명, year 2022~2052, age_group, population)  거주지 **추계**

핵심 사실(build/d4_report.md): 대학학령(18-21세) 추계가 실적을 계통적으로 과대(개념 차이 —
추계=거주지/센서스, 실적=등록지/주민등록). 유입지(대전·충남 등) 과대, 배출지·수도권 과소.
학령인구(6-21)는 추계≈실적. → 대학학령 추계는 시도별 c_sido로 보정 후에만 사용.

함수형 인터페이스(build_json.py A6에서 import):
  c_sido(years=CORR_YEARS)  → {sido_short: c}   시도별 보정계수(mean(실적/추계))       (3.4)
  merged_pop_univ(end)      → {sido_short: {year: pop}}  대학학령 병합 시계열
                              (실적 2016~2024 + 보정추계(추계×c) 2025~end)          (3.4)
  drift_yoy(end)            → {sido_short: {year: d}}   전년비 감소율(소수)
  drift_cumulative(base,end)→ {sido_short: {year: d}}   d_sido(t)=pop(t)/pop(t0)-1  (3.3 f0 드리프트 입력)
  national_18_actual()      → {year: pop}  전국 18세 실적(검증용)

CLI: python3 etl/pop_correction.py → build/interim/pop_correction.csv, pop_drift.csv 기록(멱등).
"""
import csv

import config

# ── 상수 ────────────────────────────────────────────────────────────────
AGE_UNIV = "대학학령(18-21세)"          # 보정·드리프트 기준 연령계층(실적·추계 공통 존재)
AGE_18 = "18세"                          # 실적 전용(검증용, 추계엔 없음)

CORR_YEARS = (2024,)                     # c_sido 산정 구간(기획자 결정): 2024 단년비
#                                          이음매 연속성·최신 대표성 우선(d7 §3.1). 3.4 원공식은
#                                          mean(2022~2024) — years=(2022,2023,2024)로 재현.
HIST_START, HIST_END = 2016, 2024        # 실적 구간
FUTURE_END = 2040                        # 미래 구간 종료(f0 드리프트 사용 범위)
DRIFT_BASE = 2024                        # 3.3 d_sido(t)의 기준연도 t0(최근 실측)

# 인구 CSV sido 전체명 → 학교 sido 약칭(ext_data.SIDO_FULL_TO_SHORT와 동일한 조인 키).
SIDO_FULL_TO_SHORT = {
    "강원도": "강원", "경기도": "경기", "경상남도": "경남", "경상북도": "경북",
    "광주광역시": "광주", "대구광역시": "대구", "대전광역시": "대전",
    "부산광역시": "부산", "서울특별시": "서울", "세종특별자치시": "세종",
    "울산광역시": "울산", "인천광역시": "인천", "전라남도": "전남",
    "전라북도": "전북", "제주특별자치도": "제주", "충청남도": "충남",
    "충청북도": "충북",
}


# ── 원자료 로딩(순수) ─────────────────────────────────────────────────────
def _read_pop(fname, age_group):
    """population CSV → {sido_short: {year: population(float)}} for one age_group."""
    out = {}
    with open(config.INTERIM_DIR / fname, encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            if r.get("age_group") != age_group:
                continue
            short = SIDO_FULL_TO_SHORT.get(r["sido"])
            if short is None:
                continue
            try:
                y = int(r["year"])
                pop = float(r["population"])
            except (ValueError, TypeError, KeyError):
                continue
            out.setdefault(short, {})[y] = pop
    return out


def _actual_univ():
    return _read_pop("population_actual.csv", AGE_UNIV)


def _projection_univ():
    return _read_pop("population_projection.csv", AGE_UNIV)


# ── c_sido: 시도별 추계 편향 보정계수 (3.4) ──────────────────────────────
def c_sido(years=CORR_YEARS, actual=None, projection=None):
    """c_sido = mean_{years}( 실적_대학학령 / 추계_대학학령 ).

    3.4 공식(기본 years=2022~2024). 반환 {sido_short: c(float)}.
    참고: 설계 예시값(대전≈0.82·충남≈0.87·경기≈1.03)은 2024 **단년** 비율과 일치한다.
    편향이 2022→2024로 축소되어 3년 평균은 유입지에서 예시보다 소폭 낮다. years=(2024,)로 호출하면
    예시값을 재현한다.
    """
    act = actual if actual is not None else _actual_univ()
    proj = projection if projection is not None else _projection_univ()
    out = {}
    for s in SIDO_FULL_TO_SHORT.values():
        ratios = []
        for y in years:
            a = act.get(s, {}).get(y)
            p = proj.get(s, {}).get(y)
            if a is not None and p:
                ratios.append(a / p)
        if ratios:
            out[s] = sum(ratios) / len(ratios)
    return out


# ── 병합 시계열: 실적 + 보정추계 (3.4) ───────────────────────────────────
def merged_pop_univ(end=FUTURE_END, years=CORR_YEARS, actual=None, projection=None):
    """대학학령(18-21) 병합 시계열 → {sido_short: {year: pop}}.

    year ≤ 2024  : 실적(population_actual)
    year ≥ 2025  : 보정추계 = 추계 × c_sido           (3.4 "보정_대학학령(t)=추계×c_sido, t≥2025")
    범위 2016..end. 미래 상한 end(기본 2040)는 f0 드리프트 사용 구간.
    """
    act = actual if actual is not None else _actual_univ()
    proj = projection if projection is not None else _projection_univ()
    c = c_sido(years=years, actual=act, projection=proj)
    out = {}
    for s in SIDO_FULL_TO_SHORT.values():
        ser = {}
        for y in range(HIST_START, HIST_END + 1):
            v = act.get(s, {}).get(y)
            if v is not None:
                ser[y] = v
        cs = c.get(s)
        for y in range(HIST_END + 1, end + 1):
            p = proj.get(s, {}).get(y)
            if p is not None and cs is not None:
                ser[y] = p * cs
        out[s] = ser
    return out


# ── 드리프트(감소율) 시계열 ───────────────────────────────────────────────
def drift_yoy(end=FUTURE_END, years=CORR_YEARS, merged=None):
    """전년비 감소율 d(t)=pop(t)/pop(t-1)-1 → {sido_short: {year: d}}.

    (미래 구간 내부의 전년비는 c_sido가 비율에서 소거되어 추계 자체의 전년비와 같다.
     2024→2025 이음매만 실적↔보정추계 레벨 차로 c 영향을 받는다.)
    """
    m = merged if merged is not None else merged_pop_univ(end=end, years=years)
    out = {}
    for s, ser in m.items():
        yrs = sorted(ser)
        d = {}
        for y in yrs:
            prev = ser.get(y - 1)
            if prev:
                d[y] = ser[y] / prev - 1.0
        out[s] = d
    return out


def drift_cumulative(base=DRIFT_BASE, end=FUTURE_END, years=CORR_YEARS, merged=None):
    """3.3 f0 드리프트 입력: d_sido(t) = pop18_sido(t)/pop18_sido(t0) - 1.

    t0=base(기본 2024, 최근 실측). t≥2025는 보정추계 기준. 반환 {sido_short: {year: d}}.
    f0(t)=f0(t0)·(1+λ·d_sido(t)) 로 소비(3.3).
    """
    m = merged if merged is not None else merged_pop_univ(end=end, years=years)
    out = {}
    for s, ser in m.items():
        b = ser.get(base)
        if not b:
            out[s] = {}
            continue
        out[s] = {y: ser[y] / b - 1.0 for y in sorted(ser)}
    return out


# ── 검증 보조 ─────────────────────────────────────────────────────────────
def national_18_actual():
    """전국 18세 단일연령 실적 {year: pop}. (검증용 — d4_report 2016≈64만→2024≈45만.)"""
    a18 = _read_pop("population_actual.csv", AGE_18)
    tot = {}
    for ser in a18.values():
        for y, v in ser.items():
            tot[y] = tot.get(y, 0.0) + v
    return tot


def national_weighted_c(years=CORR_YEARS, weight_year=2024, actual=None, projection=None):
    """추계인구(weight_year) 가중 c_sido 평균 → 전국 대표 보정계수(검증 b).

    범위 검증 기준: 1/(1+0.029~0.046) = [0.9560, 0.9718].
    """
    proj = projection if projection is not None else _projection_univ()
    c = c_sido(years=years, actual=actual, projection=proj)
    num = den = 0.0
    for s, cs in c.items():
        w = proj.get(s, {}).get(weight_year)
        if w:
            num += cs * w
            den += w
    return num / den if den else None


# ── CSV 산출(중간 검증용) ─────────────────────────────────────────────────
def write_csvs(years=CORR_YEARS, end=FUTURE_END):
    """build/interim/pop_correction.csv(17행) + pop_drift.csv(전년비) 기록. 반환 (경로,경로)."""
    c = c_sido(years=years)
    p_corr = config.INTERIM_DIR / "pop_correction.csv"
    with open(p_corr, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["sido", "c_sido"])
        for s in sorted(c):
            w.writerow([s, f"{c[s]:.4f}"])

    d = drift_yoy(end=end, years=years)
    p_drift = config.INTERIM_DIR / "pop_drift.csv"
    with open(p_drift, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["sido", "year", "d_sido"])
        for s in sorted(d):
            for y in sorted(d[s]):
                w.writerow([s, y, f"{d[s][y]:.6f}"])
    return p_corr, p_drift


if __name__ == "__main__":
    a, b = write_csvs()
    cc = c_sido()
    print(f"wrote {a} ({len(cc)} sido)")
    print(f"wrote {b}")
    for s in ("서울", "대전", "충남", "경기", "경북"):
        print(f"  c[{s}] = {cc[s]:.4f}")
    print(f"national weighted c = {national_weighted_c():.4f}  (target 0.9560~0.9718)")
    n18 = national_18_actual()
    print(f"전국 18세 실적 2016={n18[2016]:.0f} 2024={n18[2024]:.0f}")
