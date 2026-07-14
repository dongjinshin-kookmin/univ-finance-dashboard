# -*- coding: utf-8 -*-
"""변환 단계: 학교명 정규화 + tidy(long) 변환.

학교명 정규화(메타데이터 파이프라인과 공유되는 계약 — 정확히 이대로):
  1. 이름 양끝 공백 제거
  2. 전각 괄호 （）를 ()로 통일
  3. `^(.*?)\\((?:구[.．]?)?\\s*(.*?)\\)$` 매칭 시 canonical=그룹1, alias=그룹2
  4. 비매칭 시 canonical=원명, alias 없음

school_id: canonical 기준 부여. 서로 다른 연도에서 alias 가 다른 canonical 과
일치하면 동일 학교로 병합(union-find).

산출:
  build/interim/schools.csv   (school_id, canonical, aliases, years, c100)
  build/interim/tidy.csv.gz   (year, school_id, side, account_key, amount)
"""
import csv
import gzip
import re

import config

_FW = str.maketrans("（）", "()")
_SCHOOL_RE = re.compile(r"^(.*?)\((?:구[.．]?)?\s*(.*?)\)$")


def normalize_school(name):
    """(canonical, alias) 반환. alias 없으면 None."""
    n = str(name).strip().translate(_FW)
    m = _SCHOOL_RE.match(n)
    if m:
        canonical = m.group(1).strip()
        alias = m.group(2).strip()
        return (canonical if canonical else n), (alias if alias else None)
    return n, None


# ── union-find ────────────────────────────────────────────────────────
def _find(parent, x):
    root = x
    while parent[root] != root:
        root = parent[root]
    while parent[x] != root:
        parent[x], x = root, parent[x]
    return root


def _union(parent, a, b):
    ra, rb = _find(parent, a), _find(parent, b)
    if ra != rb:
        parent[rb] = ra


def resolve_schools(name_years):
    """name_years: iterable of (raw_name, year).

    반환:
      school_records: [{school_id, canonical, aliases[list], years[sorted list], c100}]
      name_to_id: {raw_name: school_id}  (원본 학교명 문자열 → id)
    """
    # 1) 정규화
    parsed = {}  # raw_name -> (canonical, alias)
    canon_years = {}  # canonical -> set(years)
    canon_aliases = {}  # canonical -> set(alias)
    for raw, year in name_years:
        if raw not in parsed:
            parsed[raw] = normalize_school(raw)
        canonical, alias = parsed[raw]
        canon_years.setdefault(canonical, set())
        if year is not None:
            canon_years[canonical].add(int(str(year)))
        canon_aliases.setdefault(canonical, set())
        if alias:
            canon_aliases[canonical].add(alias)

    canonicals = set(canon_years.keys())

    # 2) union-find: alias 가 다른 canonical 과 일치하면 병합
    parent = {c: c for c in canonicals}
    for canonical, aliases in canon_aliases.items():
        for alias in aliases:
            if alias in canonicals and alias != canonical:
                _union(parent, canonical, alias)

    # 3) 그룹핑
    groups = {}  # root -> set(canonical)
    for c in canonicals:
        groups.setdefault(_find(parent, c), set()).add(c)

    # 4) 대표 canonical 선정: 최신 연도 max 우선, 동률이면 문자열
    cohort_norm = {normalize_school(n)[0] for n in _load_cohort100()}

    reps = []
    for root, members in groups.items():
        def _key(c):
            yrs = canon_years.get(c, set())
            return (max(yrs) if yrs else -1, c)
        rep = max(members, key=_key)
        years = set()
        aliases = set()
        c100 = False
        for c in members:
            years |= canon_years.get(c, set())
            aliases |= canon_aliases.get(c, set())
            if c in cohort_norm:
                c100 = True
        # 대표명 자신은 aliases 에서 제외, 병합된 옛 canonical 은 alias 로 추가
        aliases |= (members - {rep})
        aliases.discard(rep)
        if any(a in cohort_norm for a in aliases):
            c100 = True
        reps.append({"rep": rep, "members": members, "years": years,
                     "aliases": aliases, "c100": c100})

    # 5) school_id 부여 — 대표명 정렬 안정
    reps.sort(key=lambda r: r["rep"])
    school_records = []
    canon_to_id = {}
    for i, r in enumerate(reps, start=1):
        sid = i
        for c in r["members"]:
            canon_to_id[c] = sid
        school_records.append({
            "school_id": sid,
            "canonical": r["rep"],
            "aliases": sorted(r["aliases"]),
            "years": sorted(r["years"]),
            "c100": r["c100"],
        })

    # 6) raw_name -> id
    name_to_id = {}
    for raw, (canonical, _alias) in parsed.items():
        name_to_id[raw] = canon_to_id[canonical]

    return school_records, name_to_id


def _load_cohort100():
    import json
    path = config.INTERIM_DIR / "headers.json"
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("cohort100", [])
    except FileNotFoundError:
        return []


# ── tidy 적재 여부 ─────────────────────────────────────────────────────
def _base_key(key):
    return key.split("#", 1)[0]


def load_to_tidy(side, key):
    """equal 중복열은 첫 열만 tidy 에 적재(#n 은 검증 전용). split/단일은 전부 적재."""
    res = config.DUP_RESOLUTION.get(side, {}).get(_base_key(key))
    if res == "equal" and "#" in key:
        return False
    return True


def _to_amount(v):
    if v is None or v == "":
        return ""
    try:
        return int(round(float(v)))
    except (ValueError, TypeError):
        return ""


def run(extracted, registry, write=True):
    """extracted: {'in':(headers,rows), 'ex':(headers,rows)}, registry: accounts dict.

    반환: (school_records, name_to_id, stats)
    """
    # 학교 목록 수집 (양측 통합)
    name_years = []
    for side in ("in", "ex"):
        _, rows = extracted[side]
        for r in rows:
            name_years.append((r[1], r[0]))
    school_records, name_to_id = resolve_schools(name_years)

    config.INTERIM_DIR.mkdir(parents=True, exist_ok=True)

    if write:
        _write_schools(school_records)

    # tidy 적재 대상 컬럼 목록 (side별 (account_key, col_idx))
    tidy_cols = {
        side: [(a["code"], a["col_idx"]) for a in registry[side] if load_to_tidy(side, a["code"])]
        for side in ("in", "ex")
    }

    n_rows = 0
    if write:
        path = config.INTERIM_DIR / "tidy.csv.gz"
        with gzip.open(path, "wt", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(["year", "school_id", "side", "account_key", "amount"])
            for side in ("in", "ex"):
                _, rows = extracted[side]
                cols = tidy_cols[side]
                for r in rows:
                    year = int(str(r[0]))
                    sid = name_to_id[r[1]]
                    for key, ci in cols:
                        amt = _to_amount(r[ci])
                        w.writerow([year, sid, side, key, amt])
                        n_rows += 1

    stats = {
        "n_schools": len(school_records),
        "n_c100": sum(1 for s in school_records if s["c100"]),
        "tidy_rows": n_rows,
    }
    return school_records, name_to_id, stats


def _write_schools(school_records):
    path = config.INTERIM_DIR / "schools.csv"
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["school_id", "canonical", "aliases", "years", "c100"])
        for s in school_records:
            w.writerow([
                s["school_id"],
                s["canonical"],
                ";".join(s["aliases"]),
                ";".join(str(y) for y in s["years"]),
                "1" if s["c100"] else "0",
            ])


def load_school_map():
    """schools.csv → {name: school_id} (canonical + aliases 포함). validate 용."""
    path = config.INTERIM_DIR / "schools.csv"
    m = {}
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            sid = int(row["school_id"])
            m[row["canonical"]] = sid
            for a in row["aliases"].split(";"):
                if a:
                    m[a] = sid
    return m


if __name__ == "__main__":
    import extract
    import accounts

    ex = extract.extract_all()
    reg = accounts.build_all(ex["in"][0], ex["ex"][0])
    recs, nmap, stats = run(ex, reg)
    print("schools:", stats)
