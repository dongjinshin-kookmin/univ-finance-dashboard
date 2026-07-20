# -*- coding: utf-8 -*-
"""표준데이터 다운로드+정리: 전국대학별 평균등록금 (공공데이터포털 15107738).

한국장학재단 제공 「전국대학별평균등록금정보표준데이터」를 fetch_std_csv.py 와
동일한 무인증 AJAX 경로(/download/columList.json + /download/standard.json)로
직접 호출해 원본 레코드 배열을 받아 캐시한다. 학교명×학위과정별 평균등록금(원)·
평균입학금(원)이 담겨 있다.

주의(연도 커버리지): 이 표준데이터는 공공데이터포털 특성상 "최신 스냅샷 1개 연도"
만 유지된다(현재 기준연도 = CRTR_YR, 2026). 2016~2024 연도별 시계열은 이 무인증
경로로는 제공되지 않으며, 대학별 등록금 변동 추이는 대학알리미 재정현황 오픈API
(data.go.kr 15158680, serviceKey 활용신청·자동승인 필요)의 "등록금 현황 조회"
오퍼레이션으로만 확보 가능하다. 상세는 build/d2_report.md 참조.

산출:
  metadata/raw/tuition_std.json     원본 레코드 배열(전 학위과정 포함)
  build/interim/tuition.csv         canonical,year,avg_tuition,admission_fee,univ_se
      · avg_tuition / admission_fee 단위 = 원(KRW)
      · 학교당 학부 대표 1행(UNIV_SE 우선순위 + 본교 우선)으로 축약
이미 있으면 재다운로드하지 않는다(--force 로 강제).
"""
import csv
import json
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    from etl.config import METADATA_DIR, INTERIM_DIR
    from metadata.match_schools import normalize
except Exception:  # 스크립트 직접 실행 대비
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from etl.config import METADATA_DIR, INTERIM_DIR
    from metadata.match_schools import normalize

import requests

PUBLIC_DATA_PK = "15107738"
DETAIL_URL = "https://www.data.go.kr/data/%s/standard.do" % PUBLIC_DATA_PK
COLS_URL = "https://www.data.go.kr/download/columList.json?pk=%s&ext=CSV" % PUBLIC_DATA_PK
DATA_URL = "https://www.data.go.kr/download/standard.json?publicDataPk=%s" % PUBLIC_DATA_PK
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")

RAW_DIR = METADATA_DIR / "raw"
OUT_JSON = RAW_DIR / "tuition_std.json"
OUT_CSV = INTERIM_DIR / "tuition.csv"

# 학교당 대표 등록금 선정: 학부(대학)를 최우선, 없으면 전문/원격/대학원 순.
SE_PRIORITY = ["대학", "전문대학", "원격대학",
               "일반대학원", "전문대학원", "특수대학원"]
_SE_RANK = {v: i for i, v in enumerate(SE_PRIORITY)}


def fetch(force=False):
    """표준데이터를 내려받아 OUT_JSON 에 저장하고 경로를 반환한다."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if OUT_JSON.exists() and not force:
        print("[tuition] cache hit: %s" % OUT_JSON)
        return OUT_JSON

    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    s.get(DETAIL_URL, timeout=30)  # 세션 쿠키(JSESSIONID) 확보
    xhr = {
        "Referer": DETAIL_URL,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
    }
    header = s.get(COLS_URL, headers=xhr, timeout=30).json()
    tv = header["tableVO"]
    total = header["totalCount"]
    per_page = 10000
    param = {
        "colNmList": tv["colNmList"],
        "totalCount": total,
        "svcTableNm": tv["svcTableNm"],
        "perPage": per_page,
        "page": 1,
    }
    pages = max(1, -(-total // per_page))
    records = []
    for p in range(1, pages + 1):
        param["page"] = p
        r = s.get(DATA_URL, params=param, headers=xhr, timeout=180)
        r.raise_for_status()
        chunk = r.json()
        if not isinstance(chunk, list):
            raise RuntimeError("표준데이터 응답이 배열이 아님(세션/차단 의심): %s"
                               % str(chunk)[:200])
        records.extend(chunk)

    if len(records) < total * 0.9:
        raise RuntimeError("표준데이터 레코드 수 부족: %d / %d" % (len(records), total))

    OUT_JSON.write_text(json.dumps(records, ensure_ascii=False), encoding="utf-8")
    print("[tuition] saved %d records -> %s" % (len(records), OUT_JSON))
    return OUT_JSON


def _to_won(v):
    """문자열 금액을 정수 원으로. 빈값/0 → None(입학금 폐지 등)."""
    try:
        f = float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return int(round(f)) if f > 0 else None


def _pick(rows):
    """학교당 대표 1행: UNIV_SE 우선순위 → 본교 우선."""
    return sorted(rows, key=lambda r: (
        _SE_RANK.get(r.get("UNIV_SE_NM"), 99),
        0 if r.get("MAINBRANCH_NM") == "본교" else 1,
    ))[0]


def build_csv(force=False):
    """OUT_JSON → build/interim/tuition.csv (학교당 대표 등록금 1행)."""
    path = fetch(force=force)
    records = json.loads(path.read_text(encoding="utf-8"))

    by_canon = {}
    for x in records:
        name = str(x.get("UNIV_NM", "")).strip()
        if not name:
            continue
        canonical, _alias = normalize(name)
        by_canon.setdefault(canonical, []).append(x)

    rows = []
    for canonical in sorted(by_canon):
        rec = _pick(by_canon[canonical])
        year = str(rec.get("CRTR_YR", "")).strip()
        rows.append({
            "canonical": canonical,
            "year": year,
            "avg_tuition": _to_won(rec.get("AVG_REG_AMT")),
            "admission_fee": _to_won(rec.get("AVG_MTCLTN_AMT")),
            "univ_se": rec.get("UNIV_SE_NM", ""),
        })

    INTERIM_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_CSV.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=[
            "canonical", "year", "avg_tuition", "admission_fee", "univ_se"])
        w.writeheader()
        w.writerows(rows)
    years = sorted({r["year"] for r in rows})
    print("[tuition] wrote %d schools -> %s (연도: %s, 단위=원)"
          % (len(rows), OUT_CSV, ",".join(years)))
    return OUT_CSV


if __name__ == "__main__":
    build_csv(force="--force" in sys.argv)
