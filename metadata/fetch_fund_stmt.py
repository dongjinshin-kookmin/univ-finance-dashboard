# -*- coding: utf-8 -*-
"""교비회계 **자금계산서 결산**(관 단위 금액)을 대학재정알리미(uniarlimi)에서 수집.

대학재정알리미 통합공시 예·결산(결산) 화면 `/totalAnno/univFinance/accounts` 을
역설계한다. 브라우저는 ClipReport4(OOF report) 뷰어로 렌더링하지만, 실제 데이터는
아래 XHR JSON 엔드포인트에서 나온다(무로그인):

  · POST /totalAnno/univFinance/accounts/searchYear
        {acntDiv, selectGubun} → 공시된 회계연도 리스트(결산 자금계산서 가용성 판정)
  · POST /totalAnno/univFinance/accounts/searchSchool
        {levelGubun,gradeDiv,putYear,acntDiv,schNm,selectGubun} → 학교 로스터
  · POST /totalAnno/univFinance/accounts/searchDetail   ← **핵심**
        state=detail, gradeDiv=ALL 로 호출하면 **전 학교의 관(館) 단위 트리**를
        한 번에 반환(5개교씩 페이지네이션된 report 행렬). schoolList 파라미터는 무시됨.

수집 단위: **관(館) 레벨이 최대**(levelGubun 옵션이 '관'(20)뿐). 항·목은 이 UI로
노출되지 않는다. 자금계산서 수입(acntGubun=I) 13개 관, 지출(E) 14개 관.

산출(요청 시): build/interim/<prefix>_in.csv, <prefix>_ex.csv (utf-8-sig)
  헤더: canonical, account_code, amount   (금액 단위: 천원, 정수)

멱등: 원천 report JSON 은 metadata/raw/fund_stmt_<year>_<I|E>.json 에 캐시(존재 시 스킵,
--force 로 강제 재수집). 요청 간 딜레이(기본 0.7s)로 서버 부하 배려.

회계연도 표기: uniarlimi 결산 'YYYY' == 우리 tidy 의 'YYYY'(FY). 국민대 FY2024
자금수입총계 259,950,026(천원)이 기존 tidy 2024 T_IN 과 완전일치함으로 실증됨.
"""
import csv
import json
import sys
import time
import warnings

warnings.filterwarnings("ignore")

try:
    from etl.config import METADATA_DIR, INTERIM_DIR
except Exception:  # 스크립트 직접 실행 대비
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from etl.config import METADATA_DIR, INTERIM_DIR

import requests

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")
RAW_DIR = METADATA_DIR / "raw"
ACCOUNTS_JSON = INTERIM_DIR / "accounts.json"

UNI = "https://uniarlimi.kasfo.or.kr"
REF = UNI + "/totalAnno/univFinance/accounts"
EP_YEAR = REF + "/searchYear"
EP_SCHOOL = REF + "/searchSchool"
EP_DETAIL = REF + "/searchDetail"

ACNT_DIV = "10"          # 교비회계
SELECT_GUBUN = "자금"     # 자금계산서(결산)
SIDE_CODE = {"in": "I", "ex": "E"}   # acntGubun: 수입 I / 지출 E
DELAY = 0.7


# ── canonical 정규화 (match_schools.py 계약과 동일 정규식 복제) ──────────
import re
_PAREN_RE = re.compile(r"^(.*?)\((?:구[.．]?)?\s*(.*?)\)$")


def canonicalize(name):
    s = (name or "").strip().replace("（", "(").replace("）", ")")
    m = _PAREN_RE.match(s)
    if m:
        return m.group(1).strip()
    return s


# ── uniarlimi 관 계정과목명 → accounts.json 코드 매핑(측면별 lv<=1, 선두 우선) ──
def load_name2code():
    d = json.loads(ACCOUNTS_JSON.read_text(encoding="utf-8"))
    m = {"in": {}, "ex": {}}
    for side in ("in", "ex"):
        for a in d[side]:
            if a["lv"] <= 1 and a["name"] not in m[side]:
                m[side][a["name"]] = a["code"]
    return m


# ── 세션 ────────────────────────────────────────────────────────────────
def _session():
    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    s.get(REF, timeout=30, verify=False)   # 쿠키 획득
    return s


def _xhr():
    return {"Referer": REF, "X-Requested-With": "XMLHttpRequest"}


# ── 0단계: 가용성(공시된 결산 회계연도) ─────────────────────────────────
def available_years(s=None):
    s = s or _session()
    r = s.post(EP_YEAR, data={"acntDiv": ACNT_DIV, "selectGubun": SELECT_GUBUN},
               headers=_xhr(), timeout=60, verify=False)
    return sorted(int(y) for y in r.json())


def roster(year, s=None):
    """해당 연도 결산 자금계산서를 제출한 학교(캠퍼스) 로스터."""
    s = s or _session()
    r = s.post(EP_SCHOOL, data={"levelGubun": "20", "gradeDiv": "ALL",
                                "putYear": str(year), "acntDiv": ACNT_DIV,
                                "schNm": "", "selectGubun": SELECT_GUBUN},
               headers=_xhr(), timeout=60, verify=False)
    return r.json().get("schoolList", [])


# ── searchDetail: 전 학교 관 단위 report(캐시) ──────────────────────────
def fetch_detail(year, side, s=None, force=False):
    """gradeDiv=ALL 로 전 학교 관 단위 report 행렬을 반환(캐시)."""
    out = RAW_DIR / ("fund_stmt_%d_%s.json" % (year, SIDE_CODE[side]))
    if out.exists() and not force:
        return json.loads(out.read_text(encoding="utf-8"))
    s = s or _session()
    data = {"state": "detail", "schCd": "", "schNm": "", "acntDiv": ACNT_DIV,
            "putYear": str(year), "selectGubun": SELECT_GUBUN,
            "acntGubun": SIDE_CODE[side], "levelGubun": "20",
            "searchKind": "school", "gradeDiv": "ALL", "data": "json"}
    r = s.post(EP_DETAIL, data=data, headers=_xhr(), timeout=120, verify=False)
    rep = r.json().get("report", [])
    if not rep:
        raise RuntimeError("[fund %d %s] 빈 report(엔드포인트/파라미터 변경 의심)"
                           % (year, side))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rep, ensure_ascii=False), encoding="utf-8")
    print("[fund %d %s] saved %d report rows -> %s"
          % (year, side, len(rep), out.name))
    time.sleep(DELAY)
    return rep


def parse_detail(report):
    """report 행렬 → {canonical: {계정과목명: 금액(int, 천원)}}. 동일 canonical 합산.

    report 행: [page, 라벨(들여쓰기로 계층), col2..col6=최대 5개교 값].
    '항목' 라벨 행이 그 페이지의 학교명(2~6열)을 정의한다."""
    out = {}
    cols = []
    for row in report:
        label = (row[1] if len(row) > 1 else "").strip()
        if not label:
            continue
        if label == "항목":
            names = [c for c in row[2:] if c not in ("", None)]
            cols = [canonicalize(n) for n in names]
            for c in cols:
                out.setdefault(c, {})
            continue
        vals = row[2:2 + len(cols)]
        for canon, v in zip(cols, vals):
            try:
                amt = int(v)
            except Exception:
                amt = 0
            # 동일 계정명 재등장(관 소계 == 하위 단일 항: 미사용이월 등)은 덮어쓰기(동일값)
            out[canon][label.strip()] = amt
    return out


# ── 빌드: 측면별 CSV ────────────────────────────────────────────────────
FIELDS = ["canonical", "account_code", "amount"]


def build_side(year, side, prefix, name2code, s=None, force=False):
    rep = fetch_detail(year, side, s=s, force=force)
    parsed = parse_detail(rep)
    mp = name2code[side]
    rows, unmapped = [], set()
    for canon in sorted(parsed):
        for acnt_nm, amt in parsed[canon].items():
            code = mp.get(acnt_nm.strip())
            if code is None:
                unmapped.add(acnt_nm.strip())
                continue
            rows.append({"canonical": canon, "account_code": code,
                         "amount": amt})
    out = INTERIM_DIR / ("%s_%s.csv" % (prefix, side))
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    print("[%s_%s] %d rows, %d schools -> %s"
          % (prefix, side, len(rows), len(parsed), out.name))
    if unmapped:
        print("  [warn] 매핑 실패 계정과목: %s" % sorted(unmapped))
    return rows, parsed, unmapped


def build(year, prefix, force=False):
    """year 자금계산서 결산을 수집해 <prefix>_in.csv / <prefix>_ex.csv 생성."""
    INTERIM_DIR.mkdir(parents=True, exist_ok=True)
    n2c = load_name2code()
    s = _session()
    result = {}
    for side in ("in", "ex"):
        result[side] = build_side(year, side, prefix, n2c, s=s, force=force)
    return result


# ── CLI ─────────────────────────────────────────────────────────────────
def _usage():
    print("usage:\n"
          "  python fetch_fund_stmt.py --years            # 공시된 결산 회계연도 조회\n"
          "  python fetch_fund_stmt.py --year 2024 --prefix fund_2024_recollect [--force]\n")


if __name__ == "__main__":
    args = sys.argv[1:]
    force = "--force" in args
    if "--years" in args or not args:
        s = _session()
        ys = available_years(s)
        print("공시된 결산(자금계산서·교비회계) 회계연도:", ys)
        print("최신:", max(ys))
        if not args:
            _usage()
    if "--year" in args:
        year = int(args[args.index("--year") + 1])
        prefix = "fund_%d_recollect" % year
        if "--prefix" in args:
            prefix = args[args.index("--prefix") + 1]
        build(year, prefix, force=force)
