# -*- coding: utf-8 -*-
"""폐교·법인해산 현황 수집 → build/interim/closed_schools.csv.

원천: 공공데이터포털 15112170 "한국사학진흥재단_폐교 및 법인 해산 현황" CSV
      (무로그인 3단계 다운로드 — fetch_kasfo_bs.download_datago_file 재사용, cp949).

원천 컬럼: 대학구분, 학교명(법인명), 폐교 년도, 법인해산-파산-존속, 폐교 지역(본교기준), 비고

산출: build/interim/closed_schools.csv (utf-8-sig)
  canonical, closed_year, sido, corp_status, school_type
  - canonical: '학교명(법인명)' 에서 법인명 괄호를 제거한 학교명(정규화 계약 그룹1)
  - sido: '폐교 지역(본교기준)' 의 첫 토큰(광역시도)
  - corp_status: 존속/해산/파산
  - school_type: 대학/전문대학 등(대학구분)

재실행 멱등: 원천은 metadata/raw/closed_datago.csv 에 캐시(--force 로 강제).
"""
import csv
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    from etl.config import METADATA_DIR, INTERIM_DIR
except Exception:
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from etl.config import METADATA_DIR, INTERIM_DIR

from metadata.fetch_kasfo_bs import download_datago_file, canonicalize, _decode

CLOSED_PK = "15112170"
CLOSED_RAW = METADATA_DIR / "raw" / "closed_datago.csv"
OUT_CSV = INTERIM_DIR / "closed_schools.csv"

FIELDS = ["canonical", "closed_year", "sido", "corp_status", "school_type"]


def _sido(region):
    """'강원 동해' → '강원' (첫 토큰). 빈 값이면 ''."""
    region = (region or "").strip()
    return region.split()[0] if region else ""


def build(force=False):
    INTERIM_DIR.mkdir(parents=True, exist_ok=True)
    download_datago_file(CLOSED_PK, CLOSED_RAW, force=force)

    txt = _decode(CLOSED_RAW.read_bytes())
    rows = list(csv.reader(txt.splitlines()))
    hdr = rows[0]
    idx = {name.strip(): i for i, name in enumerate(hdr)}
    c_type = idx["대학구분"]
    c_name = idx["학교명(법인명)"]
    c_year = idx["폐교 년도"]
    c_corp = idx["법인해산-파산-존속"]
    c_region = idx["폐교 지역(본교기준)"]

    out = []
    for r in rows[1:]:
        if not r or not r[c_name].strip():
            continue
        out.append({
            "canonical": canonicalize(r[c_name]),
            "closed_year": r[c_year].strip(),
            "sido": _sido(r[c_region]),
            "corp_status": r[c_corp].strip(),
            "school_type": r[c_type].strip(),
        })

    with open(OUT_CSV, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(out)
    print("[closed_schools] %d rows -> %s" % (len(out), OUT_CSV))
    return out


if __name__ == "__main__":
    build(force="--force" in sys.argv)
