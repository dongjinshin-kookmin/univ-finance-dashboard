# -*- coding: utf-8 -*-
"""KPI 산식 해석기.

config.KPI_FORMULAS 의 토큰("in.5100", "-ex.OP_EX")을 파싱해
학교-연도 단위 계정값으로부터 지표를 계산한다.

토큰 규칙:
  - 접두 "-" 는 차감(부호 -1), 없으면 가산(+1)
  - 나머지는 "<side>.<key>" (side ∈ {in, ex})
계산 규칙(계약):
  - 분자(num): 부호를 반영해 합산. 결측값은 0으로 취급.
  - fmt=krw & den=None: 분자 합을 천원 정수로. 단 모든 분자항이 결측이면 None.
  - fmt=pct & den 존재: 분모 합이 0 또는 결측(합=0)이면 None, 아니면 분자/분모를 소수 4자리 반올림.
  - 산식에 등장하나 계정 체계에 존재하지 않는 키는 0 취급하되 경고로 수집한다.
"""


def parse_term(tok):
    """토큰 → (sign, side, key)."""
    sign = 1
    if tok.startswith("-"):
        sign = -1
        tok = tok[1:]
    side, key = tok.split(".", 1)
    return sign, side, key


def compile_formulas(formulas):
    """{name: (num_terms, den_terms|None, fmt)} 로 사전 컴파일."""
    compiled = {}
    for name, f in formulas.items():
        num = [parse_term(t) for t in f["num"]]
        den = [parse_term(t) for t in f["den"]] if f.get("den") else None
        compiled[name] = (num, den, f["fmt"])
    return compiled


def formula_missing_keys(formulas, existing):
    """산식이 참조하나 계정 체계(existing: {(side,key)})에 없는 키 목록(정렬)."""
    miss = set()
    for f in formulas.values():
        terms = list(f["num"]) + list(f.get("den") or [])
        for tok in terms:
            _, side, key = parse_term(tok)
            if (side, key) not in existing:
                miss.add(f"{side}.{key}")
    return sorted(miss)


def compute_kpis(getval, compiled):
    """단일 학교-연도의 KPI 전종.

    getval(side, key) -> 숫자 또는 None(결측).
    반환: {지표명: 값 또는 None}
    """
    out = {}
    for name, (num, den, fmt) in compiled.items():
        num_pairs = [(sign, getval(side, key)) for sign, side, key in num]
        num_sum = sum(sign * (v or 0) for sign, v in num_pairs)
        all_num_none = all(v is None for _, v in num_pairs)

        if den is None:
            out[name] = None if all_num_none else int(round(num_sum))
        else:
            den_sum = sum(sign * (getval(side, key) or 0) for sign, side, key in den)
            if den_sum == 0:
                out[name] = None
            else:
                out[name] = round(num_sum / den_sum, 4)
    return out
