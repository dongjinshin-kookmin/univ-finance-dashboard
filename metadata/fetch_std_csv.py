# -*- coding: utf-8 -*-
"""표준데이터 다운로드: 전국대학및전문대학정보표준데이터 (공공데이터포털 15107736).

공식 CSV 버튼은 브라우저에서 /download/columList.json + /download/standard.json 을
AJAX 로 받아 클라이언트에서 CSV 를 조립한다. 여기서는 동일 엔드포인트를 세션
쿠키·XHR 헤더와 함께 직접 호출해 원본 JSON(레코드 배열)을 받아 캐시한다.

산출: metadata/raw/std_univ.json  (레코드 배열)
      → 학교명·본분교·대학구분·학교구분·설립형태·시도명·주소 포함
이미 있으면 재다운로드하지 않는다(--force 로 강제).
"""
import json
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    from etl.config import METADATA_DIR
except Exception:  # 스크립트 직접 실행 대비
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from etl.config import METADATA_DIR

import requests

PUBLIC_DATA_PK = "15107736"
DETAIL_URL = "https://www.data.go.kr/data/%s/standard.do" % PUBLIC_DATA_PK
COLS_URL = "https://www.data.go.kr/download/columList.json?pk=%s&ext=CSV" % PUBLIC_DATA_PK
DATA_URL = "https://www.data.go.kr/download/standard.json?publicDataPk=%s" % PUBLIC_DATA_PK
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")

RAW_DIR = METADATA_DIR / "raw"
OUT_JSON = RAW_DIR / "std_univ.json"
OUT_COLS = RAW_DIR / "std_univ_columns.json"


def fetch(force=False):
    """표준데이터를 내려받아 OUT_JSON 에 저장하고 경로를 반환한다."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if OUT_JSON.exists() and not force:
        print("[std] cache hit: %s" % OUT_JSON)
        return OUT_JSON

    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    # 세션 쿠키 확보 (JSESSIONID 등)
    s.get(DETAIL_URL, timeout=30)
    xhr = {
        "Referer": DETAIL_URL,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
    }
    header = s.get(COLS_URL, headers=xhr, timeout=30).json()
    tv = header["tableVO"]
    columns = [(c["columCode"], c["columNm"]) for c in header["columList"]]

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
            raise RuntimeError("표준데이터 응답이 배열이 아님(세션/차단 의심): %s" % str(chunk)[:200])
        records.extend(chunk)

    if len(records) < total * 0.9:
        raise RuntimeError("표준데이터 레코드 수 부족: %d / %d" % (len(records), total))

    OUT_JSON.write_text(json.dumps(records, ensure_ascii=False), encoding="utf-8")
    OUT_COLS.write_text(json.dumps(columns, ensure_ascii=False, indent=2), encoding="utf-8")
    print("[std] saved %d records -> %s" % (len(records), OUT_JSON))
    return OUT_JSON


if __name__ == "__main__":
    fetch(force="--force" in sys.argv)
