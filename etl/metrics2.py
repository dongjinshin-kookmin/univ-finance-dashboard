# -*- coding: utf-8 -*-
"""확장 지표(E4) 순수 계산 로직.

여기에는 데이터 로딩이 없다. ext_data.py가 로드한 값을 받아
적립금지속월수·위기스코어·폐교궤적 중앙값 같은 파생값을 계산한다.

위기스코어 설계(투명성):
  최신 가용 연도 기준 5개 요소를 "위험 방향" 값으로 변환한 뒤
  전체 학교 분포에서의 백분위(0~1, 높을수록 위험)를 구해 평균 × 100.
  요소별 위험 방향 변환:
    ① 충원율        낮을수록 위험 → risk = -fill
    ② 등록금의존율   높을수록 위험 → risk = +dep
    ③ 운영수지율     낮을수록 위험 → risk = -surplus
    ④ 적립금지속월수 낮을수록 위험 → risk = -months
    ⑤ 시도 18-21세 2024→2040 감소율  클수록 위험 → risk = -decline
  가용 요소만 평균(결측 제외). 요소 2개 미만이면 None.
"""

CRISIS_DEF = (
    "최신 가용 연도 기준 5개 요소(①충원율 낮을수록 ②등록금의존율_총계 높을수록 "
    "③운영수지율 낮을수록 ④적립금지속월수 낮을수록 ⑤소재 시도 18-21세 2024→2040 "
    "감소율 클수록)를 위험 방향으로 변환해 전체 학교 분포 내 백분위(0~1)를 구하고, "
    "가용 요소만 평균한 뒤 ×100. 요소 2개 미만이면 null. 값이 클수록 위험(0~100)."
)


def reserve_months(reserve_total, op_ex):
    """적립금총액 ÷ (운영지출 ÷ 12). 운영지출 결측/0 → None."""
    if reserve_total is None or op_ex in (None, 0):
        return None
    return round(reserve_total / (op_ex / 12.0), 4)


def median(vals):
    """결측 제외 중앙값. 빈 목록 → None."""
    xs = sorted(v for v in vals if v is not None)
    n = len(xs)
    if n == 0:
        return None
    mid = n // 2
    if n % 2:
        return xs[mid]
    return (xs[mid - 1] + xs[mid]) / 2.0


def mean(vals):
    xs = [v for v in vals if v is not None]
    if not xs:
        return None
    return sum(xs) / len(xs)


def _pct_rank(sorted_dist, x):
    """분포 내 x의 백분위(0~1). (미만 개수 + 0.5·동률)/n. 높을수록 상위."""
    n = len(sorted_dist)
    if n == 0:
        return None
    less = 0
    eq = 0
    for v in sorted_dist:
        if v < x:
            less += 1
        elif v == x:
            eq += 1
    return (less + 0.5 * eq) / n


def crisis_scores(school_ids, factor_values, min_factors=2):
    """위기스코어 산출.

    factor_values: {요소명: {school_id: 위험방향값}} — 결측 학교는 키 부재.
    반환: {school_id: 0~100 점수(소수4) 또는 None}.
    """
    dists = {f: sorted(v.values()) for f, v in factor_values.items()}
    out = {}
    for s in school_ids:
        pcts = []
        for f, vals in factor_values.items():
            if s in vals:
                p = _pct_rank(dists[f], vals[s])
                if p is not None:
                    pcts.append(p)
        if len(pcts) >= min_factors:
            out[s] = round(sum(pcts) / len(pcts) * 100, 4)
        else:
            out[s] = None
    return out
