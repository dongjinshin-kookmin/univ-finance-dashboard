"""test_sim_isomorphism.py — D4 JS↔파이썬 수치 동형성 검증.

dashboard/src/sim_model.js(JS 엔진)와 etl/sim_reference.py(파이썬 참조)가 동일 입력에
대해 상대 1e-9 이내로 일치하는지 검증한다. 부동소수점 연산 순서 차이만 허용.

절차:
  1. 학교 표본(국민대 + 유형별·폴백·no_ug·미충원·정원초과 등 14교)
     × 파라미터 그리드(r×fillMode×piMode×lambda×gamma = 72) = 전 조합.
  2. 노드 하니스(scratchpad)로 sim_model.js의 project+recalcSeries를 실행 → 결과 JSON.
  3. 동일 job을 sim_reference.py로 계산 → 필드별 심층 비교(상대 1e-9).
  4. 시나리오 3종·잔차밴드 스모크 비교(국민대·미충원 각 1교).

실행: python3 etl/test_sim_isomorphism.py
"""

import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "etl"))

import sim_reference as ref  # noqa: E402

SIM_JS = os.path.join(ROOT, "dashboard", "src", "sim_model.js")
SIM_PARAMS = os.path.join(ROOT, "build", "interim", "sim_params.json")
DATA = os.path.join(ROOT, "build", "dashboard_data.json")

REL_TOL = 1e-9      # 상대 허용 오차
ABS_TOL = 1e-12     # 0 근방 절대 허용 오차

# ── 학교 표본(특성 커버리지) ────────────────────────────────────────────────
# 52 국민대(ok/대학/파생) · 0 가야대(미충원) · 2 가톨릭관동대(심한 미충원)
# 3·14 정원초과(fMaxEff 가드) · 5 전문대학 · 17 사이버대학(미충원)
# 12·15 no_ug(대학원대학) · 33·46·64 폴백(그룹) · 38 폴백(전역) · 20 경남대(미충원)
SAMPLE_IDX = [52, 0, 2, 3, 14, 5, 17, 12, 15, 33, 46, 64, 38, 20]

# ── 파라미터 그리드 (전 조합) ──────────────────────────────────────────────
GRID_R = [0, 0.1, 0.3]
GRID_FILL = ["conservative", "realistic"]
GRID_PI = ["freeze", "cap", "half"]
GRID_LAMBDA = [0, 0.5]        # 드리프트 off/on
GRID_GAMMA = [0, 0.15]


# ── 보충 조합: 기본 그리드가 안 건드리는 분기·보정을 모두 자극 ─────────────
#  (dropout 스트레스[보정4] · beta 양끝 · profile linear · rSchedule · custom π ·
#   capCarryForward=False[보정2 반대분기] · gammaLabor 분리 · fMax 오버라이드)
SUPP_IDX = [52, 0, 2, 3]        # 국민대 + 미충원2 + 정원초과1(fMaxEff)
SUPP_PARAMS = [
    {"r": 0.2, "t0": 2025, "horizon": 10, "dropout": 0.1},                          # 보정4 dropout
    {"r": 0.2, "t0": 2025, "horizon": 10, "beta": 0.0, "fillMode": "realistic"},    # beta 하한
    {"r": 0.2, "t0": 2025, "horizon": 10, "beta": 1.0, "fillMode": "realistic"},    # beta 상한
    {"r": 0.3, "t0": 2027, "horizon": 8, "profile": "linear", "rampYears": 4},       # 선형 램프 + t0 이동
    {"r": 0.3, "t0": 2025, "horizon": 10, "rSchedule": {"2026": 0.1, "2028": 0.25}}, # 명시 스케줄
    {"r": 0.2, "t0": 2025, "horizon": 10, "piMode": "custom", "piRate": 0.03},        # custom π
    {"r": 0.2, "t0": 2025, "horizon": 12, "piMode": "cap", "capCarryForward": False}, # 보정2 반대분기
    {"r": 0.2, "t0": 2025, "horizon": 10, "gamma": 0.15, "gammaLabor": 0.0},          # 인건비 경직 분리
    {"r": 0.2, "t0": 2025, "horizon": 10, "gamma": 0.5, "gammaLabor": 0.3},           # gammaLabor 분리2
    {"r": 0.2, "t0": 2025, "horizon": 10, "lambda": 1.0, "piMode": "half"},           # λ 최대 + half
    {"r": 0.15, "t0": 2025, "horizon": 10, "fMax": 0.8, "fillMode": "realistic"},     # fMax<f0 → fMaxEff 가드
    {"r": 0.15, "t0": 2025, "horizon": 10, "eta5120": 0.5, "piMode": "cap"},          # 5120 탄력 상한
]


def build_jobs(sim, schools):
    jobs = []
    for idx in SAMPLE_IDX:
        e = sim["bySchool"].get(str(idx))
        if e is None:
            continue
        sido = (schools[idx] or {}).get("sido")
        for r in GRID_R:
            for fill in GRID_FILL:
                for pi in GRID_PI:
                    for lam in GRID_LAMBDA:
                        for g in GRID_GAMMA:
                            params = {
                                "r": r, "t0": 2025, "horizon": 10,
                                "fillMode": fill, "piMode": pi,
                                "lambda": lam, "gamma": g,
                            }
                            jobs.append({"idx": idx, "sido": sido, "params": params})
    n_main = len(jobs)
    # 보충 조합
    for idx in SUPP_IDX:
        if sim["bySchool"].get(str(idx)) is None:
            continue
        sido = (schools[idx] or {}).get("sido")
        for p in SUPP_PARAMS:
            jobs.append({"idx": idx, "sido": sido, "params": dict(p)})
    return jobs, n_main


NODE_HARNESS = r"""
'use strict';
var fs = require('fs');
var SIM = require(process.argv[2]);
var jobs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
var sim = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));

var out = jobs.map(function (job) {
  var school = sim.bySchool[String(job.idx)];
  var opts = { meta: sim.meta, sido: job.sido };
  var proj = SIM.project(school, job.params, opts);
  var kpis = SIM.recalcSeries(school, proj, job.params, opts);   // proj.meta.gammaGeneral 주입
  return { proj: proj, kpis: kpis };
});
process.stdout.write(JSON.stringify(out));
"""

SCEN_HARNESS = r"""
'use strict';
var fs = require('fs');
var SIM = require(process.argv[2]);
var spec = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
var sim = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
var out = spec.map(function (s) {
  var school = sim.bySchool[String(s.idx)];
  var opts = { meta: sim.meta, sido: s.sido };
  var sc = SIM.scenarios(school, s.userParams, opts);
  var band = SIM.residualBand(
    sc.base.projection.rows.map(function (r) { return r.lvl5110; }), school.bt);
  return { scenarios: sc, band: band };
});
process.stdout.write(JSON.stringify(out));
"""


def run_node(harness_src, spec, sim_path):
    """노드 하니스를 실행해 결과 JSON을 반환."""
    with tempfile.TemporaryDirectory() as td:
        hpath = os.path.join(td, "harness.js")
        spath = os.path.join(td, "spec.json")
        with open(hpath, "w", encoding="utf-8") as f:
            f.write(harness_src)
        with open(spath, "w", encoding="utf-8") as f:
            json.dump(spec, f, ensure_ascii=False)
        res = subprocess.run(
            ["node", hpath, SIM_JS, spath, sim_path],
            capture_output=True, text=True,
        )
        if res.returncode != 0:
            raise RuntimeError("node 실패:\n" + res.stderr)
        return json.loads(res.stdout)


# ── 심층 비교 ────────────────────────────────────────────────────────────
def approx(a, b):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, str) or isinstance(b, str):
        return a == b
    diff = abs(a - b)
    if diff <= ABS_TOL:
        return True
    scale = max(abs(a), abs(b))
    return (diff / scale) <= REL_TOL


def deep_diff(js, py, path, diffs):
    """구조를 재귀 순회하며 불일치를 diffs에 수집."""
    if isinstance(js, dict) or isinstance(py, dict):
        if not (isinstance(js, dict) and isinstance(py, dict)):
            diffs.append((path, "type", js, py))
            return
        keys = set(js.keys()) | set(py.keys())
        for k in keys:
            if k not in js:
                diffs.append((path + "." + k, "missing-in-js", None, py[k]))
            elif k not in py:
                diffs.append((path + "." + k, "missing-in-py", js[k], None))
            else:
                deep_diff(js[k], py[k], path + "." + k, diffs)
        return
    if isinstance(js, list) or isinstance(py, list):
        if not (isinstance(js, list) and isinstance(py, list)) or len(js) != len(py):
            diffs.append((path, "list-shape", js, py))
            return
        for i, (a, b) in enumerate(zip(js, py)):
            deep_diff(a, b, path + "[%d]" % i, diffs)
        return
    if not approx(js, py):
        diffs.append((path, "value", js, py))


def strip_params(node):
    """비교에서 제외할 입력 에코(params) 제거 — undefined 직렬화 차이 회피."""
    if isinstance(node, dict):
        node.pop("params", None)


def main():
    sim = json.load(open(SIM_PARAMS, encoding="utf-8"))
    doc = json.load(open(DATA, encoding="utf-8"))
    schools = doc["schools"]

    jobs, n_main = build_jobs(sim, schools)
    n_supp = len(jobs) - n_main
    print("매트릭스: [기본] 학교 %d교 × 파라미터 %d조합 = %d job  +  [보충] %d job  =  총 %d job"
          % (len(SAMPLE_IDX), n_main // len(SAMPLE_IDX), n_main, n_supp, len(jobs)))

    js_results = run_node(NODE_HARNESS, jobs, SIM_PARAMS)
    assert len(js_results) == len(jobs), "노드 결과 개수 불일치"

    # 비교 대상 수치 필드 개수(리프) 카운트 + 불일치 수집
    total_match = 0
    total_mismatch = 0
    fail_cases = []
    for job, jr in zip(jobs, js_results):
        school = sim["bySchool"][str(job["idx"])]
        opts = {"meta": sim["meta"], "sido": job["sido"]}
        proj = ref.project(school, job["params"], opts)
        kpis = ref.recalc_series(school, proj, job["params"], opts)

        js_proj = jr["proj"]
        js_kpis = jr["kpis"]
        strip_params(js_proj)
        strip_params(proj)

        diffs = []
        deep_diff(js_proj, proj, "proj", diffs)
        deep_diff(js_kpis, kpis, "kpis", diffs)

        if diffs:
            total_mismatch += 1
            fail_cases.append({"job": job, "diffs": diffs[:8], "n": len(diffs)})
        else:
            total_match += 1

    print("\n=== project + recalcSeries 동형성 ===")
    print("일치 job: %d / %d  (일치율 %.4f%%)"
          % (total_match, len(jobs), 100.0 * total_match / len(jobs)))

    if fail_cases:
        print("\n불일치 케이스 %d건:" % len(fail_cases))
        for fc in fail_cases[:20]:
            j = fc["job"]
            print("  idx=%d %s  불일치 %d항:"
                  % (j["idx"], json.dumps(j["params"], ensure_ascii=False), fc["n"]))
            for path, kind, a, b in fc["diffs"]:
                print("     %-40s %-14s js=%r py=%r" % (path, kind, a, b))

    # ── 시나리오 3종 + 잔차밴드 스모크 ─────────────────────────────────────
    scen_spec = [
        {"idx": 52, "sido": schools[52].get("sido"),
         "userParams": {"r": 0.1, "t0": 2025, "horizon": 10}},
        {"idx": 2, "sido": schools[2].get("sido"),
         "userParams": {"r": 0.3, "t0": 2025, "horizon": 10, "lambda": 0.5}},
    ]
    js_scen = run_node(SCEN_HARNESS, scen_spec, SIM_PARAMS)
    scen_match = 0
    scen_diffs_all = []
    for spec, jsr in zip(scen_spec, js_scen):
        school = sim["bySchool"][str(spec["idx"])]
        opts = {"meta": sim["meta"], "sido": spec["sido"]}
        py_sc = ref.scenarios(school, spec["userParams"], opts)
        py_band = ref.residual_band(
            [row["lvl5110"] for row in py_sc["base"]["projection"]["rows"]], school.get("bt"))
        # params 제거 후 비교
        for key in py_sc:
            strip_params(py_sc[key]["projection"])
            strip_params(jsr["scenarios"][key]["projection"])
        diffs = []
        deep_diff(jsr["scenarios"], py_sc, "scen", diffs)
        deep_diff(jsr["band"], py_band, "band", diffs)
        if diffs:
            scen_diffs_all.append({"idx": spec["idx"], "diffs": diffs[:8], "n": len(diffs)})
        else:
            scen_match += 1

    print("\n=== scenarios + residualBand 스모크 ===")
    print("일치: %d / %d" % (scen_match, len(scen_spec)))
    for sd in scen_diffs_all:
        print("  idx=%d 불일치 %d항:" % (sd["idx"], sd["n"]))
        for path, kind, a, b in sd["diffs"]:
            print("     %-40s %-14s js=%r py=%r" % (path, kind, a, b))

    ok = (total_mismatch == 0) and (scen_match == len(scen_spec))
    print("\n결과: " + ("전체 동형 (PASS)" if ok else "불일치 존재 (FAIL)"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
