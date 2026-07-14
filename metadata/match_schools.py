# -*- coding: utf-8 -*-
"""자금계산서 대상 391개 학교명 ↔ 공개데이터(표준데이터·KESS) 매칭 및 산출.

산출:
  build/interim/schools_meta.csv
    canonical, sido, region, school_type, found_type, campus,
    enroll_2016..enroll_2024, scale
  build/match_report.md
    소스별 확보 현황 · 매칭 단계별 건수 · 미매칭 목록(유사후보) · 데이터 한계

학교명 매칭 계약(ETL 공유):
  정규화: strip → 전각괄호→() → ^(.*?)\\((?:구[.．]?)?\\s*(.*?)\\)$ → canonical=grp1, alias=grp2
  단계: ①정규화명 정확일치 ②alias(구명칭)일치 ③클리닝 일치(공백·중점·괄호 제거,
        소스 캠퍼스 접미 제거, 본교 우선) ④manual_overrides.csv

재학생(enroll) 집계: KESS 는 다캠퍼스 대학을 캠퍼스별 행으로 쪼개 등재한다
(예: 명지대학교=자연캠퍼스+인문캠퍼스, 한양대학교=서울+ERICA). 교비회계 자금계산서는
대학 단위 통합 회계이므로 campus_key(캠퍼스 접미 제거)로 묶어 **연도별 합산**한다.
개명 학교는 alias bridge/override 로 구·현행명을 한 기관으로 연결(연도별로 한 이름만
존재 → 합산해도 중복 없음).
"""
import csv
import json
import re
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    from etl.config import (INTERIM_DIR, BUILD_DIR, METADATA_DIR, YEARS,
                            SCALE_THRESHOLDS, REGION_MAP, KMU_NAME)
except Exception:
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from etl.config import (INTERIM_DIR, BUILD_DIR, METADATA_DIR, YEARS,
                            SCALE_THRESHOLDS, REGION_MAP, KMU_NAME)

from metadata.parse_metadata import parse_std, parse_kess, norm_school_type

HEADERS_JSON = INTERIM_DIR / "headers.json"
OVERRIDES_CSV = METADATA_DIR / "manual_overrides.csv"
OUT_CSV = INTERIM_DIR / "schools_meta.csv"
OUT_REPORT = BUILD_DIR / "match_report.md"

# 시도 → 권역 (config.REGION_MAP 역인덱스; 그 외는 지방권)
_SIDO2REGION = {}
for _region, _sidos in REGION_MAP.items():
    for _s in _sidos:
        _SIDO2REGION[_s] = _region


def region_of(sido):
    if not sido:
        return ""
    return _SIDO2REGION.get(sido, "지방권")


def scale_of(enroll):
    if enroll is None:
        return ""
    for thr, label in SCALE_THRESHOLDS:  # [(10000,'대규모'),(5000,'중규모'),(0,'소규모')]
        if enroll >= thr:
            return label
    return ""


# ── 정규화 / 클리닝 / 캠퍼스키 ──────────────────────────────────────────
_PAREN_RE = re.compile(r"^(.*?)\((?:구[.．]?)?\s*(.*?)\)$")
_CAMPUS_SUFFIX = ["글로벌캠퍼스", "제2캠퍼스", "제3캠퍼스", "제4캠퍼스", "제1캠퍼스",
                  "제2캠퍼", "제3캠퍼", "제1캠퍼", "본교"]
# KESS 캠퍼스 분리행은 "<대학명> <캠퍼스명>캠퍼스" 처럼 공백으로 구분됨
_CAMPUS_TAIL_RE = re.compile(r"\s+\S*캠퍼스$")


def normalize(name):
    """→ (canonical, alias|None)"""
    s = name.strip().replace("（", "(").replace("）", ")")
    m = _PAREN_RE.match(s)
    if m:
        return m.group(1).strip(), (m.group(2).strip() or None)
    return s, None


def clean(name):
    """공백·중점·괄호(내용 포함) 제거 + 소스 캠퍼스 접미 제거."""
    s = re.sub(r"\(.*?\)", "", name)
    for suf in _CAMPUS_SUFFIX:
        s = s.replace(suf, "")
    for ch in (" ", "\t", "·", "・", "‧", "．", ".", "，", ","):
        s = s.replace(ch, "")
    return s.strip()


def campus_key(name):
    """다캠퍼스 대학 통합용 키: 공백으로 구분된 꼬리 'XX캠퍼스' 제거 후 clean."""
    s = name.strip().replace("（", "(").replace("）", ")")
    s = _CAMPUS_TAIL_RE.sub("", s)
    return clean(s)


def levenshtein(a, b):
    if a == b:
        return 0
    if not a or not b:
        return len(a) + len(b)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


# ── 인덱스 구축 ─────────────────────────────────────────────────────────
def _univ_se_rank(rec):
    return 0 if rec.get("univ_se") in ("대학", "전문대학") else 1


def build_std_index(std):
    """정규화명 → std 대표 레코드 (본교·base 우선)."""
    by_norm, by_clean = {}, {}
    ordered = sorted(std, key=lambda r: (_univ_se_rank(r),
                                         0 if r["campus"] == "본교" else 1))
    for r in ordered:
        if not r["name"]:
            continue
        c, _a = normalize(r["name"])
        by_norm.setdefault(c, r)
        by_clean.setdefault(clean(r["name"]), r)
    return by_norm, by_clean


def build_kess_agg(kess):
    """KESS → campus_key 단위 집계.

    반환:
      ck2years : {campus_key: {year: 합산_재학생}}
      ck2meta  : {campus_key: 대표 레코드(최신연도·최대재학생)}
      norm2ck  : {정규화명: campus_key}
      clean2ck : {clean명: campus_key}
    """
    ck2years = {}
    ck2meta = {}
    norm2ck = {}
    clean2ck = {}
    meta_best = {}  # ck -> (year, enroll) 최신·최대 추적
    for year in YEARS:
        for r in kess.get(year, []):
            name = r["name"]
            ck = campus_key(name)
            if not ck:
                continue
            c, _a = normalize(name)
            norm2ck.setdefault(c, ck)
            clean2ck.setdefault(clean(name), ck)
            # 연도별 합산 (재학생 결측은 0 취급하되, 전부 결측이면 미집계)
            e = r["enroll"]
            if e is not None:
                slot = ck2years.setdefault(ck, {})
                slot[year] = slot.get(year, 0) + e
            # 대표 메타: 최신연도 우선, 동년도면 재학생 큰 행
            key = (year, e if e is not None else -1)
            if ck not in meta_best or key > meta_best[ck]:
                meta_best[ck] = key
                ck2meta[ck] = r
    return ck2years, ck2meta, norm2ck, clean2ck


def load_overrides():
    """canonical_name → source_name."""
    out = {}
    if not OVERRIDES_CSV.exists():
        return out
    with open(OVERRIDES_CSV, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            cn = (row.get("canonical_name") or "").strip()
            sn = (row.get("source_name") or "").strip()
            if cn and sn:
                out[cn] = sn
    return out


def main():
    data = json.loads(HEADERS_JSON.read_text(encoding="utf-8"))
    targets = [x["name"] for x in data["schools"]]

    std = parse_std()
    kess = parse_kess()
    std_norm, std_clean = build_std_index(std)
    ck2years, ck2meta, kess_norm2ck, kess_clean2ck = build_kess_agg(kess)
    overrides = load_overrides()

    # 타깃 내부 alias bridge: "NEW(구.OLD)" → OLD_canonical ↔ NEW_canonical
    bridge = {}          # old_norm -> new_norm
    reverse_bridge = {}  # new_norm -> [old_norm,...]
    for t in targets:
        c, a = normalize(t)
        if a:
            bridge[a] = c
            reverse_bridge.setdefault(c, []).append(a)

    # 소스 존재 집합 (정규화명 기준: std 또는 kess)
    src_norm_keys = set(std_norm) | set(kess_norm2ck)
    src_clean_keys = set(std_clean) | set(kess_clean2ck)
    src_pool = sorted(src_norm_keys)

    def resolve(canonical, alias):
        """→ (matched_source_name, stage) or (None, None)."""
        if canonical in src_norm_keys:
            return canonical, "1_exact"
        if alias and alias in src_norm_keys:
            return alias, "2_alias"
        if canonical in bridge and bridge[canonical] in src_norm_keys:
            return bridge[canonical], "2_alias"
        cc = clean(canonical)
        if cc in src_clean_keys:
            return cc, "3_clean"
        if alias and clean(alias) in src_clean_keys:
            return clean(alias), "3_clean"
        if canonical in overrides:
            sn = normalize(overrides[canonical])[0]
            if sn in src_norm_keys:
                return sn, "4_manual"
        return None, None

    def institution_names(canonical, alias, matched):
        """기관의 모든 이력 정규화명 집합 (연도별 enroll 집계용)."""
        names = {canonical, matched}
        if alias:
            names.add(alias)
        # 개명 연결
        for base in (canonical, matched):
            if base in reverse_bridge:
                names.update(reverse_bridge[base])
            if base in bridge:
                names.add(bridge[base])
                names.update(reverse_bridge.get(bridge[base], []))
        # 오버라이드로 지정된 동일기관명
        if canonical in overrides:
            names.add(normalize(overrides[canonical])[0])
        return names

    def ck_set(names):
        cks = set()
        for n in names:
            if n in kess_norm2ck:
                cks.add(kess_norm2ck[n])
            else:
                cks.add(campus_key(n))
        return cks

    rows = []
    stage_counts = {"1_exact": 0, "2_alias": 0, "3_clean": 0, "4_manual": 0}
    unmatched = []
    seen_canon = set()

    for t in targets:
        canonical, alias = normalize(t)
        if canonical in seen_canon:
            continue
        seen_canon.add(canonical)

        matched, stage = resolve(canonical, alias)
        if matched is None:
            unmatched.append(canonical)
            rows.append({"canonical": canonical})
            continue
        stage_counts[stage] += 1

        names = institution_names(canonical, alias, matched)
        cks = ck_set(names)

        # 메타(sido/type/found/campus): std 우선, 없으면 kess 대표
        std_rec = None
        for n in names:
            if n in std_norm:
                std_rec = std_norm[n]
                break
        kess_rec = None
        for ck in cks:
            if ck in ck2meta:
                if kess_rec is None or (ck2meta[ck]["enroll"] or 0) > (kess_rec["enroll"] or 0):
                    kess_rec = ck2meta[ck]

        if std_rec:
            sido = std_rec["sido"]
            found_type = std_rec["found_type"]
            campus = std_rec["campus"]
            school_type = norm_school_type(univ_se=std_rec["univ_se"],
                                           schl_se=std_rec["schl_se"])
        elif kess_rec:
            sido = kess_rec["sido"]
            found_type = kess_rec["found"]
            campus = kess_rec["campus"]
            school_type = norm_school_type(hakje=kess_rec["hakje"],
                                           grad_gubun=kess_rec["grad"])
        else:
            sido = found_type = campus = school_type = ""
        if not sido and kess_rec:
            sido = kess_rec["sido"]

        row = {
            "canonical": canonical,
            "sido": sido,
            "region": region_of(sido),
            "school_type": school_type or "",
            "found_type": found_type or "",
            "campus": campus or "",
        }
        last_enroll = None
        for y in YEARS:
            vals = [ck2years[ck][y] for ck in cks
                    if ck in ck2years and y in ck2years[ck]]
            val = sum(vals) if vals else None
            row["enroll_%d" % y] = val if val is not None else ""
            if val is not None:
                last_enroll = val
        row["scale"] = scale_of(last_enroll)
        rows.append(row)

    write_csv(rows)
    write_report(rows, stage_counts, unmatched, std, kess, targets, src_pool)
    spotcheck(rows)
    return rows


def write_csv(rows):
    cols = (["canonical", "sido", "region", "school_type", "found_type", "campus"]
            + ["enroll_%d" % y for y in YEARS] + ["scale"])
    INTERIM_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_CSV, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in cols})
    print("[match] wrote %s (%d rows)" % (OUT_CSV, len(rows)))


def _top_candidates(name, pool, k=3):
    scored = sorted(((levenshtein(name, p), p) for p in pool))[:k]
    return ["%s(d=%d)" % (p, d) for d, p in scored]


def write_report(rows, stage_counts, unmatched, std, kess, targets, src_pool):
    total_canon = len(rows)
    matched = total_canon - len(unmatched)
    rate = 100.0 * matched / total_canon if total_canon else 0.0

    enroll_full = sum(1 for r in rows
                      if all(r.get("enroll_%d" % y) not in (None, "") for y in YEARS))
    enroll_any = sum(1 for r in rows
                     if any(r.get("enroll_%d" % y) not in (None, "") for y in YEARS))
    enroll_none = matched - enroll_any

    lines = []
    ap = lines.append
    ap("# 학교 메타데이터 매칭 리포트\n")
    ap("자금계산서 대상 학교명 ↔ 공개데이터(표준데이터·KESS) 매칭 결과.\n")

    ap("## 1. 소스별 확보 현황\n")
    ap("| 소스 | 내용 | 레코드 |")
    ap("|---|---|---|")
    ap("| 표준데이터(공공데이터포털 15107736) | 학교구분·설립형태·시도·주소 | %d |" % len(std))
    for y in YEARS:
        ap("| KESS %d 고등 학교별 | 재학생·전임교원 (본교 기관) | %d |"
           % (y, len(kess.get(y, []))))
    ap("")

    ap("## 2. 매칭 결과\n")
    ap("- 대상 자금계산서 학교명(원): **%d개**" % len(targets))
    ap("- 중복 정규화명 제거 후 고유 canonical: **%d개**" % total_canon)
    ap("- 매칭 성공: **%d개** / 미매칭: **%d개**" % (matched, len(unmatched)))
    ap("- **매칭률: %.1f%%** (고유 canonical 기준)\n" % rate)
    ap("| 단계 | 방식 | 건수 |")
    ap("|---|---|---|")
    ap("| ① exact | 정규화명 정확 일치 | %d |" % stage_counts["1_exact"])
    ap("| ② alias | 구명칭/이력명 일치 | %d |" % stage_counts["2_alias"])
    ap("| ③ clean | 공백·중점·괄호·캠퍼스 제거 후 일치 | %d |" % stage_counts["3_clean"])
    ap("| ④ manual | manual_overrides.csv | %d |" % stage_counts["4_manual"])
    ap("")

    ap("## 3. 재학생(enroll) 커버리지\n")
    ap("- 9개년 전부 확보: **%d개**" % enroll_full)
    ap("- 1개년 이상 확보: **%d개**" % enroll_any)
    ap("- 매칭됐으나 재학생 전무: **%d개**\n" % enroll_none)

    if unmatched:
        ap("## 4. 미매칭 목록 (유사 후보 상위 3, 편집거리)\n")
        for u in sorted(unmatched):
            ap("- **%s** → %s" % (u, ", ".join(_top_candidates(u, src_pool))))
        ap("")
    else:
        ap("## 4. 미매칭 목록\n\n없음 (전건 매칭).\n")

    no_enroll = [r["canonical"] for r in rows
                 if r["canonical"] not in unmatched
                 and not any(r.get("enroll_%d" % y) not in (None, "") for y in YEARS)]
    if no_enroll:
        ap("## 5. 매칭됐으나 재학생 결측\n")
        for n in sorted(no_enroll):
            ap("- %s" % n)
        ap("")

    # 규모 분포
    from collections import Counter
    scale_dist = Counter(r.get("scale") or "(결측)" for r in rows)
    region_dist = Counter(r.get("region") or "(결측)" for r in rows)
    type_dist = Counter(r.get("school_type") or "(결측)" for r in rows)
    ap("## 6. 분류 분포\n")
    ap("- 규모: " + ", ".join("%s=%d" % (k, v) for k, v in scale_dist.most_common()))
    ap("- 권역: " + ", ".join("%s=%d" % (k, v) for k, v in region_dist.most_common()))
    ap("- 학교구분: " + ", ".join("%s=%d" % (k, v) for k, v in type_dist.most_common()))
    ap("")

    ap("## 7. 데이터 한계 및 주의\n")
    ap("- **재학생 정의**: KESS 「학교별 교육통계」 `재학생_전체_계`(재적 중 재학, 휴학 제외). "
       "부설대학원 제외, 본교 기관 기준.")
    ap("- **다캠퍼스 합산**: 교비회계 자금계산서는 대학 단위 통합 회계이므로 KESS 의 캠퍼스별 "
       "분리 행(예: 명지대 자연/인문, 고려대 안암/세종, 한양대 서울/ERICA, 연세대 신촌/미래/국제)을 "
       "campus_key 로 묶어 연도별 합산. 소재지·설립형태는 표준데이터 본교 기준.")
    ap("- **규모(scale)**: 최신 가용 연도 재학생 기준(대규모 1만↑ / 중규모 5천↑ / 소규모). "
       "전 연도 결측이면 빈값 — 후속 단계 등록금수입 프록시로 보완 가능.")
    ap("- **대학원대학·신학대학원**: 표준데이터 일부 누락분을 KESS 로 보완. 재학생 규모가 작아 "
       "대부분 소규모.")
    ap("- **개명 학교**: 자금계산서 구명칭 표기(`신(구.옛)`)와 표준/KESS 현행명을 alias bridge/"
       "manual_overrides 로 동일 기관 연결(연도별로 한 이름만 존재 → 합산 중복 없음).")
    ap("- **시도/권역**: config.REGION_MAP (수도권=서울·경기·인천, 광역권=부산·대구·광주·대전·울산, "
       "그 외 지방권).")

    OUT_REPORT.parent.mkdir(parents=True, exist_ok=True)
    OUT_REPORT.write_text("\n".join(lines), encoding="utf-8")
    print("[match] wrote %s" % OUT_REPORT)


def spotcheck(rows):
    kmu = next((r for r in rows if r["canonical"] == KMU_NAME), None)
    print("\n[spotcheck] %s" % KMU_NAME)
    if not kmu:
        print("  !! 국민대 행 없음")
        return
    print("  sido=%s region=%s scale=%s type=%s found=%s campus=%s"
          % (kmu.get("sido"), kmu.get("region"), kmu.get("scale"),
             kmu.get("school_type"), kmu.get("found_type"), kmu.get("campus")))
    print("  enroll:", {y: kmu.get("enroll_%d" % y) for y in YEARS})


if __name__ == "__main__":
    main()
