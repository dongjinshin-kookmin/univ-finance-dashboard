# -*- coding: utf-8 -*-
"""KPI 스팟체크(읽기 전용).

국민대 + 임의 타대학 2교(가천대·조선대)의 지정 연도 원값 및 KPI 10종을 출력한다.
등록금의존율_총계(=5100/T_IN)는 손계산과 대조 표시한다.
tidy.csv.gz 만 읽으며 어떤 산출물도 쓰지 않는다.
"""
import csv
import gzip

import config
import metrics

TARGETS = {
    "국민대학교": [2016, 2020, 2024],
    "가천대학교": [2016, 2020, 2024],
    "조선대학교": [2016, 2020, 2024],
}
FOCUS_KEYS = [("in", "5100"), ("in", "T_IN"), ("in", "OP_IN"),
              ("ex", "4100"), ("ex", "CF_NEXT")]


def _load():
    schools = {}
    with open(config.INTERIM_DIR / "schools.csv", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            schools[row["canonical"]] = int(row["school_id"])

    lookup = {}
    with gzip.open(config.INTERIM_DIR / "tidy.csv.gz", "rt", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            amt = row["amount"]
            if amt in ("", None):
                continue
            key = (int(row["school_id"]), int(row["year"]))
            lookup.setdefault(key, {"in": {}, "ex": {}})[row["side"]][
                row["account_key"]
            ] = int(round(float(amt)))
    return schools, lookup


def run():
    schools, lookup = _load()
    compiled = metrics.compile_formulas(config.KPI_FORMULAS)

    for name, years in TARGETS.items():
        sid = schools.get(name)
        print(f"\n=== {name} (school_id={sid}) ===")
        if sid is None:
            print("  (schools.csv 미존재)")
            continue
        for yr in years:
            cell = lookup.get((sid, yr))
            print(f"  [{yr}]")
            if not cell:
                print("    데이터 없음")
                continue

            def getval(side, key, _c=cell):
                return _c[side].get(key)

            for side, key in FOCUS_KEYS:
                print(f"    {side}.{key} = {getval(side, key)}")

            kpis = metrics.compute_kpis(getval, compiled)
            for kname, kval in kpis.items():
                print(f"    KPI {kname} = {kval}")

            # 손계산 대조: 등록금의존율_총계 = in.5100 / in.T_IN
            num = getval("in", "5100")
            den = getval("in", "T_IN")
            hand = round(num / den, 4) if (num is not None and den) else None
            match = "OK" if hand == kpis["등록금의존율_총계"] else "MISMATCH"
            print(f"    ↳ 손계산 5100/T_IN = {hand}  [{match}]")


if __name__ == "__main__":
    run()
