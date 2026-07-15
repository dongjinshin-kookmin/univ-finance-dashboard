# -*- coding: utf-8 -*-
"""ETL CLI: extract → accounts → transform → validate 순차 실행.

단계별 소요·요약을 stdout 에 출력한다. S1 표본 검증 실패 시 비제로 종료.
사용: python3 etl/run_etl.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config
import extract
import accounts
import transform
import validate
import build_json


def _step(label, fn):
    t0 = time.time()
    r = fn()
    print(f"  [{label}] {time.time() - t0:.2f}s")
    return r


def main():
    print("=== 교비회계 자금계산서 ETL ===")
    print(f"원본: {config.XLSX_PATH.name}")

    ex = _step("extract", extract.extract_all)
    print(f"    수입 {len(ex['in'][0])}열 x {len(ex['in'][1])}행 / "
          f"지출 {len(ex['ex'][0])}열 x {len(ex['ex'][1])}행")

    reg = _step("accounts", lambda: accounts.build_all(ex["in"][0], ex["ex"][0]))
    print(f"    계정 수입 {len(reg['in'])} / 지출 {len(reg['ex'])}")

    recs, nmap, stats = _step("transform", lambda: transform.run(ex, reg))
    print(f"    학교 {stats['n_schools']}교 (100코호트 {stats['n_c100']}) / "
          f"tidy {stats['tidy_rows']:,}행")

    report, s1_ok = _step("validate", lambda: validate.run(ex, reg, nmap, recs))

    print("\n=== 검증 요약 ===")
    for name, r in report["identities"].items():
        rate = f"{r['rate']*100:.2f}%" if r["rate"] is not None else "n/a"
        print(f"  {name}: {r['pass']}/{r['total']} 통과 ({rate})")
    s3 = report["S3_parent_sum"]
    s3rate = f"{s3['rate']*100:.2f}%" if s3["rate"] is not None else "n/a"
    print(f"  S3 부모=자식합: {s3['ok']}/{s3['total']} ({s3rate})")
    dupch = report["S2_dup_probe"]["config_changes"]
    print(f"  S2 dup-probe config 수정: {len(dupch)}건"
          + ("" if not dupch else " " + str(dupch)))
    print(f"  S1 표본: {'PASS' if s1_ok else 'FAIL'}")

    js = _step("build_json", build_json.run)
    print(f"    full {js['full_size']/1e6:.2f}MB / lite {js['lite_size']/1e6:.2f}MB"
          f" / rows {js['n_rows']} / 미조인 {js['unmatched']}교")
    if js["missing_keys"]:
        print(f"    ⚠ 0 처리된 산식 키: {js['missing_keys']}")
    cov = " ".join(f"{k}={v*100:.1f}%" for k, v in js["ext_cov"].items())
    print(f"    ext 커버리지: {cov}")
    print(f"    ext closure_traj 표본: {js['closure_n']}교")

    print("\n산출물:")
    for p in ("accounts.json", "schools.csv", "tidy.csv.gz",
              "validation_report.json", "validation_report.md"):
        fp = config.INTERIM_DIR / p
        mark = "OK" if fp.exists() else "MISSING"
        print(f"  [{mark}] {fp}")
    for fp in (js["full_path"], js["lite_path"]):
        mark = "OK" if fp.exists() else "MISSING"
        print(f"  [{mark}] {fp}")

    if not s1_ok:
        print("\nS1 표본 검증 실패 → 비제로 종료", file=sys.stderr)
        sys.exit(1)
    print("\n완료.")


if __name__ == "__main__":
    main()
