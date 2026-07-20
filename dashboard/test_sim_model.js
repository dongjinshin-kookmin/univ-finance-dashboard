/* test_sim_model.js — sim_model.js 검증 하니스 (node 실행).
 *   node dashboard/test_sim_model.js
 * sim_params.json(전 학교 파라미터)을 로드해 국민대(idx 52) 스팟체크 4건 + 부가 무결성 검사.
 * 검증 항목(설계·WBS B 검증 요구):
 *   (a) r=0 → 모든 델타=0 · KPI 원값 보존
 *   (b) r=10%·β=0(보수)·π=0 정착상태(t0+10) Δ5112 ≈ −0.10·p_ug·m_in·A_in  (해석적)
 *   (c) no_ug 학교(대학원대학) → 델타 0
 *   (d) φ 경계: |Δ5112| ≤ φ_in·5110 (반응수입 초과 불가), r=1에서 φ_in·5112에 수렴
 * 브라우저: test_sim_model.html이 동일 로직을 페이지에 출력.
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var SIM = require('./src/sim_model.js');
var sim = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/interim/sim_params.json'), 'utf8'));
var doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/dashboard_data.json'), 'utf8'));
var schools = doc.schools;
var meta = sim.meta;

// KMU 인덱스 확정
var KMU = 52;
if (!(schools[KMU] && /국민대/.test(schools[KMU].n))) {
  KMU = schools.findIndex(function (s) { return s.kmu || /국민대학교/.test(s.n); });
}
var kmu = sim.bySchool[String(KMU)];
var optsK = { meta: meta, sido: schools[KMU].sido };

var results = [];
function check(name, pass, detail) {
  results.push({ name: name, pass: pass, detail: detail });
}
function approx(a, b, rel) { return Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)); }
function maxAbs(arr) { return arr.reduce(function (m, x) { return Math.max(m, Math.abs(x || 0)); }, 0); }

// ── (a) r=0 → 델타 0, KPI 원값 보존 ─────────────────────────────────
(function () {
  var proj = SIM.project(kmu, { r: 0, t0: 2025 }, optsK);
  var kseries = SIM.recalcSeries(kmu, proj, { r: 0, t0: 2025 }, optsK);
  var maxD = Math.max(
    maxAbs(proj.rows.map(function (r) { return r.d5100; })),
    maxAbs(proj.rows.map(function (r) { return r.dH_ug_in; })),
    maxAbs(proj.rows.map(function (r) { return r.dA_in; }))
  );
  var kpiMaxD = 0;
  kseries.forEach(function (k) {
    for (var name in k.delta) if (k.delta[name] != null) kpiMaxD = Math.max(kpiMaxD, Math.abs(k.delta[name]));
  });
  var pass = maxD === 0 && kpiMaxD === 0;
  check('(a) r=0 → 델타·KPI델타 = 0', pass,
    'max|Δ수입/ΔH/ΔA| = ' + maxD + ' 천원, max|ΔKPI| = ' + kpiMaxD);
})();

// ── (b) r=10% 보수·π=0 정착상태 해석적 검증 ───────────────────────────
(function () {
  var t0 = 2025;
  var proj = SIM.project(kmu, { r: 0.10, t0: t0, fillMode: 'conservative', piMode: 'freeze', horizon: 10 }, optsK);
  var p_ug = kmu.price.p_ug, m_in = kmu.surv.m_in, A_in = kmu.seg.A_in;
  var expected = -0.10 * p_ug * m_in * A_in;                 // −0.10·p_ug·m_in·A_in
  var settled = proj.rows[proj.rows.length - 1].d5112;       // t0+10, 완전 정착
  var pass = approx(settled, expected, 0.01);                 // 1% (Σs_k↔m_in 반올림·꼬리절단)
  check('(b) 정착 Δ5112 ≈ −0.10·p_ug·m_in·A_in', pass,
    'model=' + Math.round(settled) + ' vs analytic=' + Math.round(expected) +
    ' (오차 ' + (100 * Math.abs(settled - expected) / Math.abs(expected)).toFixed(3) + '%)' +
    '  [p_ug=' + p_ug + ' m_in=' + m_in + ' A_in=' + A_in + ']');
})();

// ── (c) no_ug 학교 → 델타 0 ──────────────────────────────────────────
(function () {
  var idx = Object.keys(sim.bySchool).find(function (i) {
    return (sim.bySchool[i].flags || {}).status === 'no_ug';
  });
  var e = sim.bySchool[idx];
  var opts = { meta: meta, sido: schools[+idx].sido };
  var proj = SIM.project(e, { r: 0.30, t0: 2025 }, opts);   // 큰 감축에도 반응 0이어야
  var kseries = SIM.recalcSeries(e, proj, { r: 0.30, t0: 2025 }, opts);
  var maxD = maxAbs(proj.rows.map(function (r) { return r.d5100; }));
  var kpiMaxD = 0;
  kseries.forEach(function (k) { for (var name in k.delta) if (k.delta[name] != null) kpiMaxD = Math.max(kpiMaxD, Math.abs(k.delta[name])); });
  var pass = !proj.responsive && maxD === 0 && kpiMaxD === 0;
  check('(c) no_ug 학교 델타 0 (idx ' + idx + ' ' + schools[+idx].n + ')', pass,
    'responsive=' + proj.responsive + '  max|Δ수입|=' + maxD + '  max|ΔKPI|=' + kpiMaxD);
})();

// ── (d) φ 경계: |Δ5112| ≤ φ_in·5110, r=1에서 φ_in·5112 수렴 ───────────
(function () {
  var proj = SIM.project(kmu, { r: 1.0, t0: 2025, fillMode: 'conservative', piMode: 'freeze', horizon: 10 }, optsK);
  var phi_in = kmu.phi.in;
  var c5110 = (kmu.base.c5111 || 0) + (kmu.base.c5112 || 0);
  var c5112 = kmu.base.c5112;
  var bound5110 = phi_in * c5110;
  var responsiveRev = phi_in * c5112;                        // R_in (정원 감축 반응 가능 수입)
  var maxLoss = maxAbs(proj.rows.map(function (r) { return r.d5112; }));
  var settledLoss = -proj.rows[proj.rows.length - 1].d5112;   // r=1 정착 → R_in에 수렴
  var withinBound = proj.rows.every(function (r) { return Math.abs(r.d5112) <= bound5110 + 1; });
  var converge = approx(settledLoss, responsiveRev, 0.01);
  var pass = withinBound && converge;
  check('(d) φ 경계: |Δ5112| ≤ φ_in·5110, r=1 → φ_in·5112', pass,
    'max|Δ5112|=' + Math.round(maxLoss) + ' ≤ φ_in·5110=' + Math.round(bound5110) +
    ' | r=1정착손실=' + Math.round(settledLoss) + ' vs R_in(φ_in·5112)=' + Math.round(responsiveRev) +
    ' (오차 ' + (100 * Math.abs(settledLoss - responsiveRev) / responsiveRev).toFixed(3) + '%)');
})();

// ── 부가: 시나리오 3종 + 잔차 밴드(bt null 생략) 스모크 ────────────────
(function () {
  var sc = SIM.scenarios(kmu, { r: 0.10, t0: 2025, horizon: 10 }, optsK);
  var lastLvl = function (key) { return sc[key].projection.rows[sc[key].projection.rows.length - 1].lvl5100; };
  // 팬차트 레벨 5100': 낙관(β=1·법정상한 단가방어) ≥ 기준 ≥ 비관(고정·동결) — 단가 방어가 레벨에 반영
  var lOpt = lastLvl('optimistic'), lBase = lastLvl('base'), lPess = lastLvl('pessimistic');
  var ordered = lOpt >= lBase - 1 && lBase >= lPess - 1;
  var band = SIM.residualBand(sc.base.projection.rows.map(function (r) { return r.lvl5110; }), kmu.bt);
  var bandOK = band.omitted === true && kmu.bt === null;      // 현재 bt=null → 생략 플래그
  check('(부가) 시나리오 레벨 순서 낙관≥기준≥비관 + bt=null 밴드 생략', ordered && bandOK,
    '5100\' 레벨(t0+10): 낙관=' + Math.round(lOpt) + ' 기준=' + Math.round(lBase) + ' 비관=' + Math.round(lPess) +
    ' | band.omitted=' + band.omitted);
})();

// ── 출력 ─────────────────────────────────────────────────────────────
console.log('=== sim_model.js 검증 (KMU idx ' + KMU + ' = ' + schools[KMU].n + ', base ' + kmu.flags.year + ') ===\n');
var allPass = true;
results.forEach(function (r) {
  allPass = allPass && r.pass;
  console.log((r.pass ? '  PASS ' : '  FAIL ') + r.name);
  console.log('        ' + r.detail);
});
console.log('\n결과: ' + results.filter(function (r) { return r.pass; }).length + '/' + results.length +
  ' 통과 → ' + (allPass ? '전체 통과' : '실패 존재'));
process.exit(allPass ? 0 : 1);
