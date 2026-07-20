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
var calib = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/interim/closure_calib.json'), 'utf8'));

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

// ══════════════════════════════════════════════════════════════════════
//  B5·B6 — 폐교(존속) 위험 판정 검증 (설계 §2·§4·§5, WBS B5+B6 검증 요구 a~e)
// ══════════════════════════════════════════════════════════════════════
var RISKPLUS = { atrisk: true, critical: true };   // 위험+ = 위험 ∪ 심각

// (a) 국민대 r=0 → 안정 + runway 무한(설계 §5: 기존 crisis 55.8 "주의" 오분류 교정 확인)
(function () {
  var proj = SIM.project(kmu, { r: 0, t0: 2025, horizon: 10 }, optsK);
  var g = SIM.closureGrade(kmu, proj, optsK);
  var pass = g.grade === 'stable' && g.runwayYears === Infinity;
  check('(폐a) 국민대 r=0 → 안정 · runway ∞ (crisis 오분류 교정)', pass,
    'grade=' + g.grade + ' runway=' + g.runwayYears + ' M=' + (g.marginEnd * 100).toFixed(2) + '% fill=' + g.fill.toFixed(3));
})();

// (b) 폐교교 T-1(재무 결측 시 마지막 관측연도 T-2 fallback) 관측 판정 → 4년제 4/4 위험+
//     projection=null 관측 모드. 민감도 게이트(설계 §5 D6 ≥4/5) 사전 확인.
(function () {
  var uni4 = [], detail = [];
  calib.positives.forEach(function (p) {
    var t1 = p.T1, t2 = p.T2 || {};
    var obs = {
      fill:          t1['충원율']    != null ? t1['충원율']    : t2['충원율'],
      marginRate:    t1['운영수지율'] != null ? t1['운영수지율'] : t2['운영수지율'],   // 재무 결측 → T-2
      reserveMonths: t1['적립금월수'] != null ? t1['적립금월수'] : t2['적립금월수'],
      reserveAvail:  t1.reserve_avail != null ? t1.reserve_avail : t2.reserve_avail
    };
    var sSim = sim.bySchool[String(p.idx)] || { stock: {}, flags: {} };
    var g = SIM.closureGrade(sSim, null, { obs: obs, type: p.school_type, noUg: p.no_ug, obsYear: t1.year });
    if (p.school_type === '대학') uni4.push({ n: p.school, g: g.grade, ok: !!RISKPLUS[g.grade] });
    detail.push(p.school.replace('학교', '') + '=' + g.grade);
  });
  var hit = uni4.filter(function (x) { return x.ok; }).length;
  var pass = uni4.length === 4 && hit === 4;
  check('(폐b) 폐교교 관측 판정 → 4년제 ' + hit + '/4 위험+ (민감도 게이트)', pass,
    detail.join(' · '));
})();

// (c) r 증가 시 전국 atRiskOrWorse 단조 비감소(집계 정합)
(function () {
  var aggOpts = { meta: meta, schools: schools };
  var rs = [0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50];
  var seq = [], mono = true, prev = -1;
  rs.forEach(function (r) {
    var agg = SIM.closureAggregate(sim, { r: r, t0: 2025, horizon: 10 }, aggOpts);
    seq.push(agg.atRiskOrWorse);
    if (agg.atRiskOrWorse < prev) mono = false;
    prev = agg.atRiskOrWorse;
  });
  check('(폐c) r↑ → atRiskOrWorse 단조 비감소', mono,
    'N(위험+) @ r' + JSON.stringify(rs) + ' = ' + JSON.stringify(seq));
})();

// (d) 생존 대조군(설계 §5): 총신대 ≤주의 · 선린대 주의 · 상지대 위험+(감축 스트레스 트로프)
(function () {
  function survObs(idx, name) {
    var s = calib.survivors.filter(function (x) { return x.school.indexOf(name) === 0; })[0];
    var sn = s.snapshot;
    var g = SIM.closureGrade(sim.bySchool[String(s.idx)], null,
      { obs: { fill: sn['충원율'], marginRate: sn['운영수지율'], reserveMonths: sn['적립금월수'], reserveAvail: sn.reserve_avail },
        type: schools[s.idx].type, obsYear: sn.year });
    return { idx: s.idx, g: g };
  }
  var rankOf = SIM._util.GRADE_RANK;
  var chongshin = survObs(288, '총신');       // 관측: 안정 (≥+17.6%·월수17.7)
  var seonlin   = survObs(171, '선린');       // 관측: 주의 (−0.9%·R≈68)
  // 상지대: 2024 관측은 흑자(구제 후) → 주의. 설계 §2 "trough R≈0.67" = 감축 스트레스 판정.
  var sangjiObs = survObs(146, '상지');
  var sangji = sangjiObs.idx;
  var pj = SIM.project(sim.bySchool[String(sangji)], { r: 0.15, t0: 2025, horizon: 10 },
    { meta: meta, sido: schools[sangji].sido });
  var sangjiStress = SIM.closureGrade(sim.bySchool[String(sangji)], pj, { meta: meta, sido: schools[sangji].sido });

  var pass = rankOf[chongshin.g.grade] <= rankOf.caution &&
             seonlin.g.grade === 'caution' &&
             !!RISKPLUS[sangjiStress.grade];
  check('(폐d) 총신대 ≤주의 · 선린대 주의 · 상지대 위험+(스트레스)', pass,
    '총신대=' + chongshin.g.grade + ' 선린대=' + seonlin.g.grade +
    ' | 상지대 관측(r0)=' + sangjiObs.g.grade + ' → 감축r0.15=' + sangjiStress.grade +
    ' (M=' + (sangjiStress.marginEnd * 100).toFixed(1) + '%)');
})();

// (e) 344교 스모크: NaN·음수 없음(관측/projection 양경로). unrated는 runway=null 정상.
(function () {
  var bad = [], aggOpts = { meta: meta, schools: schools };
  Object.keys(sim.bySchool).forEach(function (idx) {
    var sSim = sim.bySchool[idx], o = { meta: meta, sido: schools[+idx].sido, type: schools[+idx].type };
    var proj = SIM.project(sSim, { r: 0.2, t0: 2025, horizon: 10 }, o);
    var g = SIM.closureGrade(sSim, proj, o);
    var R = g.runwayYears;
    if (['stable', 'caution', 'atrisk', 'critical', 'unrated'].indexOf(g.grade) < 0) bad.push(idx + ':grade');
    if (g.grade !== 'unrated' && R !== Infinity && (R == null || isNaN(R) || R < 0)) bad.push(idx + ':R=' + R);
    if (g.marginEnd != null && isNaN(g.marginEnd)) bad.push(idx + ':M');
    if (g.fill != null && (isNaN(g.fill) || g.fill < 0)) bad.push(idx + ':fill');
    if (g.reserveMonths != null && (isNaN(g.reserveMonths) || g.reserveMonths < 0)) bad.push(idx + ':mo');
  });
  // 집계 스모크: counts 합 = 344, atRiskRange가 점추정을 브래킷
  var agg = SIM.closureAggregate(sim, { r: 0.2, t0: 2025, horizon: 10 }, aggOpts);
  var sum = agg.counts.stable + agg.counts.caution + agg.counts.atrisk + agg.counts.critical + agg.counts.unrated;
  var bracket = agg.atRiskRange[0] <= agg.atRiskOrWorse && agg.atRiskOrWorse <= agg.atRiskRange[1];
  var pass = bad.length === 0 && sum === Object.keys(sim.bySchool).length && bracket;
  check('(폐e) 344교 스모크: NaN·음수 0 · counts합=' + sum + ' · range 브래킷', pass,
    'bad=' + (bad.length ? bad.slice(0, 5).join(',') : '없음') +
    ' | 위험+=' + agg.atRiskOrWorse + ' range=' + JSON.stringify(agg.atRiskRange));
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
