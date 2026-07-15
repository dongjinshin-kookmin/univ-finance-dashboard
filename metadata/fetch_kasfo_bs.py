# -*- coding: utf-8 -*-
"""교비회계 재무상태표(적립금·부채·기본금 잔액) 수집 → build/interim/balance_sheet.csv.

두 개의 무로그인 소스를 결합한다(둘 다 XHR/JSON 역설계로 실증됨):

1) 공공데이터포털 15135513 "사립대학 교비회계 재무상태표" CSV (최신 스냅샷=FY2024)
   - 3단계 다운로드: 상세페이지 → selectFileDataDownload.do(JSON) → fileDownload.do(CSV)
   - 학교 단위(캠퍼스 합산 완료, 중복 학교명 없음). 재무상태표 전 항목 제공 →
     원금보존적립금/임의적립금/유동자산/유동·고정부채/기본금을 모두 확보.

2) 대학재정알리미 적립금 통계 /statistics/univFinance/accum/search (OOF report JSON)
   - putYear 2012~2024 연도별, 학교(캠퍼스)별 행. c1~c6 = 적립금(원금보존+임의) 기말잔액을
     연구/건축/장학/퇴직/특정목적/합 으로 제공(cross-check: c6 == datago 원금보존적립금+임의적립금).
     a=당기적립액, b=당기사용액. → 여기서는 c6(기말잔액 총액)만 reserve_total 로 취득해
     2016~2024 다년치 시계열을 만든다(원금보존/임의 분할은 accum 에 없음 → 결측 허용).

산출: build/interim/balance_sheet.csv (utf-8-sig)
  canonical, year, reserve_principal, reserve_discretionary, reserve_total,
  current_assets, total_liabilities, fund_basic   (금액 단위: 천원, 결측 허용)
  - year=2024: 6개 값 필드 모두(datago) / year<=2023: reserve_total 만(accum)

재실행 멱등: 원천 다운로드는 metadata/raw/ 에 캐시(--force 로 강제 재수집).
"""
import csv
import json
import re
import sys
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

# ── 소스 1: 공공데이터포털 fileData ─────────────────────────────────────
DATAGO = "https://www.data.go.kr"
BS_PK = "15135513"          # 사립대학 교비회계 재무상태표
BS_RAW = RAW_DIR / "kasfo_bs_datago.csv"

# ── 소스 2: 대학재정알리미 적립금 통계 ──────────────────────────────────
UNI = "https://uniarlimi.kasfo.or.kr"
ACCUM_REF = UNI + "/statistics/univFinance/accum"
ACCUM_SEARCH = ACCUM_REF + "/search"
ACCUM_YEARS = list(range(2016, 2025))   # 최소 최근 3개년 목표 → 2016~2024 확보 시도

OUT_CSV = INTERIM_DIR / "balance_sheet.csv"

# ── canonical 정규화 (match_schools.py 상단 계약과 동일하게 복제) ────────
_PAREN_RE = re.compile(r"^(.*?)\((?:구[.．]?)?\s*(.*?)\)$")


def canonicalize(name):
    """양끝 공백 제거 → 전각()→半角 → 괄호 앞 학교명(그룹1). 15112170의
    '학교명(법인명)' 형태도 법인명 괄호가 제거되어 학교명만 남는다."""
    s = (name or "").strip().replace("（", "(").replace("）", ")")
    m = _PAREN_RE.match(s)
    if m:
        return m.group(1).strip()
    return s


# ── 공공데이터포털 fileData 3단계 다운로더 (재사용: fetch_closed.py 가 import) ──
def download_datago_file(pk, out_path, force=False):
    """공공데이터포털 fileData(pk)의 대표 첨부파일을 내려받아 out_path(bytes)로 저장.

    상세페이지의 fn_fileDataDown(...) 인자에서 publicDataDetailPk/fileDetailSn 를
    동적으로 추출하므로 재공시(uddi 변경)에도 견딤."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists() and not force:
        print("[datago %s] cache hit: %s" % (pk, out_path.name))
        return out_path

    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    detail = "%s/data/%s/fileData.do" % (DATAGO, pk)
    html = s.get(detail, timeout=30, verify=False).text
    m = re.search(
        r"fn_fileDataDown\('%s',\s*'([^']+)',\s*'[^']*',\s*'(\d+)'" % pk, html)
    if not m:
        raise RuntimeError("[datago %s] fn_fileDataDown 인자 파싱 실패(페이지 구조 변경?)" % pk)
    detail_pk, file_sn = m.group(1), m.group(2)

    xhr = {"Referer": detail, "X-Requested-With": "XMLHttpRequest"}
    meta = s.post("%s/tcs/dss/selectFileDataDownload.do" % DATAGO,
                  data={"publicDataPk": pk, "publicDataDetailPk": detail_pk,
                        "atchFileId": "", "fileDetailSn": file_sn},
                  headers=xhr, timeout=30, verify=False).json()
    if not meta.get("status"):
        raise RuntimeError("[datago %s] selectFileDataDownload status=false" % pk)
    aid = meta["atchFileId"]
    sn = meta["fileDetailSn"]
    nm = meta["dataSetFileDetailInfo"]["dataNm"]
    from urllib.parse import quote
    url = ("%s/cmm/cmm/fileDownload.do?atchFileId=%s&fileDetailSn=%s&dataNm=%s"
           % (DATAGO, aid, sn, quote(nm)))
    r = s.get(url, headers={"Referer": detail}, timeout=180, verify=False)
    r.raise_for_status()
    if len(r.content) < 500:
        raise RuntimeError("[datago %s] 다운로드 크기 이상(%d B)" % (pk, len(r.content)))
    out_path.write_bytes(r.content)
    print("[datago %s] saved %d bytes -> %s (%s)"
          % (pk, len(r.content), out_path.name, nm))
    return out_path


def _decode(raw):
    for enc in ("utf-8-sig", "cp949", "euc-kr", "utf-8"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("utf-8", "replace")


# ── 소스 2 다운로드: accum 연도별 JSON 캐시 ─────────────────────────────
def fetch_accum(year, force=False):
    out = RAW_DIR / ("uni_accum_%d.json" % year)
    if out.exists() and not force:
        return json.loads(out.read_text(encoding="utf-8"))
    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    s.get(ACCUM_REF, timeout=25, verify=False)
    r = s.post(ACCUM_SEARCH,
               data={"putYear": str(year), "schDiv": "10", "gradeDiv": "ALL",
                     "schoolEach": "ALL", "data": "json", "report": "json"},
               headers={"Referer": ACCUM_REF, "X-Requested-With": "XMLHttpRequest"},
               timeout=90, verify=False)
    rep = r.json().get("report", [])
    if not rep:
        raise RuntimeError("[accum %d] 빈 응답(엔드포인트 차단 의심)" % year)
    out.write_text(json.dumps(rep, ensure_ascii=False), encoding="utf-8")
    print("[accum %d] saved %d rows -> %s" % (year, len(rep), out.name))
    return rep


# ── 파싱 ────────────────────────────────────────────────────────────────
def _num(v):
    try:
        return float(v)
    except Exception:
        return None


def parse_datago_bs(raw_path):
    """FY2024 재무상태표 CSV → {canonical: dict(값 필드)}. 헤더명으로 컬럼 매핑."""
    txt = _decode(raw_path.read_bytes())
    rows = list(csv.reader(txt.splitlines()))
    hdr = rows[0]
    idx = {name: i for i, name in enumerate(hdr)}

    def col(name):
        return idx[name]

    c_curr = col("2_유동자산")
    c_liab_cur = col("3_유동부채")
    c_liab_fix = col("3_고정부채")
    c_fund = col("2_기본금")
    c_res_p = col("3_원금보존적립금")
    c_res_d = col("3_임의적립금")

    out = {}
    for r in rows[1:]:
        if not r or not r[0].strip():
            continue
        canon = canonicalize(r[0])
        rp = _num(r[c_res_p]) or 0.0
        rd = _num(r[c_res_d]) or 0.0
        lc = _num(r[c_liab_cur]) or 0.0
        lf = _num(r[c_liab_fix]) or 0.0
        rec = {
            "reserve_principal": round(rp),
            "reserve_discretionary": round(rd),
            "reserve_total": round(rp + rd),
            "current_assets": round(_num(r[c_curr]) or 0.0),
            "total_liabilities": round(lc + lf),
            "fund_basic": round(_num(r[c_fund]) or 0.0),
        }
        # 다캠퍼스로 학교명 중복 시 합산(현재 스냅샷엔 중복 없음)
        if canon in out:
            for k in rec:
                out[canon][k] += rec[k]
        else:
            out[canon] = rec
    return out


def parse_accum(rep):
    """accum report → {canonical: reserve_total(c6, 천원)}. 캠퍼스 합산."""
    agg = {}
    for x in rep:
        canon = canonicalize(x.get("schnm", ""))
        if not canon:
            continue
        agg[canon] = agg.get(canon, 0) + int(x.get("c6") or 0)
    return agg


# ── 빌드 ────────────────────────────────────────────────────────────────
FIELDS = ["canonical", "year", "reserve_principal", "reserve_discretionary",
          "reserve_total", "current_assets", "total_liabilities", "fund_basic"]


def build(force=False):
    INTERIM_DIR.mkdir(parents=True, exist_ok=True)

    download_datago_file(BS_PK, BS_RAW, force=force)
    datago = parse_datago_bs(BS_RAW)          # FY2024 full
    accum = {y: parse_accum(fetch_accum(y, force=force)) for y in ACCUM_YEARS}

    rows = []
    for year in ACCUM_YEARS:
        acc = accum[year]
        # 해당 연도에 등장하는 모든 학교(2024는 datago ∪ accum)
        canons = set(acc)
        if year == 2024:
            canons |= set(datago)
        for canon in sorted(canons):
            rec = {"canonical": canon, "year": year,
                   "reserve_principal": "", "reserve_discretionary": "",
                   "reserve_total": "", "current_assets": "",
                   "total_liabilities": "", "fund_basic": ""}
            if year == 2024 and canon in datago:
                d = datago[canon]
                for k in ("reserve_principal", "reserve_discretionary",
                          "reserve_total", "current_assets",
                          "total_liabilities", "fund_basic"):
                    rec[k] = d[k]
            elif canon in acc:
                rec["reserve_total"] = acc[canon]     # accum 기말잔액
            rows.append(rec)

    with open(OUT_CSV, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    print("[balance_sheet] %d rows (%d~%d) -> %s"
          % (len(rows), ACCUM_YEARS[0], ACCUM_YEARS[-1], OUT_CSV))
    return rows, datago, accum


if __name__ == "__main__":
    build(force="--force" in sys.argv)
