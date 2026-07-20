# -*- coding: utf-8 -*-
"""대학별 중도탈락률 수집 (대학알리미 대학정보공시, 공공데이터포털 15158684).

무인증 경로 조사 결과(d3_report.md 참조): 학교 단위 중도탈락(자퇴·미복학·미등록·
학사경고 제적 등 플로우)은 대학알리미(대학정보공시)만 학교별로 공시한다. KESS
학교별 데이터셋은 재적·재학·휴학 스톡만 제공(중도탈락 플로우 없음), KOSIS는 집계
(설립별·지역별)만 제공(학교별 없음), data.go.kr 대교협 파일데이터는 academyinfo.go.kr
링크형(robots 전면 금지) 또는 로그인 필수. 따라서 무인증 확보는 불가하며, 이 표준
경로는 공공데이터포털 오픈API 인증키(serviceKey)를 요구한다.

■ 인증키 신청 대상
  데이터셋:   한국대학교육협의회 대학정보공시 학생 현황
  URL:        https://www.data.go.kr/data/15158684/openapi.do
  엔드포인트: https://apis.data.go.kr/B340014/StudentService
  활용신청 → 승인(자동, 즉시) → 마이페이지의 '일반 인증키(Encoding/Decoding)' 발급
  발급받은 키를 환경변수 DATA_GO_KR_KEY 로 넣고 이 스크립트를 실행한다:
      export DATA_GO_KR_KEY='발급받은 Decoding 키'
      python -m metadata.fetch_dropout            # 캐시 있으면 재사용
      python -m metadata.fetch_dropout --force    # 강제 재다운로드

■ 산출
  metadata/raw/dropout_{year}.json        (연도별 원본 응답 캐시)
  build/interim/dropout.csv               (canonical, year, dropout_rate)
  build/d3_report.md                      (경로별 시도·정의·커버리지·검증)

■ 정의 (대학알리미)
  dropout_rate = 중도탈락 학생수 / 재적학생수
  분자: 해당 학년도 중도탈락 학생수(자퇴·미복학·미등록·학사경고·유급제적·기타)
  분모: 해당 학년도 재적학생수
  ※ 대학알리미 공시 중도탈락률은 '대학(학부)' 기준이 표준값이다. 응답이 과정
     (학부/대학원)으로 분해되면 학부만 집계해야 표준 중도탈락률과 일치한다
     (아래 UNDERGRAD_ONLY 참조).

멱등: 연도별 raw 캐시가 있으면 재다운로드하지 않는다(--force 로 강제).
키가 없으면 오류로 죽지 않고 신청 안내를 출력한 뒤 조용히 종료한다(파이프라인 무해).
"""
import csv
import json
import os
import statistics
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    from etl.config import INTERIM_DIR, METADATA_DIR, BUILD_DIR, YEARS, KMU_NAME
except Exception:  # 스크립트 직접 실행 대비
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from etl.config import INTERIM_DIR, METADATA_DIR, BUILD_DIR, YEARS, KMU_NAME

import requests

from metadata.match_schools import normalize, clean, campus_key
from metadata import build_school_master as bsm

RAW_DIR = METADATA_DIR / "raw"
OUT_CSV = INTERIM_DIR / "dropout.csv"
REPORT = BUILD_DIR / "d3_report.md"

# ── 대교협 학생 현황 서비스(15158684) ────────────────────────────────────
BASE = "https://apis.data.go.kr/B340014/StudentService"
# 대학비교통계(학교 단위) 오퍼레이션. 분자/분모를 각각 조회해 rate 를 산출한다.
OP_DROPOUT = "getComparisonDropOutStudentCrntSt"   # 중도탈락 학생 현황(학교별)
OP_ENROLLED = "getComparisonEnrolledStudentCrntSt"  # 재적학생 현황(학교별)
# 대안: 중도탈락률을 직접 공시하는 원자료 오퍼레이션(학교별)
#   getNoticeStudentsWastageRate  ← 중도탈락 학생비율
# 분자/분모를 모두 받아 우리가 산출하면 정의·검증이 명확하므로 위 두 개를 기본으로 쓴다.

ENV_KEY = "DATA_GO_KR_KEY"
PER_PAGE = 1000
# 학부(대학과정)만 집계할지. 대학알리미 표준 중도탈락률과 맞추려면 True.
# 응답에 과정 구분 필드(학제/과정)가 있을 때만 효력. (아래 _is_undergrad 참조)
UNDERGRAD_ONLY = True

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")

# 응답 필드명은 승인 후 참고문서(OpenAPI 명세)로 최종 확정할 것. GW API 는 대개
# schlKrnNm(학교명)·svyYr(조사연도) 를 쓰며, 수치 필드명은 오퍼레이션마다 다르다.
# 아래 후보 키를 넓게 잡고, 못 찾으면 키 문자열 부분일치로 폴백한다.
NAME_KEYS = ("schlKrnNm", "schlNm", "학교명", "univNm")
COURSE_KEYS = ("schlDivNm", "과정", "학제", "courseNm", "schlLevel")
DROPOUT_VAL_KEYS = ("dropStudCnt", "중도탈락학생수", "wastageStudCnt", "dropoutCnt")
ENROLLED_VAL_KEYS = ("enrolledStudCnt", "재적학생수", "enrlStudCnt", "regStudCnt")


def _need_key():
    key = os.environ.get(ENV_KEY, "").strip()
    if not key:
        print("=" * 68)
        print("[dropout] 인증키(%s) 미설정 — 확보 불가, 안내 후 종료." % ENV_KEY)
        print("  신청: https://www.data.go.kr/data/15158684/openapi.do  (활용신청→즉시승인)")
        print("  실행: export %s='발급 Decoding 키' && python -m metadata.fetch_dropout" % ENV_KEY)
        print("=" * 68)
    return key


# ── API 호출(페이지네이션) ────────────────────────────────────────────────
def _fetch_op(session, key, op, year):
    """오퍼레이션 op 의 year 조사연도 전체 레코드를 리스트로 반환."""
    items, page = [], 1
    while True:
        params = {
            "serviceKey": key,
            "svyYr": str(year),
            "pageNo": page,
            "numOfRows": PER_PAGE,
            "type": "json",
        }
        r = session.get("%s/%s" % (BASE, op), params=params, timeout=120)
        r.raise_for_status()
        try:
            body = r.json()
        except ValueError:
            raise RuntimeError("[dropout] %s %d: JSON 아님(키/한도 확인): %s"
                               % (op, year, r.text[:200]))
        chunk = _extract_items(body)
        items.extend(chunk)
        total = _extract_total(body)
        if total is None or len(items) >= total or not chunk:
            break
        page += 1
    return items


def _extract_items(body):
    """공공데이터포털 표준 래핑(response.body.items.item)에서 레코드 리스트 추출."""
    node = body
    for k in ("response", "body", "items"):
        if isinstance(node, dict) and k in node:
            node = node[k]
    if isinstance(node, dict) and "item" in node:
        node = node["item"]
    if isinstance(node, dict):
        return [node]
    return node if isinstance(node, list) else []


def _extract_total(body):
    node = body
    for k in ("response", "body"):
        if isinstance(node, dict) and k in node:
            node = node[k]
    if isinstance(node, dict):
        try:
            return int(node.get("totalCount"))
        except (TypeError, ValueError):
            return None
    return None


def _pick(item, keys):
    """후보 키 목록으로 값 조회. 실패 시 키 문자열 부분일치로 폴백."""
    for k in keys:
        if k in item and item[k] not in (None, ""):
            return item[k]
    low = {str(k).lower(): v for k, v in item.items()}
    for k in keys:
        kl = k.lower()
        for ik, v in low.items():
            if kl in ik and v not in (None, ""):
                return v
    return None


def _to_int(v):
    if v is None:
        return None
    s = str(v).replace(",", "").strip()
    try:
        return int(float(s))
    except ValueError:
        return None


def _is_undergrad(item):
    """과정 구분 필드가 있으면 학부(대학과정) 여부 판정. 필드 없으면 True(집계 포함)."""
    course = _pick(item, COURSE_KEYS)
    if course is None:
        return True
    c = str(course)
    if any(g in c for g in ("대학원", "석사", "박사", "전문대학원")):
        return False
    return True


# ── raw 캐시 ──────────────────────────────────────────────────────────────
def _load_or_fetch(session, key, year, force):
    dest = RAW_DIR / ("dropout_%d.json" % year)
    if dest.exists() and not force:
        print("[dropout] cache hit: %s" % dest.name)
        return json.loads(dest.read_text(encoding="utf-8"))
    drop = _fetch_op(session, key, OP_DROPOUT, year)
    enrl = _fetch_op(session, key, OP_ENROLLED, year)
    payload = {"dropout": drop, "enrolled": enrl}
    dest.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print("[dropout] saved %s (drop=%d, enrolled=%d)" % (dest.name, len(drop), len(enrl)))
    return payload


# ── campus_key 단위 집계 ───────────────────────────────────────────────────
def build_counts(session, key, force):
    """반환:
      ck2years : {campus_key: {year: {'drop':int|None, 'enrolled':int|None}}}
      norm2ck  : {정규화명: campus_key}
      clean2ck : {clean명: campus_key}
    """
    ck2years, norm2ck, clean2ck = {}, {}, {}

    def _accum(items, year, field):
        for it in items:
            if UNDERGRAD_ONLY and not _is_undergrad(it):
                continue
            name = _pick(it, NAME_KEYS)
            if not name:
                continue
            ck = campus_key(str(name))
            if not ck:
                continue
            c, _a = normalize(str(name))
            norm2ck.setdefault(c, ck)
            clean2ck.setdefault(clean(str(name)), ck)
            val = _to_int(_pick(it, DROPOUT_VAL_KEYS if field == "drop" else ENROLLED_VAL_KEYS))
            if val is None:
                continue
            slot = ck2years.setdefault(ck, {}).setdefault(year, {"drop": None, "enrolled": None})
            slot[field] = (slot[field] or 0) + val

    for year in YEARS:
        payload = _load_or_fetch(session, key, year, force)
        _accum(payload.get("dropout", []), year, "drop")
        _accum(payload.get("enrolled", []), year, "enrolled")
    return ck2years, norm2ck, clean2ck


def _ck_set(candidates, ck2years, norm2ck, clean2ck):
    """canonical+aliases → 매칭 campus_key 집합(개명 유니온). fetch_enrollment 와 동일 계약."""
    cks = set()
    for n in candidates:
        c, _a = normalize(n)
        if c in norm2ck:
            cks.add(norm2ck[c]); continue
        cc = clean(c)
        if cc in clean2ck:
            cks.add(clean2ck[cc]); continue
        ck = campus_key(n)
        if ck in ck2years:
            cks.add(ck)
    return cks


# ── 메인 ────────────────────────────────────────────────────────────────
def main(force=False):
    key = _need_key()
    if not key:
        return None  # 확보 불가: 스크립트 골격만 준비된 상태

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    INTERIM_DIR.mkdir(parents=True, exist_ok=True)
    s = requests.Session()
    s.headers.update({"User-Agent": UA})

    targets = bsm.load_targets()
    ck2years, norm2ck, clean2ck = build_counts(s, key, force)

    rows, matched, full, unmatched, kmu_dbg = [], 0, 0, [], {}
    for canonical, aliases in targets:
        cks = _ck_set([canonical] + aliases, ck2years, norm2ck, clean2ck)
        if not cks:
            unmatched.append(canonical); continue
        matched += 1
        have = 0
        for year in YEARS:
            drops = [ck2years[ck][year]["drop"] for ck in cks
                     if ck in ck2years and year in ck2years[ck]
                     and ck2years[ck][year]["drop"] is not None]
            enrs = [ck2years[ck][year]["enrolled"] for ck in cks
                    if ck in ck2years and year in ck2years[ck]
                    and ck2years[ck][year]["enrolled"] is not None]
            d = sum(drops) if drops else None
            e = sum(enrs) if enrs else None
            rate = round(d / e, 4) if (d is not None and e) else None
            if rate is not None:
                have += 1
            rows.append({
                "canonical": canonical,
                "year": year,
                "dropout_rate": rate if rate is not None else "",
            })
            if canonical == KMU_NAME:
                kmu_dbg[year] = (d, e, rate)
        if have == len(YEARS):
            full += 1

    write_csv(rows)
    stats = _verify(rows, matched, len(targets), full, unmatched, kmu_dbg)
    write_report(stats)
    print("[dropout] matched %d/%d (9개년 완비 %d) rows=%d"
          % (matched, len(targets), full, len(rows)))
    print("[dropout][spot] %s: %s" % (KMU_NAME, kmu_dbg))
    return stats


def write_csv(rows):
    with open(OUT_CSV, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["canonical", "year", "dropout_rate"])
        w.writeheader()
        w.writerows(rows)
    print("[dropout] wrote %s (%d rows)" % (OUT_CSV, len(rows)))


def _verify(rows, matched, n_targets, full, unmatched, kmu_dbg):
    vals = [r["dropout_rate"] for r in rows if isinstance(r["dropout_rate"], float)]
    q = {}
    if vals:
        vs = sorted(vals)
        q = {
            "n": len(vs),
            "median": round(statistics.median(vs), 4),
            "p25": round(vs[len(vs) // 4], 4),
            "p75": round(vs[(len(vs) * 3) // 4], 4),
            "min": round(vs[0], 4),
            "max": round(vs[-1], 4),
        }
    return {"matched": matched, "n_targets": n_targets, "full": full,
            "unmatched": unmatched, "kmu": kmu_dbg, "dist": q}


def write_report(s):
    L = []
    ap = L.append
    ap("# D3 데이터 수집 리포트 — 대학별 중도탈락률\n")
    ap("소스: 한국대학교육협의회 대학정보공시(대학알리미), 공공데이터포털 15158684, "
       "엔드포인트 https://apis.data.go.kr/B340014/StudentService (인증키 필요).\n")
    ap("## 정의")
    ap("- dropout_rate = 중도탈락 학생수 ÷ 재적학생수 (대학알리미 정의)")
    ap("- 분자: getComparisonDropOutStudentCrntSt(중도탈락 학생 현황, 학교별)")
    ap("- 분모: getComparisonEnrolledStudentCrntSt(재적학생 현황, 학교별)")
    ap("- 학부(대학과정) 기준 집계(UNDERGRAD_ONLY)\n")
    ap("## 커버리지")
    ap("- 매칭: %d/%d교, 9개년 완비 %d교" % (s["matched"], s["n_targets"], s["full"]))
    if s["unmatched"]:
        ap("- 미매칭 %d교: %s" % (len(s["unmatched"]), ", ".join(s["unmatched"][:20])))
    ap("")
    ap("## 검증")
    if s["kmu"]:
        ap("- 국민대학교 (중도탈락/재적/률):")
        for y in sorted(s["kmu"]):
            d, e, r = s["kmu"][y]
            ap("  - %d: %s / %s / %s" % (y, d, e, ("%.2f%%" % (r * 100)) if r else "-"))
    if s["dist"]:
        d = s["dist"]
        ap("- 전국 분포(n=%d): 중앙값 %.2f%%, Q1 %.2f%%, Q3 %.2f%% (min %.2f%% / max %.2f%%)"
           % (d["n"], d["median"] * 100, d["p25"] * 100, d["p75"] * 100,
              d["min"] * 100, d["max"] * 100))
    REPORT.write_text("\n".join(L), encoding="utf-8")
    print("[dropout] wrote %s" % REPORT)


if __name__ == "__main__":
    main(force="--force" in sys.argv)
