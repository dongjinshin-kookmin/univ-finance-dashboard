# -*- coding: utf-8 -*-
"""KESS(교육통계서비스) 고등교육 「학교별」 데이터셋 다운로드.

대상: https://kess.kedi.re.kr/contents/dataset?itemCode=04&menuId=m_02_04_03_02&tabId=m2
페이지 HTML 의 downLoad('ID','서버파일명','저장명','그룹') 목록을 파싱해
"{연도}년 고등 학교별 ... 교직원" 항목(그룹 02=고등)을 골라 연도별로 내려받는다.
다운로드 URL: /contents/dataSet/downLoad.do?fileNm={서버파일명}&userfileNm={저장명}
(로그인 불필요, 실증됨)

산출: metadata/raw/kess_{year}.xlsx  (year = 2016..2024)
      → 연도별 학교별 재학생/재적생/전임교원 등 (학교별 교육통계 시트)
이미 있으면 재다운로드하지 않는다(--force 로 강제).
"""
import re
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    from etl.config import METADATA_DIR, YEARS
except Exception:
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from etl.config import METADATA_DIR, YEARS

import requests

PAGE_URL = "https://kess.kedi.re.kr/contents/dataset?itemCode=04&menuId=m_02_04_03_02&tabId=m2"
DL_URL = "https://kess.kedi.re.kr/contents/dataSet/downLoad.do"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")

RAW_DIR = METADATA_DIR / "raw"
# downLoad('ID','FILE_PATH','FILE_NAME','GROUP')
DL_RE = re.compile(r"downLoad\('([^']*)','([^']*)','([^']*)','([^']*)'\)")
# "{연도}년 고등 학교별 ... 교직원"  (학과별/학교별X학과별 은 제외)
NAME_RE = re.compile(r"^(20\d\d)년\s*고등\s*학교별\s*학과수.*교직원")


def _discover(session):
    """페이지에서 연도 -> 서버파일명 매핑을 파싱한다."""
    html = session.get(PAGE_URL, timeout=40).text
    mapping = {}
    for _id, file_path, file_name, group in DL_RE.findall(html):
        if group != "02":  # 02 = 고등(higher ed)
            continue
        m = NAME_RE.match(file_name.strip())
        if not m:
            continue
        year = int(m.group(1))
        # 동일 연도 중복 시 첫(최신 갱신) 항목 유지
        mapping.setdefault(year, (file_path, file_name))
    return mapping


def fetch(force=False):
    """KESS 연도별 xlsx 를 내려받고 {year: path} 를 반환한다."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    s = requests.Session()
    s.headers.update({"User-Agent": UA})

    mapping = _discover(s)
    missing_years = [y for y in YEARS if y not in mapping]
    if missing_years:
        print("[kess] WARN: 페이지에서 못 찾은 연도: %s (파싱된 연도: %s)"
              % (missing_years, sorted(mapping)))

    out = {}
    for year in YEARS:
        dest = RAW_DIR / ("kess_%d.xlsx" % year)
        if dest.exists() and not force:
            print("[kess] cache hit: %s" % dest.name)
            out[year] = dest
            continue
        if year not in mapping:
            print("[kess] SKIP %d: 다운로드 링크 없음" % year)
            continue
        file_path, file_name = mapping[year]
        params = {"fileNm": file_path, "userfileNm": "kess_%d.xlsx" % year}
        r = s.get(DL_URL, params=params, headers={"Referer": PAGE_URL}, timeout=120)
        r.raise_for_status()
        if r.content[:2] != b"PK":  # xlsx(zip) 시그니처 확인
            print("[kess] WARN %d: xlsx 아님(size=%d), 건너뜀" % (year, len(r.content)))
            continue
        dest.write_bytes(r.content)
        print("[kess] saved %s (%d bytes) <= %s" % (dest.name, len(r.content), file_name))
        out[year] = dest
    return out


if __name__ == "__main__":
    fetch(force="--force" in sys.argv)
