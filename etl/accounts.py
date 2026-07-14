# -*- coding: utf-8 -*-
"""계정 레지스트리 구축: 원본 헤더 → (code, name, lv, parent, col_idx).

정규화 규칙:
  - 헤더의 공백을 전부 제거한 뒤 `^(\\d{4})_(.+)$` 매칭 → (code, name).
  - 실패 시 config.PSEUDO_HEADERS[side] 에서 의사코드를 찾는다.
  - 어느 쪽도 아니면 에러.

중복 키: side 내에서 동일 base 코드가 재등장하면 `#2`, `#3` 접미를 붙인다
(예: ex 의 4322, 4322#2, 4322#3). `#n` 키의 계층은 원 코드 기준으로 계산한다.

계층(코드 abcd):
  - cd==00           → 관 (lv1), parent 없음
  - d==0 and cd!=00  → 항 (lv2), parent ab00
  - 그 외            → 목 (lv3), parent abc0
  - 의사코드          → lv0 (합계·이월·기본금), parent 없음
"""
import json
import re

import config

_CODE_RE = re.compile(r"^(\d{4})_(.+)$")
_WS_RE = re.compile(r"\s+")

# 데이터 식별 컬럼(회계연도, 항목)은 계정이 아님
_META_COLS = {0, 1}


def _norm(raw):
    return _WS_RE.sub("", str(raw)) if raw is not None else ""


def _hierarchy(base_code):
    """base_code(#n 제거된 원 코드) 기준 (lv, parent) 반환."""
    if not (len(base_code) == 4 and base_code.isdigit()):
        return 0, None  # 의사코드
    cd = base_code[2:4]
    d = base_code[3]
    if cd == "00":
        return 1, None  # 관
    if d == "0":  # cd != "00"
        return 2, base_code[:2] + "00"  # 항
    return 3, base_code[:3] + "0"  # 목


def build_registry(side, headers):
    """헤더 리스트 → 계정 dict 리스트."""
    pseudo = config.PSEUDO_HEADERS[side]
    seen = {}
    out = []
    for idx, raw in enumerate(headers):
        if idx in _META_COLS:
            continue
        norm = _norm(raw)
        m = _CODE_RE.match(norm)
        if m:
            base = m.group(1)
            name = m.group(2)
        elif norm in pseudo:
            base = pseudo[norm]
            name = norm
        else:
            raise ValueError(
                f"[{side}] col {idx}: 헤더를 해석할 수 없음: {raw!r} (norm={norm!r})"
            )
        n = seen.get(base, 0) + 1
        seen[base] = n
        key = base if n == 1 else f"{base}#{n}"
        lv, parent = _hierarchy(base)
        out.append({"code": key, "name": name, "lv": lv, "p": parent, "col_idx": idx})
    return out


def build_all(headers_in, headers_ex, write=True):
    reg = {"in": build_registry("in", headers_in), "ex": build_registry("ex", headers_ex)}
    if write:
        config.INTERIM_DIR.mkdir(parents=True, exist_ok=True)
        path = config.INTERIM_DIR / "accounts.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(reg, f, ensure_ascii=False, indent=1)
    return reg


if __name__ == "__main__":
    import extract

    hin, _ = extract.extract_side("in")
    hex_, _ = extract.extract_side("ex")
    reg = build_all(hin, hex_)
    for side in ("in", "ex"):
        lvs = {}
        for a in reg[side]:
            lvs[a["lv"]] = lvs.get(a["lv"], 0) + 1
        print(f"[{side}] accounts={len(reg[side])} by_lv={lvs}")
