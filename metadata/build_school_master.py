# -*- coding: utf-8 -*-
"""학교코드 마스터 구축 (E2).

소스: 공공데이터포털 15100330 「교육부_대학교개황리스트」 (원자료 = 대학알리미).
  data.go.kr 파일데이터 다운로드는 로그인 인증이 필요(atachFileYn=N)하므로,
  동일 원본이 게시된 대학알리미(academyinfo.go.kr) 자료실 게시글에서 .xls 를
  무인증으로 내려받는다(실증됨). 캐시: metadata/raw/univ_overview.xls.

산출: build/interim/school_master.csv (utf-8-sig)
  canonical, school_code, 본분교, 학제, sido, 설립구분, 법인명, 학교상태

매칭 계약: metadata/match_schools.py 와 동일한 normalize/clean/campus_key 를 재사용해
  자금계산서 대상 대학(build/interim/schools.csv 의 canonical + aliases)과 개황리스트
  학교명을 단계 매칭(①정규화 정확 ②clean ③campus_key). 다캠퍼스는 본교 행을 대표로
  삼는다(개황리스트는 캠퍼스별 행으로 등재).

멱등: univ_overview.xls 캐시가 있으면 재다운로드하지 않는다(--force 로 강제).
의존: xlrd(>=2.0) — 개황리스트는 BIFF .xls 포맷.
"""
import csv
import re
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    from etl.config import INTERIM_DIR, METADATA_DIR, KMU_NAME
except Exception:
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from etl.config import INTERIM_DIR, METADATA_DIR, KMU_NAME

from metadata.match_schools import normalize, clean, campus_key
from metadata.parse_metadata import norm_sido

import requests

RAW_DIR = METADATA_DIR / "raw"
OVERVIEW_XLS = RAW_DIR / "univ_overview.xls"
SCHOOLS_CSV = INTERIM_DIR / "schools.csv"
OUT_CSV = INTERIM_DIR / "school_master.csv"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")

# data.go.kr 15100330 → 동일 원본이 게시된 대학알리미 자료실 게시글
DATAGO_URL = "https://www.data.go.kr/data/15100330/fileData.do"
DATAGO_DL = "https://www.data.go.kr/tcs/dss/selectFileDataDownload.do"
ACADEMYINFO_DL = "https://www.academyinfo.go.kr/file/FileDown.do"


# ── 다운로드 ────────────────────────────────────────────────────────────
def download_overview(force=False):
    """대학교개황리스트 .xls 를 대학알리미 게시글에서 내려받아 캐시한다."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if OVERVIEW_XLS.exists() and not force:
        print("[master] cache hit: %s" % OVERVIEW_XLS.name)
        return OVERVIEW_XLS

    s = requests.Session()
    s.headers.update({"User-Agent": UA})

    # 1) data.go.kr 상세 페이지에서 publicDataDetailPk 추출
    html = s.get(DATAGO_URL, timeout=60).text
    m = re.search(r'id="publicDataDetailPk"[^>]*value="([^"]+)"', html)
    if not m:
        raise RuntimeError("[master] publicDataDetailPk 파싱 실패")
    detail_pk = m.group(1)

    # 2) 다운로드 메타 JSON → 원자료 게시글(dataUrl) 획득
    meta = s.get(DATAGO_DL, params={"publicDataPk": "15100330",
                                    "publicDataDetailPk": detail_pk}, timeout=60).json()
    board_url = meta["dataSetFileDetailInfo"].get("dataUrl")
    if not board_url or "academyinfo" not in board_url:
        raise RuntimeError("[master] 대학알리미 게시글 URL 파싱 실패: %s" % board_url)

    # 3) 게시글에서 첨부파일 번호 추출 후 무인증 다운로드
    board = s.get(board_url, timeout=60, headers={"Referer": DATAGO_URL}).text
    fm = re.search(r"fn_file_down\('(\d+)'\)", board)
    if not fm:
        raise RuntimeError("[master] 게시글 첨부파일 번호 파싱 실패")
    atch = fm.group(1)
    r = s.post(ACADEMYINFO_DL, data={"atch_file_no": atch},
               headers={"Referer": board_url}, timeout=180)
    r.raise_for_status()
    if r.content[:4] != b"\xd0\xcf\x11\xe0" and r.content[:2] != b"PK":
        raise RuntimeError("[master] 내려받은 파일이 xls/xlsx 아님 (size=%d)" % len(r.content))
    OVERVIEW_XLS.write_bytes(r.content)
    print("[master] saved %s (%d bytes)" % (OVERVIEW_XLS.name, len(r.content)))
    return OVERVIEW_XLS


# ── 파싱 ────────────────────────────────────────────────────────────────
def parse_overview():
    """개황리스트 .xls → 기관 레코드 목록(원본 충실)."""
    import xlrd
    wb = xlrd.open_workbook(str(OVERVIEW_XLS))
    sh = wb.sheet_by_index(0)
    hdr = [str(sh.cell_value(0, j)).strip() for j in range(sh.ncols)]
    ci = {h: j for j, h in enumerate(hdr)}

    def cv(i, label):
        j = ci.get(label)
        return str(sh.cell_value(i, j)).strip() if j is not None else ""

    out = []
    for i in range(1, sh.nrows):
        name = cv(i, "학교명")
        if not name:
            continue
        out.append({
            "name": name,
            "school_code": cv(i, "학교코드"),
            "school_gubun": cv(i, "학교구분"),
            "campus": cv(i, "본분교"),
            "hakje": cv(i, "학제"),
            "sido": norm_sido(cv(i, "지역")),
            "found_type": cv(i, "설립구분"),
            "corp": cv(i, "법인명"),
            "state": cv(i, "학교상태"),
        })
    return out


# ── 타깃/인덱스/매칭 (fetch_enrollment 와 공유) ──────────────────────────
def load_targets():
    """자금계산서 대상 대학 → [(canonical, [aliases])] (schools.csv)."""
    targets = []
    with open(SCHOOLS_CSV, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            canon = (row.get("canonical") or "").strip()
            if not canon:
                continue
            aliases = [a.strip() for a in (row.get("aliases") or "").split(";") if a.strip()]
            targets.append((canon, aliases))
    return targets


def build_index(records, campus_priority=True):
    """레코드 목록 → (by_norm, by_clean, by_ck). 본교 레코드를 대표로 우선.

    records: 각 원소는 dict, 최소한 'name' 과 'campus'(본분교) 키를 가진다.
    """
    def rank(r):
        if not campus_priority:
            return 0
        return 0 if r.get("campus") == "본교" else 1

    by_norm, by_clean, by_ck = {}, {}, {}
    for r in sorted(records, key=rank):
        name = r.get("name")
        if not name:
            continue
        c, _a = normalize(name)
        by_norm.setdefault(c, r)
        by_clean.setdefault(clean(name), r)
        by_ck.setdefault(campus_key(name), r)
    return by_norm, by_clean, by_ck


def resolve_target(candidates, index):
    """(canonical + aliases) → (record, stage) or (None, None).

    단계: ①정규화명 정확 ②clean 일치 ③campus_key 일치.
    """
    by_norm, by_clean, by_ck = index
    for n in candidates:
        c, _a = normalize(n)
        if c in by_norm:
            return by_norm[c], "1_exact"
    for n in candidates:
        c, _a = normalize(n)
        cc = clean(c)
        if cc in by_clean:
            return by_clean[cc], "2_clean"
    for n in candidates:
        ck = campus_key(n)
        if ck in by_ck:
            return by_ck[ck], "3_ck"
    return None, None


# ── 메인 ────────────────────────────────────────────────────────────────
def main(force=False):
    download_overview(force=force)
    records = parse_overview()
    targets = load_targets()
    index = build_index(records, campus_priority=True)

    rows = []
    matched = 0
    unmatched = []
    stage_counts = {"1_exact": 0, "2_clean": 0, "3_ck": 0}
    for canonical, aliases in targets:
        rec, stage = resolve_target([canonical] + aliases, index)
        if rec is None:
            unmatched.append(canonical)
            rows.append({"canonical": canonical})
            continue
        matched += 1
        stage_counts[stage] += 1
        rows.append({
            "canonical": canonical,
            "school_code": rec["school_code"],
            "본분교": rec["campus"],
            "학제": rec["hakje"],
            "sido": rec["sido"],
            "설립구분": rec["found_type"],
            "법인명": rec["corp"],
            "학교상태": rec["state"],
        })

    write_csv(rows)
    rate = 100.0 * matched / len(targets) if targets else 0.0
    print("[master] matched %d/%d (%.1f%%)  stages=%s"
          % (matched, len(targets), rate, stage_counts))
    if unmatched:
        print("[master] unmatched: %s" % ", ".join(unmatched))
    _spotcheck(rows)

    return {
        "n_records": len(records),
        "n_targets": len(targets),
        "matched": matched,
        "rate": rate,
        "stage_counts": stage_counts,
        "unmatched": unmatched,
    }


def write_csv(rows):
    cols = ["canonical", "school_code", "본분교", "학제", "sido",
            "설립구분", "법인명", "학교상태"]
    INTERIM_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_CSV, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in cols})
    print("[master] wrote %s (%d rows)" % (OUT_CSV, len(rows)))


def _spotcheck(rows):
    kmu = next((r for r in rows if r.get("canonical") == KMU_NAME), None)
    print("[master][spot] %s: %s" % (KMU_NAME, kmu))


if __name__ == "__main__":
    main(force="--force" in sys.argv)
