# -*- coding: utf-8 -*-
"""법인회계(KASFO) 자금계산서 수집 + 법인-학교 매핑 생성.

공공데이터포털 파일데이터(무로그인)를 역설계한 3단 다운로드로 CSV 를 받는다:
  ① /data/{pk}/fileData.do 에서 fn_fileDataDown('pk','uddi:...') 파싱 → publicDataDetailPk
  ② /tcs/dss/selectFileDataDownload.do?recommendDataYn=Y (publicDataPk+detailPk)
     → JSON.fileDataRegistVO.atchFileId / atchFileExtsn / orginlFileNm
  ③ /cmm/cmm/fileDownload.do?atchFileId=...&fileSn=0 → 실제 파일(CSV)

대상 데이터셋:
  15135558 사립대학 법인일반 및 교비 자금계산서 (CSV, 회계=교비/법인 행 혼재)
  15135555 사립대학 법인수익회계 자금계산서 (CSV)
  15093705 사립대학 수익용 기본재산 현황  → data.go.kr 에 파일 없음
           (제공형태='기관자체 다운로드(URL기재)', 실데이터는 대학재정알리미
            https://uniarlimi.kasfo.or.kr/totalAnno/properties/property ). 결측 처리.

산출:
  metadata/raw/corp_15135558.csv, corp_15135555.csv           (원본 캐시)
  build/interim/corp_accounts.csv
    corp_name, year, revenue_net, transfer_to_school, levy_transfer,
    base_property_required, base_property_held, base_property_ratio
  build/interim/corp_school_map.csv
    corp_name, canonical  (원본 xlsx 교비회계_대상대학 시트 기준)

소스 컬럼 → 우리 컬럼 매핑(리포트에도 기록):
  transfer_to_school  ← 15135558 [회계=교비] '5_경상비전입금'   (법인→학교 경상비 전입, 학교 수령액)
  levy_transfer       ← 15135558 [회계=교비] '5_법정부담전입금' (법인→학교 법정부담 전입)
  revenue_net         ← 15135555 '2_운영활동에 의한 현금유입(1020)' (수익회계 운영현금유입, 순수익 대체지표)
  base_property_*     ← 15093705 (확보 실패, 결측)
법인명(corp_name) 기준으로 소속 학교들을 합산해 법인 1행/연도로 집계한다.

연도: 15135558/15135555 는 연도 컬럼이 없는 단일 스냅샷(한국사학진흥재단 회계연도별
자료, 2025 등록·연 1회 갱신)이라 최신 마감연도 2024 로 라벨한다(리포트 명시).

멱등: metadata/raw 캐시가 있으면 재다운로드하지 않는다(--force 로 강제).
"""
import csv
import io
import json
import re
import sys
import warnings
from collections import defaultdict

warnings.filterwarnings("ignore")

try:
    from etl.config import INTERIM_DIR, METADATA_DIR
except Exception:  # 스크립트 직접 실행 대비
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from etl.config import INTERIM_DIR, METADATA_DIR

import requests

RAW_DIR = METADATA_DIR / "raw"
XLSX = METADATA_DIR.parent / "교비회계자금계산서_2016-2024(0916).xlsx"
MAP_SHEET = "교비회계_대상대학"

OUT_ACCOUNTS = INTERIM_DIR / "corp_accounts.csv"
OUT_MAP = INTERIM_DIR / "corp_school_map.csv"

SNAPSHOT_YEAR = 2024  # 15135558/15135555 스냅샷 라벨(최신 마감연도)

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")

DATASETS = {
    "15135558": "corp_15135558.csv",  # 법인일반 및 교비 자금계산서
    "15135555": "corp_15135555.csv",  # 법인수익회계 자금계산서
    "15093705": "corp_15093705",      # 수익용 기본재산(파일 없음 → 결측)
}

# 15093705 는 data.go.kr 에 파일이 없고 대학재정알리미 URL 참조형이다.
NOFILE_PK = "15093705"


# ── 학교명 정규화(match_schools.py 상단 계약과 동일) ────────────────────────
_PAREN_RE = re.compile(r"^(.*?)\((?:구[.．]?)?\s*(.*?)\)$")


def normalize(name):
    """→ canonical (괄호 안 구명칭/부기는 alias 로 떼고 앞부분을 canonical 로)."""
    s = name.strip().replace("（", "(").replace("）", ")")
    m = _PAREN_RE.match(s)
    if m:
        return m.group(1).strip()
    return s


def clean_corp(name):
    """법인명 정규화: 공백 정리 + 꼬리 괄호부기(예: '(전문)') 제거."""
    s = (name or "").strip().replace("（", "(").replace("）", ")")
    s = re.sub(r"\s*\([^()]*\)\s*$", "", s).strip()
    return s


# ── 공공데이터포털 파일 다운로드 ────────────────────────────────────────────
def _download_pk(session, pk):
    """publicDataPk → 파일 bytes (없으면 None)."""
    detail = "https://www.data.go.kr/data/%s/fileData.do" % pk
    html = session.get(detail, timeout=40, verify=False).text
    m = re.search(r"fn_fileDataDown\('%s',\s*'(uddi:[0-9a-f\-]+)'" % pk, html)
    uddi = m.group(1) if m else None
    if not uddi:
        found = re.findall(r"uddi:[0-9a-f\-]+", html)
        uddi = found[0] if found else None
    if not uddi:
        return None
    j = session.get(
        "https://www.data.go.kr/tcs/dss/selectFileDataDownload.do?recommendDataYn=Y",
        params={"publicDataPk": pk, "publicDataDetailPk": uddi},
        headers={"Referer": detail, "X-Requested-With": "XMLHttpRequest"},
        timeout=40, verify=False,
    ).json()
    vo = j.get("fileDataRegistVO") or {}
    aid = vo.get("atchFileId")
    if not aid:  # URL 참조형 등: 다운로드 파일 없음
        return None
    r = session.get(
        "https://www.data.go.kr/cmm/cmm/fileDownload.do",
        params={"atchFileId": aid, "fileSn": "0"},
        headers={"Referer": detail}, timeout=180, verify=False,
    )
    r.raise_for_status()
    return r.content


def fetch_raw(force=False):
    """3개 데이터셋 원본을 metadata/raw 에 캐시한다. {pk: path|None} 반환."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    out = {}
    for pk, fname in DATASETS.items():
        dest = RAW_DIR / fname
        if pk == NOFILE_PK:
            out[pk] = None
            continue
        if dest.exists() and not force:
            print("[corp] cache hit: %s" % dest.name)
            out[pk] = dest
            continue
        content = _download_pk(s, pk)
        if content is None:
            print("[corp] SKIP %s: 다운로드 파일 없음(URL참조형)" % pk)
            out[pk] = None
            continue
        dest.write_bytes(content)
        print("[corp] saved %s (%d bytes)" % (dest.name, len(content)))
        out[pk] = dest
    return out


def _read_csv(path):
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "cp949", "euc-kr", "utf-8"):
        try:
            txt = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    return list(csv.reader(io.StringIO(txt)))


def _num(v):
    v = (v or "").strip().replace(",", "")
    if not v:
        return 0.0
    try:
        return float(v)
    except ValueError:
        return 0.0


# ── corp_accounts 집계 ──────────────────────────────────────────────────────
def build_accounts(paths):
    """법인명 기준 집계 → corp_accounts 행 리스트."""
    agg = defaultdict(lambda: {
        "revenue_net": None, "transfer_to_school": None, "levy_transfer": None,
        "base_property_required": None, "base_property_held": None,
        "base_property_ratio": None,
    })

    # 15135558: 회계=교비 행에서 경상비전입금 / 법정부담전입금
    p558 = paths.get("15135558")
    if p558:
        rows = _read_csv(p558)
        h = {n: i for i, n in enumerate(rows[0])}
        ci_corp = h["법인명"]
        ci_acc = h["회계"]
        ci_ops = h["5_경상비전입금"]
        ci_levy = h["5_법정부담전입금"]
        for r in rows[1:]:
            if len(r) <= ci_levy:
                continue
            if r[ci_acc].strip() != "교비":
                continue
            corp = clean_corp(r[ci_corp])
            if not corp:
                continue
            d = agg[corp]
            d["transfer_to_school"] = (d["transfer_to_school"] or 0.0) + _num(r[ci_ops])
            d["levy_transfer"] = (d["levy_transfer"] or 0.0) + _num(r[ci_levy])

    # 15135555: 운영활동 현금유입(1020) = 수익회계 순수익 대체지표
    p555 = paths.get("15135555")
    if p555:
        rows = _read_csv(p555)
        h = {n: i for i, n in enumerate(rows[0])}
        ci_corp = h["법인명"]
        # 컬럼명에 코드가 붙어있어 접두 매칭
        ci_rev = next(i for n, i in h.items() if n.startswith("2_운영활동에 의한 현금유입"))
        for r in rows[1:]:
            if len(r) <= ci_rev:
                continue
            corp = clean_corp(r[ci_corp])
            if not corp:
                continue
            d = agg[corp]
            d["revenue_net"] = (d["revenue_net"] or 0.0) + _num(r[ci_rev])

    out = []
    for corp in sorted(agg):
        d = agg[corp]
        out.append({
            "corp_name": corp, "year": SNAPSHOT_YEAR,
            "revenue_net": _fmt(d["revenue_net"]),
            "transfer_to_school": _fmt(d["transfer_to_school"]),
            "levy_transfer": _fmt(d["levy_transfer"]),
            "base_property_required": "", "base_property_held": "",
            "base_property_ratio": "",
        })
    return out


def _fmt(v):
    if v is None:
        return ""
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    return "%.3f" % v


# ── corp_school_map (원본 xlsx 시트) ────────────────────────────────────────
def build_map():
    """교비회계_대상대학 시트의 (법인명, 학교명) 전 연도블록 → (corp_name, canonical)."""
    import openpyxl
    wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
    ws = wb[MAP_SHEET]
    grid = list(ws.iter_rows(values_only=True))
    header = grid[1]  # 0행=연도블록 제목, 1행=필드명
    # '법인명' 다음 칸이 '학교명' 인 컬럼쌍 탐색
    pairs = []
    for c in range(len(header) - 1):
        if (header[c] or "").strip() == "법인명" and (header[c + 1] or "").strip() == "학교명":
            pairs.append((c, c + 1))

    seen = set()
    out = []
    for row in grid[2:]:
        for cc, cs in pairs:
            corp = row[cc] if cc < len(row) else None
            school = row[cs] if cs < len(row) else None
            if not corp or not school:
                continue
            corp_n = clean_corp(str(corp))
            canon = normalize(str(school))
            if not corp_n or not canon:
                continue
            key = (corp_n, canon)
            if key in seen:
                continue
            seen.add(key)
            out.append({"corp_name": corp_n, "canonical": canon})
    out.sort(key=lambda d: (d["canonical"], d["corp_name"]))
    return out


def main(force=False):
    INTERIM_DIR.mkdir(parents=True, exist_ok=True)
    paths = fetch_raw(force=force)

    accounts = build_accounts(paths)
    with OUT_ACCOUNTS.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=[
            "corp_name", "year", "revenue_net", "transfer_to_school",
            "levy_transfer", "base_property_required", "base_property_held",
            "base_property_ratio"])
        w.writeheader()
        w.writerows(accounts)
    print("[corp] corp_accounts.csv: %d 법인" % len(accounts))

    mapping = build_map()
    with OUT_MAP.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["corp_name", "canonical"])
        w.writeheader()
        w.writerows(mapping)
    print("[corp] corp_school_map.csv: %d 매핑" % len(mapping))


if __name__ == "__main__":
    main(force="--force" in sys.argv)
