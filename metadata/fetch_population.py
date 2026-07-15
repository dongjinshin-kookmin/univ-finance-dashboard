# -*- coding: utf-8 -*-
"""시도별 학령인구 장래추계 수집 (KOSIS 장래인구추계 시도편, 무인증).

소스: KOSIS 통계표 DT_1BPB003
      "주요 연령계층별 추계인구(생산연령인구, 고령인구, 학령인구 등)/시도"
      (orgId=101, 장래인구추계 시도편 2022~2052, 2022 기준)

KOSIS 오픈API 는 인증키가 필요하므로, 웹뷰어가 쓰는 무인증 CSV 다운로드 경로를
역설계했다:
  ① statHtmlContent.do 로 통계표 셸을 받아 분류코드(시나리오 AA / 시도 SGG /
     인구종류 E) 를 파싱
  ② ParamInfo 폼 + fieldList(선택) + rowAxis="AA,SGG,E" / colAxis="TIME" 구성
  ③ downGrid.do → 서버가 .table 임시파일 생성, 파일토큰 반환
  ④ downNormal.do (file=토큰) → 실제 CSV(탭구분) 스트림

18세 단일연령은 이 표에 없어(1세별은 DT_1BPB001) 학령인구 연령계층으로 대체 수집:
  E=23 학령인구 계(6~21세)   → age_group='학령인구(6-21세)'
  E=27 학령인구 대학교(18~21세) → age_group='대학학령(18-21세)'  ← 18세에 가장 근접
값 단위는 원자료 '천명' → 명(×1000) 으로 환산해 저장.

is_projection: 2022 기준연도는 0, 2023 이상 추계구간은 1.
(이 표는 2022~2052 만 제공하며 2016~2021 실적 시계열은 없음 — 리포트 명시.)

산출:
  metadata/raw/kosis_pop_projection.csv        (원본 CSV 캐시)
  build/interim/population_projection.csv
    sido, year, age_group, population, is_projection

멱등: raw 캐시가 있으면 재다운로드하지 않는다(--force 로 강제).
"""
import csv
import io
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
RAW_CSV = RAW_DIR / "kosis_pop_projection.csv"
OUT_CSV = INTERIM_DIR / "population_projection.csv"

ORG_ID = "101"
TBL_ID = "DT_1BPB003"
CONN = "I2"
REF_URL = ("https://kosis.kr/statHtml/statHtml.do?orgId=%s&tblId=%s&conn_path=%s"
           % (ORG_ID, TBL_ID, CONN))

SCENARIO = "1"  # AA: 중위 추계
# E(인구종류) 코드 → age_group 라벨
AGE_ITEMS = {"23": "학령인구(6-21세)", "27": "대학학령(18-21세)"}
YEAR_START, YEAR_END = 2022, 2052
BASE_YEAR = 2022  # 이하 실적/기준, 초과는 추계

# 17개 시도 코드(00 전국 제외). 셸 파싱 실패 시 폴백.
SIDO_FALLBACK = {
    "11": "서울특별시", "21": "부산광역시", "22": "대구광역시", "23": "인천광역시",
    "24": "광주광역시", "25": "대전광역시", "26": "울산광역시", "29": "세종특별자치시",
    "31": "경기도", "32": "강원도", "33": "충청북도", "34": "충청남도",
    "35": "전라북도", "36": "전라남도", "37": "경상북도", "38": "경상남도",
    "39": "제주특별자치도",
}

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")


def _extract_codes(shell):
    """statHtmlContent 셸에서 objVarId 별 {itmId: 이름} 을 파싱한다."""
    codes = {"AA": {}, "SGG": {}, "E": {}}
    for m in re.finditer(
            r'\{"lvl":\d+,"orgId":"%s","tblId":"%s"[^{}]*?\}' % (ORG_ID, TBL_ID),
            shell):
        o = m.group(0)
        vid = re.search(r'"objVarId":"([^"]*)"', o)
        itm = re.search(r'"itmId":"([^"]*)"', o)
        nm = re.search(r'"scrKor":"([^"]*)"', o)
        if vid and itm and nm and vid.group(1) in codes:
            codes[vid.group(1)][itm.group(1)] = nm.group(1)
    return codes


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
        print("[pop] cache hit: %s" % RAW_CSV.name)
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

    codes = _extract_codes(shell)
    sido = codes["SGG"]
    sido = {k: v for k, v in sido.items() if k != "00"} or SIDO_FALLBACK
    params = _param_info(shell)
    if not params.get("orgId"):
        params.update({"orgId": ORG_ID, "tblId": TBL_ID})

    years = [str(y) for y in range(YEAR_START, YEAR_END + 1)]
    mk = [
        {"targetId": "PRD", "targetValue": "", "prdValue": "Y," + ",".join(years) + ",@"},
        {"targetId": "ITM_ID", "targetValue": "T10", "prdValue": ""},
        {"targetId": "OV_L1_ID", "targetValue": SCENARIO, "prdValue": ""},
    ]
    for c in sido:
        mk.append({"targetId": "OV_L2_ID", "targetValue": c, "prdValue": ""})
    for c in AGE_ITEMS:
        mk.append({"targetId": "OV_L3_ID", "targetValue": c, "prdValue": ""})

    params.update({
        "fieldList": json.dumps(mk, ensure_ascii=False),
        "rowAxis": "AA,SGG,E", "colAxis": "TIME",
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
    print("[pop] saved %s (%d bytes)" % (RAW_CSV.name, len(r.content)))
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
    """탭구분 원본 → long 레코드 리스트."""
    txt = _decode(path)
    # 각 줄이 탭구분. csv.reader(comma) 로 감싸지 말고 직접 split.
    lines = [ln for ln in txt.splitlines() if ln.strip()]
    rows = [[c.strip().strip('"') for c in ln.split("\t")] for ln in lines]
    # 헤더 2줄: [분류3칸 + 연도...] / [분류3칸 + 원데이터/가중치...]
    hdr_year = rows[0]
    hdr_kind = rows[1]
    # 데이터 열: '원데이터' 인 열만 채택
    year_of = {}
    for ci in range(3, len(hdr_year)):
        if ci < len(hdr_kind) and hdr_kind[ci] == "원데이터":
            m = re.search(r"(20\d\d)", hdr_year[ci])
            if m:
                year_of[ci] = int(m.group(1))

    out = []
    for r in rows[2:]:
        if len(r) < 3:
            continue
        sido = r[1].strip()
        kind = r[2].strip()
        age_group = None
        # 인구종류 문자열로 age_group 판정
        if "계(6~21세)" in kind:
            age_group = AGE_ITEMS["23"]
        elif "18~21세" in kind:
            age_group = AGE_ITEMS["27"]
        else:
            continue
        for ci, year in year_of.items():
            if ci >= len(r):
                continue
            v = r[ci].replace(",", "").strip()
            if v in ("", "-", "X"):
                continue
            try:
                thousands = float(v)
            except ValueError:
                continue
            population = int(round(thousands * 1000))
            out.append({
                "sido": sido, "year": year, "age_group": age_group,
                "population": population,
                "is_projection": 0 if year <= BASE_YEAR else 1,
            })
    return out


def main(force=False):
    INTERIM_DIR.mkdir(parents=True, exist_ok=True)
    path = download(force=force)
    records = parse(path)
    records.sort(key=lambda d: (d["age_group"], d["sido"], d["year"]))
    with OUT_CSV.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=[
            "sido", "year", "age_group", "population", "is_projection"])
        w.writeheader()
        w.writerows(records)
    sidos = sorted({d["sido"] for d in records})
    print("[pop] population_projection.csv: %d행 / %d개 시도 / 연도 %d~%d"
          % (len(records), len(sidos),
             min(d["year"] for d in records) if records else 0,
             max(d["year"] for d in records) if records else 0))


if __name__ == "__main__":
    main(force="--force" in sys.argv)
