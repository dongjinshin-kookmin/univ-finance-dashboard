# -*- coding: utf-8 -*-
"""시도별 학령인구 실적(주민등록인구) 수집 — 백테스트용 과거 시계열.

소스: KOSIS 통계표 DT_1B04006
      "행정구역(시군구)별/1세별 주민등록인구" (orgId=101, 행정안전부 주민등록인구현황)
      기준시점: 매년 12월 31일 주민등록인구.

fetch_population.py 와 동일한 무인증 CSV 다운로드 경로(statHtmlContent → downGrid
→ downNormal) 를 재사용한다. 다만 이 표의 분류변수 구조가 달라 축 구성을 바꿨다:
  objVar A          = 행정구역(시도)   → OV_L1_ID
  objVar YRE        = 연령(1세별)      → OV_L2_ID
  objVar 13999001   = 인구종류(항목)   → ITM_ID (T2 총인구수 사용)

장래추계표(DT_1BPB003)는 학령인구 연령계층(6~21, 18~21)만 제공하고 2016~2021
실적이 없어, 여기서는 1세별 실적을 직접 합산해 동일 연령계층을 재구성한다:
  18세                          → age_group='18세'            (단일연령)
  18+19+20+21세                 → age_group='대학학령(18-21세)'
  6~21세 합                     → age_group='학령인구(6-21세)'
값 단위는 명(원자료 그대로).

산출:
  metadata/raw/kosis_pop_actual.csv     (원본 CSV 캐시, 탭구분)
  build/interim/population_actual.csv
    sido, year, age_group, population

멱등: raw 캐시가 있으면 재다운로드하지 않는다(--force 로 강제).
"""
import csv
import json
import re
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    from etl.config import INTERIM_DIR, METADATA_DIR
except Exception:  # 스크립트 직접 실행 대비
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from etl.config import INTERIM_DIR, METADATA_DIR

import requests

RAW_DIR = METADATA_DIR / "raw"
RAW_CSV = RAW_DIR / "kosis_pop_actual.csv"
OUT_CSV = INTERIM_DIR / "population_actual.csv"

ORG_ID = "101"
TBL_ID = "DT_1B04006"
CONN = "I2"
REF_URL = ("https://kosis.kr/statHtml/statHtml.do?orgId=%s&tblId=%s&conn_path=%s"
           % (ORG_ID, TBL_ID, CONN))

ITEM = "T2"  # 인구종류: 총인구수(남+여)
YEAR_START, YEAR_END = 2016, 2024

# 시도코드(A) → 기존 population_projection.csv 와 동일한 시도 명칭.
# (표는 '강원특별자치도'·'전북특별자치도' 로 표기하나 기존 파일 명칭에 맞춘다.)
SIDO_CODE_NAME = {
    "11": "서울특별시", "26": "부산광역시", "27": "대구광역시", "28": "인천광역시",
    "29": "광주광역시", "30": "대전광역시", "31": "울산광역시", "36": "세종특별자치시",
    "41": "경기도", "51": "강원도", "43": "충청북도", "44": "충청남도",
    "52": "전라북도", "46": "전라남도", "47": "경상북도", "48": "경상남도",
    "50": "제주특별자치도",
}
# 표의 표기명(현행 명칭 포함) → 기존 파일 명칭. 파싱 시 행의 시도명을 정규화한다.
SIDO_DISPLAY_NORM = {
    "강원특별자치도": "강원도", "강원도": "강원도",
    "전북특별자치도": "전라북도", "전라북도": "전라북도",
}

# 연령(YRE) 코드 6~21세.
AGE_CODES = {
    "0502": 6, "0503": 7, "0504": 8, "0505": 9,
    "0701": 10, "0702": 11, "0703": 12, "0704": 13, "0705": 14,
    "1001": 15, "1002": 16, "1003": 17, "1004": 18, "1005": 19,
    "1201": 20, "1202": 21,
}
SCHOOL_AGES = list(range(6, 22))       # 학령인구(6-21세)
UNIV_AGES = [18, 19, 20, 21]           # 대학학령(18-21세)

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")


def _param_info(shell):
    """셸의 #ParamInfo 폼 → {name: value} (기본 히든값 포함)."""
    i = shell.find('id="ParamInfo"')
    end = shell.find("</form>", i)
    seg = shell[i:end]
    params = {}
    for tag in re.findall(r"<(?:input|textarea|select)\b[^>]*>", seg):
        nm = re.search(r'\bname="([^"]*)"', tag)
        if not nm:
            continue
        val = re.search(r'\bvalue="([^"]*)"', tag)
        params.setdefault(nm.group(1), val.group(1) if val else "")
    return params


def download(force=False):
    """KOSIS CSV(탭구분) 원본을 받아 RAW_CSV 에 캐시하고 경로를 반환한다."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if RAW_CSV.exists() and not force:
        print("[pop-actual] cache hit: %s" % RAW_CSV.name)
        return RAW_CSV

    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    s.get(REF_URL, timeout=30, verify=False)
    shell = s.post(
        "https://kosis.kr/statHtml/statHtmlContent.do",
        data={"orgId": ORG_ID, "tblId": TBL_ID, "conn_path": CONN},
        headers={"X-Requested-With": "XMLHttpRequest", "Referer": REF_URL},
        timeout=40, verify=False,
    ).text

    params = _param_info(shell)
    if not params.get("orgId"):
        params.update({"orgId": ORG_ID, "tblId": TBL_ID})

    years = [str(y) for y in range(YEAR_START, YEAR_END + 1)]
    mk = [
        {"targetId": "PRD", "targetValue": "", "prdValue": "Y," + ",".join(years) + ",@"},
        {"targetId": "ITM_ID", "targetValue": ITEM, "prdValue": ""},
    ]
    for c in SIDO_CODE_NAME:
        mk.append({"targetId": "OV_L1_ID", "targetValue": c, "prdValue": ""})
    for c in AGE_CODES:
        mk.append({"targetId": "OV_L2_ID", "targetValue": c, "prdValue": ""})

    params.update({
        "fieldList": json.dumps(mk, ensure_ascii=False),
        "rowAxis": "A,YRE", "colAxis": "TIME",
        "downGridFileType": "csv", "downGridCsvType": "utf8",
        "downGridCsv": "Y", "downGridMeta": "N", "downSort": "asc",
    })
    hd = {"Referer": REF_URL}
    grid = s.post("https://kosis.kr/statHtml/downGrid.do", data=params,
                  headers=hd, timeout=120, verify=False).json()
    token = grid.get("file")
    if not token:
        raise RuntimeError("KOSIS downGrid.do 파일토큰 없음: %s" % str(grid)[:200])
    params["file"] = token
    r = s.post("https://kosis.kr/statHtml/downNormal.do", data=params,
               headers=hd, timeout=120, verify=False)
    r.raise_for_status()
    if len(r.content) < 500:
        raise RuntimeError("KOSIS downNormal.do 응답이 비정상적으로 작음(%d bytes)"
                           % len(r.content))
    RAW_CSV.write_bytes(r.content)
    print("[pop-actual] saved %s (%d bytes)" % (RAW_CSV.name, len(r.content)))
    return RAW_CSV


def _decode(path):
    raw = path.read_bytes()
    for enc in ("cp949", "utf-8-sig", "euc-kr", "utf-8"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("cp949", "ignore")


def parse(path):
    """탭구분 원본 → {(sido, year): {age: population}}."""
    txt = _decode(path)
    lines = [ln for ln in txt.splitlines() if ln.strip()]
    rows = [[c.strip().strip('"') for c in ln.split("\t")] for ln in lines]
    hdr_year = rows[0]
    hdr_kind = rows[1]
    # '원데이터' 열만 채택하고 열 → 연도 매핑.
    year_of = {}
    for ci in range(2, len(hdr_year)):
        if ci < len(hdr_kind) and hdr_kind[ci] == "원데이터":
            m = re.search(r"(20\d\d)", hdr_year[ci])
            if m:
                year_of[ci] = int(m.group(1))

    table = {}  # (sido, year) -> {age: pop}
    for r in rows[2:]:
        if len(r) < 3:
            continue
        raw_sido = r[0].strip()
        sido = SIDO_DISPLAY_NORM.get(raw_sido, raw_sido)
        am = re.match(r"(\d+)\s*세", r[1].strip())
        if not am:
            continue
        age = int(am.group(1))
        if age not in SCHOOL_AGES:
            continue
        for ci, year in year_of.items():
            if ci >= len(r):
                continue
            v = r[ci].replace(",", "").strip()
            if v in ("", "-", "X"):
                continue
            try:
                pop = int(round(float(v)))
            except ValueError:
                continue
            table.setdefault((sido, year), {})[age] = pop
    return table


def build_records(table):
    """(sido, year)별 연령 딕셔너리 → long 레코드(18세 / 대학학령 / 학령인구)."""
    records = []
    for (sido, year), ages in table.items():
        if 18 in ages:
            records.append({"sido": sido, "year": year,
                            "age_group": "18세", "population": ages[18]})
        if all(a in ages for a in UNIV_AGES):
            records.append({"sido": sido, "year": year,
                            "age_group": "대학학령(18-21세)",
                            "population": sum(ages[a] for a in UNIV_AGES)})
        if all(a in ages for a in SCHOOL_AGES):
            records.append({"sido": sido, "year": year,
                            "age_group": "학령인구(6-21세)",
                            "population": sum(ages[a] for a in SCHOOL_AGES)})
    return records


def main(force=False):
    INTERIM_DIR.mkdir(parents=True, exist_ok=True)
    path = download(force=force)
    table = parse(path)
    records = build_records(table)
    records.sort(key=lambda d: (d["age_group"], d["sido"], d["year"]))
    with OUT_CSV.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=[
            "sido", "year", "age_group", "population"])
        w.writeheader()
        w.writerows(records)
    sidos = sorted({d["sido"] for d in records})
    years = sorted({d["year"] for d in records})
    print("[pop-actual] population_actual.csv: %d행 / %d개 시도 / 연도 %d~%d"
          % (len(records), len(sidos),
             min(years) if years else 0, max(years) if years else 0))


if __name__ == "__main__":
    main(force="--force" in sys.argv)
