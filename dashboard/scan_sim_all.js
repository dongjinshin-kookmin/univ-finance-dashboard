#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var SIM = require('./src/sim_model.js');

// 파일 로드
var sim = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/interim/sim_params.json'), 'utf8'));
var doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/dashboard_data.json'), 'utf8'));

var meta = sim.meta;
var bySchool = sim.bySchool;
var schools = doc.schools;

var flagCounts = {
  nan_inf: 0,
  neg_heads: 0,
  r0_delta_nonzero: 0,
  boundary_exceed: 0,
  sign_anomaly: 0
};

var flaggedSchools = [];

// 플래그 함수들
function hasNaNInfinity(proj) {
  for (var i = 0; i < proj.rows.length; i++) {
    var row = proj.rows[i];
    for (var key in row) {
      var v = row[key];
      if (typeof v === 'number' && !isFinite(v)) {
        return true;
      }
    }
  }
  return false;
}

function hasNegativeHeads(proj) {
  for (var i = 0; i < proj.rows.length; i++) {
    var row = proj.rows[i];
    // H_ug_in이 음수인지 확인
    if (row.H_ug_in != null && row.H_ug_in < 0) {
      return true;
    }
  }
  return false;
}

function checkR0Delta(proj) {
  // r=0인데 델타가 0이 아닌 경우
  for (var i = 0; i < proj.rows.length; i++) {
    var row = proj.rows[i];
    var d5112 = row.d5112 || 0;
    var d5100 = row.d5100 || 0;
    var d5120 = row.d5120 || 0;
    if (Math.abs(d5112) > 0.01 || Math.abs(d5100) > 0.01 || Math.abs(d5120) > 0.01) {
      return true;
    }
  }
  return false;
}

function checkBoundaryExceed(proj, schoolSim) {
  var phi_in = schoolSim.phi.in;
  var c5112 = schoolSim.base.c5112 || 0;
  var bound = phi_in * c5112;
  
  for (var i = 0; i < proj.rows.length; i++) {
    var row = proj.rows[i];
    var d5112 = row.d5112 || 0;
    if (Math.abs(d5112) > bound + 1) {
      return true;
    }
  }
  return false;
}

function checkSignAnomaly(proj, r) {
  // r>0인데 Δ5112>0인 경우
  if (r <= 0) return false;
  
  for (var i = 0; i < proj.rows.length; i++) {
    var row = proj.rows[i];
    var d5112 = row.d5112 || 0;
    if (d5112 > 0.01) {
      return true;
    }
  }
  return false;
}

// 각 학교 처리
var schoolIdxs = Object.keys(bySchool).map(Number).sort(function(a,b) { return a-b; });

console.log('Starting scan of ' + schoolIdxs.length + ' schools...');

for (var idx = 0; idx < schoolIdxs.length; idx++) {
  var schIdx = schoolIdxs[idx];
  var schoolSim = bySchool[String(schIdx)];
  var school = schools[schIdx];
  
  if (!schoolSim || !school) continue;
  
  var opts = { meta: meta, sido: school.sido };
  var flags = [];
  
  // (a) r=0 기본
  var proj0 = SIM.project(schoolSim, { r: 0, t0: 2025 }, opts);
  
  if (hasNaNInfinity(proj0)) {
    flags.push('nan_inf');
    flagCounts.nan_inf++;
  }
  if (hasNegativeHeads(proj0)) {
    flags.push('neg_heads');
    flagCounts.neg_heads++;
  }
  if (checkR0Delta(proj0)) {
    flags.push('r0_delta_nonzero');
    flagCounts.r0_delta_nonzero++;
  }
  if (checkBoundaryExceed(proj0, schoolSim)) {
    flags.push('boundary_exceed');
    flagCounts.boundary_exceed++;
  }
  
  // (b) r=0.1 기준 시나리오
  var proj1 = SIM.project(schoolSim, { r: 0.1, t0: 2025, fillMode: 'realistic' }, opts);
  
  if (hasNaNInfinity(proj1)) {
    if (flags.indexOf('nan_inf') < 0) flags.push('nan_inf');
    flagCounts.nan_inf++;
  }
  if (hasNegativeHeads(proj1)) {
    if (flags.indexOf('neg_heads') < 0) flags.push('neg_heads');
    flagCounts.neg_heads++;
  }
  if (checkBoundaryExceed(proj1, schoolSim)) {
    if (flags.indexOf('boundary_exceed') < 0) flags.push('boundary_exceed');
    flagCounts.boundary_exceed++;
  }
  if (checkSignAnomaly(proj1, 0.1)) {
    flags.push('sign_anomaly');
    flagCounts.sign_anomaly++;
  }
  
  // (c) r=0.3 비관적 (γ=0.15)
  var proj3 = SIM.project(schoolSim, { r: 0.3, t0: 2025, gamma: 0.15, fillMode: 'realistic' }, opts);
  
  if (hasNaNInfinity(proj3)) {
    if (flags.indexOf('nan_inf') < 0) flags.push('nan_inf');
    flagCounts.nan_inf++;
  }
  if (hasNegativeHeads(proj3)) {
    if (flags.indexOf('neg_heads') < 0) flags.push('neg_heads');
    flagCounts.neg_heads++;
  }
  if (checkBoundaryExceed(proj3, schoolSim)) {
    if (flags.indexOf('boundary_exceed') < 0) flags.push('boundary_exceed');
    flagCounts.boundary_exceed++;
  }
  if (checkSignAnomaly(proj3, 0.3)) {
    flags.push('sign_anomaly');
    flagCounts.sign_anomaly++;
  }
  
  // 플래그가 있으면 기록
  if (flags.length > 0) {
    flaggedSchools.push({
      idx: schIdx,
      canonical: school.n,
      flags: flags
    });
  }
}

// 결과 생성
var output = [];
output.push('=== 전 학교 시뮬레이션 회귀 스캔 ===');
output.push('');
output.push('스캔 일시: ' + new Date().toISOString());
output.push('총 학교 수: ' + schoolIdxs.length);
output.push('');
output.push('--- 플래그 요약 ---');
output.push('NaN/Infinity 존재: ' + flagCounts.nan_inf);
output.push('음수 재학생: ' + flagCounts.neg_heads);
output.push('r=0인데 델타≠0: ' + flagCounts.r0_delta_nonzero);
output.push('경계 초과 (|Δ5112|>φ_in×c5112): ' + flagCounts.boundary_exceed);
output.push('델타 부호 이상 (r>0인데 Δ5112>0): ' + flagCounts.sign_anomaly);
output.push('');
output.push('플래그 걸린 학교: ' + flaggedSchools.length);
output.push('');

if (flaggedSchools.length > 0) {
  output.push('--- 플래그 걸린 학교 목록 ---');
  for (var i = 0; i < flaggedSchools.length; i++) {
    var s = flaggedSchools[i];
    output.push('[' + s.idx + '] ' + s.canonical + ' → ' + s.flags.join(', '));
  }
}

var result = output.join('\n');

// 파일 저장
fs.writeFileSync(path.join(ROOT, 'build/scan_sim_all.txt'), result, 'utf8');

console.log(result);
console.log('');
console.log('Result saved to: build/scan_sim_all.txt');
