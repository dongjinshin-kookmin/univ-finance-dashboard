/* sim_model.js — 입학정원 감소 시뮬레이션 클라이언트 계산 엔진 (순수 함수, DOM 접근 없음).
 *
 * 설계 근거: docs/시뮬레이션_모델_설계.md
 *   2장(코호트 전개·마스터 방정식 2.4), 3장(충원율 보수/현실·3.3 드리프트), 4장(단가 π·price_cap·5120 탄력),
 *   5장(파급 KPI 재계산·지출 대응 γ·ε), 7장(시나리오 3종·잔차 밴드), 부록 수식.
 * 데이터 계약: build/interim/sim_params.json → dashboard_data.json `sim` 블록.
 *   입력 schoolSim = sim.bySchool[idx] = {seg, price, surv, phi, base:{…,edu_cost}, bt, flags}.
 *   금액 단위 = 천원(dashboard 전역 계약). p_ug 단위 = 천원/인·년.
 *
 * 전역 노출: window.SIM (format.js/charts.js와 동일한 IIFE 패턴). node에서는 globalThis.SIM + module.exports.
 * 트랙 C(UI)가 이 API를 바인딩한다 — API 계약은 build/d10_report.md 참조.
 */
(function (global) {
  'use strict';

  // ── 소형 유틸 ───────────────────────────────────────────
  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function n0(x) { var v = num(x); return v == null ? 0 : v; }   // null → 0 (금액 합산용)
  function clamp0(x) { return x < 0 ? 0 : x; }
  function has(o, k) { return o && o[k] != null; }

  // ── 감축 스케줄: 코호트 진입연도 c의 누적 감축률 r(c) ──────────────────
  // profile: 'immediate'(즉시, 기본) | 'linear'(선형 램프). params.rSchedule({year:r})가 있으면 우선.
  function reductionOf(params, c) {
    var t0 = params.t0, r = params.r || 0;
    // 감축 온셋 디커플(설계 §2.4, 가법·후방호환): rStart 미지정 → t0(기존과 완전 동일).
    // π·인구드리프트 원점은 t0(=base)에 남고 감축 게이트·램프 원점만 rStart로 분리한다.
    var onset = params.rStart != null ? params.rStart : t0;
    if (params.rSchedule) {                    // 명시 스케줄 우선
      var v = params.rSchedule[String(c)];
      return v != null ? v : (c < onset ? 0 : r);
    }
    if (c < onset) return 0;
    if ((params.profile || 'immediate') === 'linear') {
      var ramp = params.rampYears || 5;
      return r * Math.min(1, (c - onset + 1) / ramp);
    }
    return r;                                   // immediate
  }

  // ── 단가 상승 시나리오 π: 연도별 인상률(설계 4.2) ─────────────────────
  // mode: 'freeze'(동결, 기본) | 'cap'(법정상한) | 'half'(상한/2) | 'custom'(params.piRate 상수)
  // price_cap는 2016~2026만 존재 → 그 이후는 마지막 공고값 캐리포워드(capCarryForward, 기본 true).
  function piRateOf(mode, params, meta, year, capCarryForward) {
    if (!mode || mode === 'freeze') return 0;
    if (mode === 'custom') return params.piRate || 0;
    var cap = meta && meta.price_cap ? meta.price_cap : {};
    var v = cap[String(year)];
    if (v == null && capCarryForward !== false) {
      var yrs = Object.keys(cap).map(Number);
      if (yrs.length) v = cap[String(Math.max.apply(null, yrs))];
    }
    v = v || 0;
    return mode === 'half' ? v / 2 : v;         // 'cap'
  }

  // ── f0 인구 드리프트(설계 3.3): t0 대비 누적 감소율 d_sido(t) ──────────
  // pop18_decline[sido][year] = 연도별(YoY) 감소율 → t0+1..t 곱으로 누적 index − 1.
  function cumDrift(meta, sido, t0, t) {
    if (!meta || !meta.pop18_decline || !sido || t <= t0) return 0;
    var s = meta.pop18_decline[sido];
    if (!s) return 0;
    var idx = 1;
    for (var y = t0 + 1; y <= t; y++) {
      var d = s[String(y)];
      idx *= (1 + (d || 0));
    }
    return idx - 1;
  }

  // ── 파라미터 해상(사용자값 → meta.defaults 폴백) ──────────────────────
  function resolveParams(params, meta) {
    params = params || {};
    var d = (meta && meta.defaults) || {};
    return {
      t0: params.t0 != null ? params.t0 : 2025,
      r: params.r != null ? params.r : 0,
      horizon: params.horizon != null ? params.horizon : 10,
      profile: params.profile || 'immediate',
      rampYears: params.rampYears || 5,
      rSchedule: params.rSchedule || null,
      rStart: params.rStart != null ? params.rStart : null,   // 감축 온셋(설계 §2.4); null → t0
      fillMode: params.fillMode || 'realistic',     // 'realistic'(현실, 기본) | 'conservative'(보수/고정)
      beta: params.beta != null ? params.beta : (d.beta != null ? d.beta : 0.5),
      fMax: params.fMax != null ? params.fMax : 1.0,
      piMode: params.piMode || 'freeze',            // 'freeze'|'cap'|'half'|'custom'
      piRate: params.piRate != null ? params.piRate : 0,
      capCarryForward: params.capCarryForward !== false,
      eta5120: params.eta5120 != null ? params.eta5120 : (d.eta_5120 != null ? d.eta_5120 : 0.3),
      gamma: params.gamma != null ? params.gamma : (d.gamma != null ? d.gamma : 0.15),
      gammaLabor: params.gammaLabor,                // 미지정 시 gamma 사용(설계 5.3 인건비 경직 서사)
      dropout: params.dropout != null ? params.dropout : (d.dropout || 0),
      lambda: params.lambda != null ? params.lambda : (d.lambda_ || 0)
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  //  B1 — 코어 투영 SIM.project
  //  입력: schoolSim(sim.bySchool[idx]), params(사용자), opts{meta, sido}
  //  출력: {years, rows:[{year, dA_in, dH_ug_in, d5112, d5120, d5100,
  //                       lvl5112, lvl5110, lvl5120, lvl5100, p_ug, H_ug_in, piFactor}], meta, params, responsive}
  // ══════════════════════════════════════════════════════════════════════
  function project(schoolSim, params, opts) {
    opts = opts || {};
    var meta = opts.meta || {};
    var P = resolveParams(params, meta);
    var gammaLabor = P.gammaLabor != null ? P.gammaLabor : P.gamma;

    var seg = schoolSim.seg || {}, price = schoolSim.price || {},
        surv = schoolSim.surv || {}, base = schoolSim.base || {}, phi = schoolSim.phi || {};
    var status = (schoolSim.flags || {}).status;

    var A_in = num(seg.A_in), Q = num(seg.Q), H_in0 = num(seg.H_ug_in);
    var p_ug0 = num(price.p_ug), m_in = num(surv.m_in);
    var s_k = surv.s_k || [];

    // 반응 세그먼트 존재 여부: 학부 미보유(no_ug)·파라미터 결측이면 델타 0(정확히 비반응, 설계 1.5·2.5)
    var responsive = status !== 'no_ug' && p_ug0 != null && A_in != null && A_in > 0 &&
                     H_in0 != null && H_in0 > 0 && s_k.length > 0;

    // 이탈률 스트레스(설계 2.3): s_k(k≥1) 일괄 축소. 기본 dropout=0 → 무변화.
    var sEff = s_k.map(function (v, k) { return k >= 1 ? v * (1 - P.dropout) : v; });

    // 기준 충원율 f0 = A_in/Q. f_max는 f0 미만으로 내려가지 않게(정원초과 학교 r=0 손실 방지).
    var f0 = (Q && Q > 0) ? A_in / Q : 1.0;
    var fMaxEff = Math.max(P.fMax, f0);

    // 코호트 c의 신규 정원내 입학자 A'_in(c) 와 델타 ΔA_in(c)
    function fCeiling(c) {
      var d = P.lambda ? cumDrift(meta, opts.sido, P.t0, c) : 0;
      var f0c = f0 * (1 + P.lambda * d);
      return Math.min(fMaxEff, f0c + P.beta * reductionOf(P, c));
    }
    function aPrime(c) {
      var rc = reductionOf(P, c);
      if (P.fillMode === 'conservative') return A_in * (1 - rc);   // 옵션1 보수(비례감소)
      return Math.min(A_in, Q * (1 - rc) * fCeiling(c));           // 옵션2 현실(수요앵커 min)
    }
    function dA(c) { return responsive ? (aPrime(c) - A_in) : 0; }

    // π 누적계수 piFactor(t) = Π_{τ=t0+1..t}(1+π_τ)
    var years = [], piFactor = {}, acc = 1;
    for (var t = P.t0; t <= P.t0 + P.horizon; t++) {
      if (t > P.t0) acc *= (1 + piRateOf(P.piMode, P, meta, t, P.capCarryForward));
      piFactor[t] = acc;
      years.push(t);
    }

    var c5111 = n0(base.c5111), c5112 = n0(base.c5112),
        c5120 = n0(base.c5120), c5100 = n0(base.c5100);
    var c5110 = c5111 + c5112;

    var rows = years.map(function (t) {
      // 컨볼루션: ΔH_ug_in(t) = Σ_c ΔA_in(c)·s_{t−c}  (설계 2.4)
      var dH = 0;
      if (responsive) {
        for (var c = P.t0; c <= t; c++) {
          var k = t - c;
          if (k < sEff.length) dH += dA(c) * sEff[k];
        }
      }
      var pf = piFactor[t];
      var pUgT = p_ug0 != null ? p_ug0 * pf : null;
      var d5112 = responsive ? pUgT * dH : 0;                     // Δ등록금수입(수업료) = p_ug(t)·ΔH  (정책 델타, π 한계반영)
      // 수강료 5120: η 탄력 × 인원변화율, π 반영(설계 4.3).
      var d5120 = (responsive && H_in0) ? c5120 * P.eta5120 * (dH / H_in0) * pf : 0;
      var d5100 = d5112 + d5120;

      // base 경로(무정책): 인원 t0 고정, 단가는 π로 인상(설계 2.4 "heads t0 고정"=인원 고정, 단가는 π 상승).
      // 5111 입학금은 폐지(외생 고정, π 미적용). → 레벨이 단가 방어(π)를 반영해 팬차트 낙관이 위로 온다.
      var b5112 = c5112 * pf, b5120 = c5120 * pf;
      var b5110 = c5111 + b5112, b5100 = b5110 + b5120;

      return {
        year: t,
        dA_in: responsive ? dA(t) : 0,          // 해당연도 진입 코호트의 ΔA_in
        dH_ug_in: dH,                            // 재학 스톡 델타
        d5112: d5112, d5120: d5120, d5100: d5100,
        lvl5112: b5112 + d5112,                  // 정책 레벨 = π인상 base + 정책델타
        lvl5110: b5110 + d5112,
        lvl5120: b5120 + d5120,
        lvl5100: b5100 + d5100,
        base5112: b5112, base5110: b5110, base5120: b5120, base5100: b5100,  // 무정책 base 경로(π 인상 포함)
        p_ug: pUgT,
        H_ug_in: clamp0(H_in0 != null ? H_in0 + dH : 0),
        piFactor: pf
      };
    });

    return {
      years: years, rows: rows, responsive: responsive, status: status,
      params: P,
      meta: {
        t0: P.t0, f0: f0, fMaxEff: fMaxEff, m_in: m_in, p_ug0: p_ug0,
        phi_in: num(phi.in), phi_out: num(phi.out), phi_grad: num(phi.grad),
        H_ug_in0: H_in0, A_in0: A_in, Q0: Q, gammaLabor: gammaLabor
      }
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  //  B2 — KPI 재계산 (설계 5장, config.py KPI_FORMULAS 동형 포팅)
  // ══════════════════════════════════════════════════════════════════════
  // 재계산 대상: base 스칼라로 계산 가능한 KPI만. 이월금비율(CF_NEXT/T_EX)·적립금순증(1250/1260)은
  // sim base에 계정이 없어 제외(트랙 C·d10 참조).  부호 '-' 접두 = 차감항.
  var KPI_DEFS = {
    '등록금의존율_총계': { num: ['c5100'], den: ['cT_IN'], fmt: 'pct' },
    '등록금의존율_운영': { num: ['c5100'], den: ['cOP_IN'], fmt: 'pct' },
    '운영수지': { num: ['cOP_IN', '-cOP_EX'], den: null, fmt: 'krw' },
    '운영수지율': { num: ['cOP_IN', '-cOP_EX'], den: ['cOP_IN'], fmt: 'pct' },
    '법인전입금비율': { num: ['c5210'], den: ['cOP_IN'], fmt: 'pct' },
    '장학금지원율': { num: ['c4321', 'c4322'], den: ['c5100'], fmt: 'pct' },
    '인건비부담률': { num: ['c4100'], den: ['c5100'], fmt: 'pct' },
    '교육비환원율': { num: ['c4100', 'c4200', 'c4300', '-c4330', 'c1317', 'c1314'], den: ['c5100'], fmt: 'pct' }
  };

  function _sumTerms(acc, terms) {
    // config.py 동형: 항 중 하나라도 결측(null)이면 해당 합을 null 처리(안전).
    var s = 0, any = false;
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i], neg = t.charAt(0) === '-';
      var key = neg ? t.slice(1) : t;
      var v = acc[key];
      if (v == null) return null;
      s += neg ? -v : v; any = true;
    }
    return any ? s : null;
  }

  function computeKPIs(acc) {
    var out = {};
    for (var name in KPI_DEFS) {
      var def = KPI_DEFS[name];
      var nu = _sumTerms(acc, def.num);
      if (nu == null) { out[name] = null; continue; }
      if (!def.den) { out[name] = nu; continue; }         // 금액형(운영수지)
      var de = _sumTerms(acc, def.den);
      out[name] = (de == null || de === 0) ? null : nu / de;   // 분모 0/결측 → null
    }
    return out;
  }

  // base 스칼라 + edu_cost를 평탄 acc 객체로 (원본 KPI 계정 접근)
  function flatAccounts(base, overrides) {
    var e = base.edu_cost || {};
    var acc = {
      c5100: num(base.c5100), cT_IN: num(base.cT_IN), cOP_IN: num(base.cOP_IN),
      cOP_EX: num(base.cOP_EX), c4100: num(base.c4100), c5210: num(base.c5210),
      c4321: num(base.c4321), c4322: num(base.c4322),
      c4200: num(e.c4200), c4300: num(e.c4300), c4330: num(e.c4330),
      c1317: num(e.c1317), c1314: num(e.c1314)
    };
    if (overrides) for (var k in overrides) acc[k] = overrides[k];
    return acc;
  }

  // 한 연도(projection row)에 대한 KPI 원값·재계산·델타.
  // 지출 대응(설계 5.2): ΔOP_EX = γ_L·(ΔH/H)·4100 + γ·(ΔH/H)·(OP_EX−4100).
  //   γ_L(gammaLabor) 미지정 시 γ. γ=0 → 완전경직(수지 최악), γ=1 → 완전연동(중립 근사).
  //   기타 계정(4200/4300/4330/1317/1314/4321/4322/5210)은 base 고정(분모축소 효과만).
  function kpisForRow(schoolSim, row, projMeta, params, opts) {
    var base = schoolSim.base || {};
    var origAcc = flatAccounts(base);
    var orig = computeKPIs(origAcc);

    var d5100 = row.d5100;
    var H0 = projMeta.H_ug_in0;
    var ratio = (H0 && H0 > 0) ? (row.dH_ug_in / H0) : 0;   // 인원변화율(음수)
    var gammaLabor = projMeta.gammaLabor;
    var gamma = projMeta.gammaGeneral != null ? projMeta.gammaGeneral : (params && params.gamma);
    if (gamma == null) gamma = 0.15;

    var c4100 = n0(base.c4100), cOP_EX = n0(base.cOP_EX);
    var d4100 = gammaLabor * ratio * c4100;
    var dOpEx = d4100 + gamma * ratio * (cOP_EX - c4100);

    var primeAcc = flatAccounts(base, {
      c5100: n0(base.c5100) + d5100,
      cOP_IN: n0(base.cOP_IN) + d5100,
      cT_IN: n0(base.cT_IN) + d5100,
      c4100: c4100 + d4100,
      cOP_EX: cOP_EX + dOpEx
    });
    var primed = computeKPIs(primeAcc);

    var delta = {};
    for (var name in KPI_DEFS) {
      delta[name] = (orig[name] == null || primed[name] == null) ? null : (primed[name] - orig[name]);
    }
    return { original: orig, primed: primed, delta: delta,
             aux: { d4100: d4100, dOpEx: dOpEx, ratio: ratio, fmt: _fmtMap() } };
  }

  function _fmtMap() {
    var m = {};
    for (var k in KPI_DEFS) m[k] = KPI_DEFS[k].fmt;
    return m;
  }

  // 투영 전체에 KPI 시계열을 붙임: [{year, original, primed, delta}] (projection.years 정렬)
  function recalcSeries(schoolSim, projection, params, opts) {
    var pm = projection.meta;
    // gammaLabor는 project가 이미 해상(projMeta.gammaLabor); gamma는 params 해상값 사용
    pm.gammaGeneral = projection.params.gamma;
    return projection.rows.map(function (row) {
      var k = kpisForRow(schoolSim, row, pm, projection.params, opts);
      return { year: row.year, original: k.original, primed: k.primed, delta: k.delta, aux: k.aux };
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  //  B3 — 시나리오 3종 밴드 + 잔차 밴드 (설계 7장)
  // ══════════════════════════════════════════════════════════════════════
  // 7.1 일관 파라미터 번들. 공유 파라미터(r, t0, profile, eta, dropout, lambda, horizon)는 userParams 승계.
  var SCENARIO_BUNDLES = {
    optimistic: { fillMode: 'realistic', beta: 1.0, piMode: 'cap', gamma: 0.3 },   // 낙관(손실 최소)
    base: { fillMode: 'realistic', beta: 0.5, piMode: 'freeze', gamma: 0.15 },     // 기준(중심)
    pessimistic: { fillMode: 'conservative', beta: 0.0, piMode: 'freeze', gamma: 0.0 } // 비관(손실 최대·고정비)
  };

  function scenarios(schoolSim, userParams, opts) {
    userParams = userParams || {};
    var shared = {
      r: userParams.r, t0: userParams.t0, horizon: userParams.horizon,
      profile: userParams.profile, rampYears: userParams.rampYears, rSchedule: userParams.rSchedule,
      eta5120: userParams.eta5120, dropout: userParams.dropout, lambda: userParams.lambda,
      fMax: userParams.fMax, capCarryForward: userParams.capCarryForward
    };
    var out = {};
    for (var key in SCENARIO_BUNDLES) {
      var p = {}; var b = SCENARIO_BUNDLES[key];
      for (var s in shared) if (shared[s] !== undefined) p[s] = shared[s];
      for (var q in b) p[q] = b[q];
      var proj = project(schoolSim, p, opts);
      out[key] = { projection: proj, kpis: recalcSeries(schoolSim, proj, p, opts), bundle: b };
    }
    return out;
  }

  // 7.2 백테스트 잔차 밴드: 시나리오 선(values)에 ±z·σ. σ≈bt.mape_rev(상대). bt null → 밴드 생략 플래그.
  function residualBand(values, bt, opts) {
    opts = opts || {};
    var z = opts.z != null ? opts.z : 1.28;    // P10~P90
    var mape = bt ? (opts.field ? bt[opts.field] : (bt.mape_rev != null ? bt.mape_rev : bt.mape_enroll)) : null;
    if (bt == null || mape == null) {
      return { omitted: true, reason: 'bt_null', lo: null, hi: null, z: z };
    }
    var lo = [], hi = [];
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v == null) { lo.push(null); hi.push(null); continue; }
      var half = z * mape * Math.abs(v);
      lo.push(v - half); hi.push(v + half);
    }
    return { omitted: false, lo: lo, hi: hi, z: z, sigma_rel: mape };
  }

  // ══════════════════════════════════════════════════════════════════════
  //  B5 — 폐교(존속) 위험 등급  SIM.closureGrade  (설계 §2 게이트 매트릭스)
  //  두 축(존속성 M · 완충 runway) 매트릭스 + 오버라이드 5종 + 경계밴드.
  //  입력: schoolSim(stock/seg/surv/base/flags/bt), projection(SIM.project 결과, null 허용), opts.
  //    projection != null → 라이브 시뮬 판정(정착 M·rollforward runway).
  //    projection == null → 관측 스냅샷 판정(opts.obs = {marginRate, fill, reserveAvail,
  //                          reserveMonths, corpCapacity, ...}). 폐교교 T-1/T-2 스냅샷·역검증용.
  //  순수 함수: DOM·전역 DATA 미접근, 모든 입력은 인자.
  // ══════════════════════════════════════════════════════════════════════
  var GRADE_RANK = { stable: 0, caution: 1, atrisk: 2, critical: 3 };
  var GRADE_BY_RANK = ['stable', 'caution', 'atrisk', 'critical'];

  // 판정 매트릭스[marginClass][bufferClass] (설계 §2).
  //   margin: 0 Healthy(≥2%) · 1 Thin(0~2%) · 2 Deficit(−10~0%) · 3 Severe(<−10%)
  //   buffer: 0 Strong(R≥10) · 1 Moderate(5~10) · 2 Thin(2~5) · 3 Depleted(<2 또는 월수<1)
  var CLOSURE_MATRIX = [
    ['stable',  'stable',  'caution', 'caution'],   // Healthy
    ['stable',  'caution', 'caution', 'atrisk'],    // Thin
    ['caution', 'caution', 'atrisk',  'atrisk'],    // Deficit
    ['caution', 'atrisk',  'atrisk',  'critical']   // Severe
  ];

  function marginClass(M) {
    if (M == null) return null;
    if (M >= 0.02) return 0;        // Healthy
    if (M >= 0) return 1;           // Thin
    if (M >= -0.10) return 2;       // Deficit
    return 3;                       // Severe
  }
  function bufferClass(R, reserveMonths) {
    // Depleted 우선: R<2 또는 적립금월수<1 (설계 §2, 오버라이드 ⑤ 내재)
    if ((reserveMonths != null && reserveMonths < 1) || (R != null && R < 2)) return 3;
    if (R == null) return null;
    if (R < 5) return 2;            // Thin
    if (R < 10) return 1;           // Moderate
    return 0;                       // Strong
  }
  function matrixGrade(mc, bc) {
    if (mc == null && bc == null) return 'stable';   // 신호 부재 → 오버라이드가 보정
    if (mc == null) mc = 0;         // 재무 미상 → 흑자 가정(보수적 하한), fill 오버라이드가 교정
    if (bc == null) bc = 0;         // 완충 미상 → Strong 가정
    return CLOSURE_MATRIX[mc][bc];
  }

  // 오버라이드(설계 §2 우선순위): ④ 흑자+월수<3 안정금지 → ② 충원<0.65 최소위험 → ① 충원<0.50 심각.
  // ①이 최우선이므로 마지막에 적용해 우선. ③(Severe∧Depleted→critical)·⑤(월수<1∧적자→Depleted)는 매트릭스 내재.
  function applyOverrides(grade, M, fill, reserveMonths) {
    var r = GRADE_RANK[grade];
    if (reserveMonths != null && reserveMonths < 3 && M != null && M >= 0 && r < GRADE_RANK.caution) {
      grade = 'caution'; r = 1;                      // ④ 안정 금지(주의 상한)
    }
    if (fill != null && fill < 0.65 && r < GRADE_RANK.atrisk) {
      grade = 'atrisk'; r = 2;                        // ② 최소 위험
    }
    if (fill != null && fill < 0.50) {
      grade = 'critical'; r = 3;                      // ① 심각
    }
    return grade;
  }

  // 완충 소진 rollforward(설계 §2): reserve_{t+1}=reserve_t+primed운영수지(t)+corp_addl.
  // 첫 음수해 = 소진예상, R=소진연도−t0. horizon 내 미소진이면 정착수지로 외삽(선린대 R≈68 재현).
  //  가법(설계 §5.1-2): reservePath[i] = reserve(years[i]) 완충잔액 경로를 추가 반환.
  //  R·depletionYear 산출 로직·수치는 종전과 **비트 동일**(첫 소진해 조기포착값 그대로;
  //  reservePath는 소진 이후에도 음수로 계속 누적해 grade(t)·reserveMonths(t) 스케일에 쓰인다).
  function runwayRollforward(reserve0, perYearBal, corpAddl, years, t0, win) {
    var reserve = reserve0 != null ? reserve0 : 0;
    var reservePath = [reserve];                 // reserve(years[0]) = 앵커(2025) 잔액
    var i, bal, next;
    var R = null, depletionYear = null, depleted = false;
    for (i = 0; i < years.length; i++) {
      bal = (perYearBal[i] != null ? perYearBal[i] : 0) + corpAddl;
      next = reserve + bal;
      if (!depleted && next < 0) {                // 첫 소진해 — 종전과 동일하게 여기서 R 확정
        var frac = bal < 0 ? reserve / (-bal) : 0;
        frac = frac < 0 ? 0 : (frac > 1 ? 1 : frac);
        R = (years[i] - t0) + frac;
        depletionYear = Math.round(t0 + R);
        depleted = true;
      }
      reserve = next;
      if (i < years.length - 1) reservePath.push(reserve);   // reserve(years[i+1])
    }
    if (!depleted) {                              // horizon 내 미소진 → 정착수지 외삽(종전 로직)
      var settle = 0, cnt = 0;
      for (i = Math.max(0, perYearBal.length - win); i < perYearBal.length; i++) {
        if (perYearBal[i] != null) { settle += perYearBal[i]; cnt++; }
      }
      settle = (cnt ? settle / cnt : 0) + corpAddl;
      if (settle >= 0) { R = Infinity; depletionYear = null; }
      else {
        var lastY = years[years.length - 1];
        R = (lastY - t0) + reserve / (-settle);
        depletionYear = Math.round(t0 + R);
      }
    }
    return { R: R, depletionYear: depletionYear, reservePath: reservePath };
  }

  // 관측 모드 runway: 적립금월수/|적자율| (설계 §2 선린대 (7.35/12)/0.009≈68 검산선).
  function runwayFromMonths(M, reserveMonths) {
    if (M == null || M >= 0) return Infinity;         // 흑자·미상 → 소진 없음
    var mo = reserveMonths != null ? reserveMonths : 0;
    return (mo / 12) / (-M);
  }

  // 경계밴드(설계 §4): 운영수지'에 ±z·σ(σ=bt.mape_rev) + runway 임계 {2,5,10}±1y 섭동 재판정.
  function closureBoundary(baseGrade, M, fill, runway, reserveMonths, bt) {
    var z = 1.28, ranks = [GRADE_RANK[baseGrade]];
    var mape = (bt && bt.mape_rev != null) ? bt.mape_rev : null;
    var Ms = [M], Rs = [runway];
    if (mape != null && M != null) {
      var half = z * mape * Math.abs(M);
      Ms = [M - half, M, M + half];
    }
    var near = (runway != null && isFinite(runway)) &&
               [2, 5, 10].some(function (t) { return Math.abs(runway - t) <= 1; });
    if (near) Rs = [runway - 1, runway, runway + 1];
    for (var a = 0; a < Ms.length; a++) {
      for (var b = 0; b < Rs.length; b++) {
        var g = applyOverrides(matrixGrade(marginClass(Ms[a]), bufferClass(Rs[b], reserveMonths)),
                               Ms[a], fill, reserveMonths);
        ranks.push(GRADE_RANK[g]);
      }
    }
    var lo = Math.min.apply(null, ranks), hi = Math.max.apply(null, ranks);
    return { flag: lo !== hi, range: [GRADE_BY_RANK[lo], GRADE_BY_RANK[hi]] };
  }

  function closureGrade(schoolSim, projection, opts) {
    opts = opts || {};
    var stock = schoolSim.stock || {};
    var flags = schoolSim.flags || {};
    var obs = opts.obs || null;

    // ── 입력 해상(관측 obs 우선 → stock 폴백) ──
    var reserveAvail = (obs && obs.reserveAvail != null) ? obs.reserveAvail
      : (stock.reserve_avail != null ? stock.reserve_avail
      : (opts.reserveAvailFallback != null ? opts.reserveAvailFallback : null));
    var reserveMonths = (obs && obs.reserveMonths !== undefined) ? obs.reserveMonths
      : (stock.reserve_month0 != null ? stock.reserve_month0 : null);
    var corpCap = (obs && obs.corpCapacity !== undefined) ? obs.corpCapacity
      : (stock.corp_capacity != null ? stock.corp_capacity : null);
    var corpAddl = (opts.useCorpSupport && corpCap != null) ? corpCap : 0;

    var M = null, fill = null, runway = Infinity, depletionYear = null, refYear = null;

    if (projection != null) {
      var P = projection.params || {};
      var horizon = P.horizon != null ? P.horizon : 10;
      var win = Math.min(3, horizon);
      var kseries = opts.kpiSeries || recalcSeries(schoolSim, projection, projection.params, opts);
      var mAcc = 0, mCnt = 0, perYearBal = [];
      for (var i = 0; i < kseries.length; i++) {
        var pr = kseries[i].primed || {};
        perYearBal.push(pr['운영수지'] != null ? pr['운영수지'] : null);
        if (i >= kseries.length - win && pr['운영수지율'] != null) { mAcc += pr['운영수지율']; mCnt++; }
      }
      M = mCnt ? mAcc / mCnt : null;
      var f0 = projection.meta ? projection.meta.f0 : null;   // 신입생 충원율 = A_in/Q (설계 §3)
      fill = f0;
      if (f0 != null && P.lambda) {
        var drift = cumDrift(opts.meta || {}, opts.sido, P.t0, P.t0 + horizon);
        fill = f0 * (1 + P.lambda * drift);                   // λ-on: 인구드리프트 정착 충원율
      }
      var roll = runwayRollforward(reserveAvail, perYearBal, corpAddl, projection.years, P.t0, win);
      runway = roll.R; depletionYear = roll.depletionYear; refYear = P.t0;
    } else {
      M = obs && obs.marginRate != null ? obs.marginRate : null;
      fill = obs && obs.fill != null ? obs.fill : null;
      runway = runwayFromMonths(M, reserveMonths);
      refYear = opts.obsYear != null ? opts.obsYear : (flags.year != null ? flags.year : null);
      if (isFinite(runway) && refYear != null) depletionYear = Math.round(refYear + runway);
    }

    // ── 미분류: 학부미보유·대학원대·데이터부재 (설계 §1) ──
    var isNoUg = flags.status === 'no_ug' || opts.noUg === true;
    var isGrad = opts.isGrad === true || (opts.type != null && /대학원/.test(opts.type));
    var dataAbsent = (M == null && fill == null);
    if (isNoUg || isGrad || dataAbsent) {
      return {
        grade: 'unrated', runwayYears: null, depletionYear: null,
        marginEnd: M, fill: fill, buffer0: reserveAvail, reserveMonths: reserveMonths,
        drivers: [], confidence: 'low', boundaryFlag: false, gradeRange: ['unrated', 'unrated']
      };
    }

    // ── 매트릭스 + 오버라이드 ──
    var mc = marginClass(M), bc = bufferClass(runway, reserveMonths);
    var grade = applyOverrides(matrixGrade(mc, bc), M, fill, reserveMonths);

    // ── drivers(결정 게이트, 설명가능성) ──
    var drivers = [];
    if (mc === 3) drivers.push('severe');
    else if (mc === 2) drivers.push('deficit');
    if (bc === 3) drivers.push('no_buffer');
    if (reserveMonths != null && reserveMonths < 3) drivers.push('liquidity');
    if (fill != null && fill < 0.65) drivers.push('low_fill');

    // ── 경계밴드 ──
    var bnd = closureBoundary(grade, M, fill, runway, reserveMonths, schoolSim.bt);

    // ── confidence: 백테스트 bt 있으면 ok · 그 외 beta(D6 합격 전 베타) ──
    var confidence = (schoolSim.bt != null) ? 'ok' : 'beta';

    return {
      grade: grade,
      runwayYears: (runway === Infinity || !isFinite(runway)) ? Infinity : runway,
      depletionYear: depletionYear,
      marginEnd: M, fill: fill, buffer0: reserveAvail, reserveMonths: reserveMonths,
      drivers: drivers, confidence: confidence,
      boundaryFlag: bnd.flag, gradeRange: bnd.range
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  //  B6 — 전국 집계  SIM.closureAggregate  (344교 project→closureGrade)
  //  입력: simData(sim 객체 또는 bySchool 맵), params(사용자 시나리오), opts.
  //    opts.meta = sim.meta · opts.schools = 학교 메타 배열[idx]={sido,region,scale,type}(호출측 주입)
  //    opts.useCorpSupport = 법인지원 토글.
  //  DOM·전역 DATA 비의존: 모든 메타는 opts.schools로 주입. 성능: 344교×2회(현재+기준 r=0).
  // ══════════════════════════════════════════════════════════════════════
  function bumpBucket(agg, key, grade) {
    if (!agg[key]) agg[key] = { stable: 0, caution: 0, atrisk: 0, critical: 0, unrated: 0, atRiskOrWorse: 0, total: 0 };
    agg[key][grade]++; agg[key].total++;
    if (GRADE_RANK[grade] >= GRADE_RANK.atrisk) agg[key].atRiskOrWorse++;
  }

  function closureAggregate(simData, params, opts) {
    opts = opts || {};
    var bySchool = simData.bySchool || simData;
    var meta = opts.meta || simData.meta || {};
    var schoolsMeta = opts.schools || [];
    var counts = { stable: 0, caution: 0, atrisk: 0, critical: 0, unrated: 0 };
    var atRiskOrWorse = 0, atRiskLo = 0, atRiskHi = 0;
    var byRegion = {}, byScale = {};
    var trSchools = [], downgraded = 0, newAtRisk = 0;

    var baseParams = {};
    for (var k in params) baseParams[k] = params[k];
    baseParams.r = 0;                                   // 기준 시나리오(전이 비교 기준)

    var idxs = Object.keys(bySchool);
    for (var ii = 0; ii < idxs.length; ii++) {
      var idx = idxs[ii], sSim = bySchool[idx], sm = schoolsMeta[+idx] || {};
      var o = { meta: meta, sido: sm.sido, type: sm.type, useCorpSupport: opts.useCorpSupport };

      var proj = project(sSim, params, o);
      var g = closureGrade(sSim, proj, o);
      var proj0 = project(sSim, baseParams, o);
      var g0 = closureGrade(sSim, proj0, o);

      counts[g.grade]++;
      var rank = GRADE_RANK[g.grade];
      if (rank >= GRADE_RANK.atrisk) atRiskOrWorse++;
      if (g.grade !== 'unrated') {
        if (GRADE_RANK[g.gradeRange[0]] >= GRADE_RANK.atrisk) atRiskLo++;   // 최소(최선 경계)
        if (GRADE_RANK[g.gradeRange[1]] >= GRADE_RANK.atrisk) atRiskHi++;   // 최대(최악 경계)
      }
      bumpBucket(byRegion, sm.region || '기타', g.grade);
      bumpBucket(byScale, sm.scale || '기타', g.grade);

      if (g0.grade !== 'unrated' && g.grade !== 'unrated' && rank > GRADE_RANK[g0.grade]) {
        downgraded++;
        if (GRADE_RANK[g0.grade] < GRADE_RANK.atrisk && rank >= GRADE_RANK.atrisk) newAtRisk++;
        trSchools.push({ idx: +idx, from: g0.grade, to: g.grade });
      }
    }
    return {
      counts: counts,
      atRiskOrWorse: atRiskOrWorse,
      atRiskRange: [atRiskLo, atRiskHi],
      byRegion: byRegion, byScale: byScale,
      transitions: { downgraded: downgraded, newAtRisk: newAtRisk, schools: trSchools }
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  //  B7 — 연도별 등급 시계열  SIM.closureTimeline  (설계 §1·§2)
  //  2025~2045 각 연도에 §2 검증 매트릭스·오버라이드를 스냅샷 재적용(새 임계값 없음).
  //  project(1회)+recalcSeries(1회)+rollforward(1회) 후 21년 판독 — 재투영 없음(설계 §7 대안 기각).
  //  기존 closureGrade/closureAggregate 무수정; 검증 원시함수(marginClass/bufferClass/
  //  matrixGrade/applyOverrides/runwayRollforward)를 **재사용**(단일 소스).
  // ══════════════════════════════════════════════════════════════════════
  var TL_BASE = 2025, TL_END = 2045;
  var TL_VALIDATED_TO = 2029, TL_DRIFT_TO = 2040;   // 정직성 3구간 경계(달력 고정, 설계 §2.1)
  var H_BT = 4;                                      // 백테스트 지평(σ(t) 확대 기준, 설계 §2.2)

  // 관찰창 정규화: base=2025 고정(미지정 시), horizon은 2045까지 도달하도록 확장(가법·비파괴).
  // horizon 확장은 앞 구간 수치 불변(설계 §2.5 horizon 무의존) → 뒤 연도만 추가.
  function _timelineWindow(params) {
    var p = {}; for (var k in params) p[k] = params[k];
    if (p.t0 == null) p.t0 = TL_BASE;
    var need = TL_END - p.t0;
    if (p.horizon == null || p.horizon < need) p.horizon = need;
    return p;
  }

  function _phaseOf(t) {
    if (t <= TL_VALIDATED_TO) return 'verified';        // 2025~2029 백테스트 검증범위
    if (t <= TL_DRIFT_TO) return 'projected';           // 2030~2040 인구추계 실재
    return 'extrapolated';                              // 2041~2045 관찰용 외삽
  }

  // 인구드리프트(설계 §2.3): 기본은 cumDrift(2040 이후 자동 동결). driftTail='lastRate'면
  // 데이터 종료연도 이후를 마지막 YoY율로 지속(민감도 토글, 기본 OFF).
  function _driftAt(meta, sido, t0, t, tail) {
    if (tail !== 'lastRate') return cumDrift(meta, sido, t0, t);
    if (!meta || !meta.pop18_decline || !sido || t <= t0) return cumDrift(meta, sido, t0, t);
    var s = meta.pop18_decline[sido]; if (!s) return 0;
    var yrs = Object.keys(s).map(Number); if (!yrs.length) return cumDrift(meta, sido, t0, t);
    var lastY = Math.max.apply(null, yrs);
    if (t <= lastY) return cumDrift(meta, sido, t0, t);
    var idx = 1, y;
    for (y = t0 + 1; y <= lastY; y++) idx *= (1 + (s[String(y)] || 0));
    var lastRate = s[String(lastY)] || 0;
    for (y = lastY + 1; y <= t; y++) idx *= (1 + lastRate);
    return idx - 1;
  }

  // σ(t) 상대오차 해상(오케스트레이터 결정3): bt.mape_rev(학교) → 유형/규모 그룹중앙값 → 전역 순 폴백.
  //   폴백 출처를 bandSrc로 표기. 현 데이터는 전 학교 bt=null → rel=null·src='none'(밴드 생략).
  function _resolveSigma(schoolSim, opts) {
    var bt = schoolSim.bt;
    if (bt && bt.mape_rev != null) return { rel: bt.mape_rev, src: 'school' };
    var fb = opts.sigmaFallback;
    if (fb) {
      if (opts.type && fb.byType && fb.byType[opts.type] != null) return { rel: fb.byType[opts.type], src: 'group' };
      if (opts.scale && fb.byScale && fb.byScale[opts.scale] != null) return { rel: fb.byScale[opts.scale], src: 'group' };
      if (fb.global != null) return { rel: fb.global, src: 'global' };
    }
    return { rel: null, src: 'none' };
  }

  // 연도 t 경계밴드(설계 §2.2 σ(t) 확대): M을 ±z·σ(t)·|M|, runway 임계 {2,5,10}±1y 섭동 재판정.
  //   σ(t)=null(밴드 미보유)이면 runway 근접 섭동만(관측밴드 성격) — closureBoundary와 정합.
  function _gradeBandAt(baseGrade, M, fill, runway, reserveMonths, sigmaT) {
    if (baseGrade === 'unrated') return ['unrated', 'unrated'];
    var z = 1.28, ranks = [GRADE_RANK[baseGrade]];
    var Ms = [M], Rs = [runway];
    if (sigmaT != null && M != null) { var half = z * sigmaT * Math.abs(M); Ms = [M - half, M, M + half]; }
    var near = (runway != null && isFinite(runway)) &&
               [2, 5, 10].some(function (x) { return Math.abs(runway - x) <= 1; });
    if (near) Rs = [runway - 1, runway, runway + 1];
    for (var a = 0; a < Ms.length; a++) {
      for (var b = 0; b < Rs.length; b++) {
        var g = applyOverrides(matrixGrade(marginClass(Ms[a]), bufferClass(Rs[b], reserveMonths)),
                               Ms[a], fill, reserveMonths);
        ranks.push(GRADE_RANK[g]);
      }
    }
    var lo = Math.min.apply(null, ranks), hi = Math.max.apply(null, ranks);
    return [GRADE_BY_RANK[lo], GRADE_BY_RANK[hi]];
  }

  // 확정지연 가드(설계 §1.3, 옵션·기본 OFF): 등급 변경이 1년만 유지 후 직전 등급으로
  // 되돌면(X→Y→X) 그 1년을 직전 등급으로 덮어써 근거 약한 1년 반전(지터)을 억제. O(1) 상태.
  // 결정론적 임계 교차(실제 전이)까지 지우므로 근거 있을 때만 켠다.
  function _applyConfirmDelay(raw) {
    var out = raw.slice();
    for (var i = 1; i < out.length - 1; i++) {
      if (out[i] !== out[i - 1] && out[i + 1] === out[i - 1]) out[i] = out[i - 1];
    }
    return out;
  }

  function closureTimeline(schoolSim, params, opts) {
    opts = opts || {};
    var P0 = _timelineWindow(params);
    var meta = opts.meta || {};
    var stock = schoolSim.stock || {};
    var flags = schoolSim.flags || {};

    var proj = project(schoolSim, P0, opts);
    var Pr = proj.params;
    var kseries = opts.kpiSeries || recalcSeries(schoolSim, proj, P0, opts);
    var years = proj.years, n = years.length;

    // ── 완충축 입력(투영 모드; closureGrade와 동일 해상, obs 폴백 없음) ──
    var reserveAvail = stock.reserve_avail != null ? stock.reserve_avail
      : (opts.reserveAvailFallback != null ? opts.reserveAvailFallback : null);
    var reserveMonths0 = stock.reserve_month0 != null ? stock.reserve_month0 : null;
    var corpCap = stock.corp_capacity != null ? stock.corp_capacity : null;
    var corpAddl = (opts.useCorpSupport && corpCap != null) ? corpCap : 0;

    // ── 연도별 primed 운영수지(천원)·운영수지율 ──
    var perYearBal = [], Mseries = [];
    for (var i = 0; i < kseries.length; i++) {
      var pr = kseries[i].primed || {};
      perYearBal.push(pr['운영수지'] != null ? pr['운영수지'] : null);
      Mseries.push(pr['운영수지율'] != null ? pr['운영수지율'] : null);
    }
    var win = Math.min(3, Pr.horizon);
    var roll = runwayRollforward(reserveAvail, perYearBal, corpAddl, years, Pr.t0, win);
    var reservePath = roll.reservePath, R_full = roll.R, depletionYear = roll.depletionYear;
    var reserve0 = reservePath[0];

    var f0 = proj.meta ? proj.meta.f0 : null;
    var lambda = Pr.lambda;
    var sig = _resolveSigma(schoolSim, opts);

    var isNoUg = flags.status === 'no_ug' || opts.noUg === true;
    var isGrad = opts.isGrad === true || (opts.type != null && /대학원/.test(opts.type));

    var grades = [], Rarr = [], resArr = [], moArr = [], fillArr = [],
        phaseArr = [], sigmaArr = [], rangeArr = [];
    var firstAtRiskYear = null, firstCriticalYear = null;

    for (i = 0; i < n; i++) {
      var t = years[i];
      var M = Mseries[i];
      var reserveT = reservePath[i];

      // fill(t): λ-off f0; λ-on f0·(1+λ·drift(2025→t))  — 그 해까지의 드리프트(정착값 아님)
      var fillT = f0;
      if (f0 != null && lambda) {
        fillT = f0 * (1 + lambda * _driftAt(meta, opts.sido, Pr.t0, t, opts.driftTail));
      }

      // reserveMonths(t) = reserve_month0 · reserve(t)/reserve(2025) (앵커 고정·소진분수 스케일)
      var moT;
      if (reserveMonths0 == null) moT = null;
      else if (reserve0 == null || reserve0 === 0) moT = reserveMonths0;
      else { var ratio = reserveT / reserve0; if (ratio < 0) ratio = 0; moT = reserveMonths0 * ratio; }
      if (reserveMonths0 != null && reserveT != null && reserveT <= 0) moT = 0;

      // R(t): 관측시점 t에서 본 잔여 runway = R_full − (t−2025), 소진연도 없으면 ∞.
      //   reserve(t)≤0 → R(t)=0 floor는 **소진 경로가 존재할 때만**(depletionYear!=null) 적용한다.
      //   reserve_avail=0·재무결측(적자 없음)은 소진이 아니라 데이터부재 → closureGrade와 동일하게 ∞ 유지.
      var Rt;
      if (depletionYear == null) Rt = Infinity;
      else {
        Rt = R_full - (t - Pr.t0);
        if (Rt < 0) Rt = 0;
        if (reserveT != null && reserveT <= 0) Rt = 0;
      }

      // grade(t): §2 매트릭스+오버라이드 스냅샷 재적용 / 미분류 게이트(closureGrade 동일)
      var g;
      if (isNoUg || isGrad || (M == null && fillT == null)) g = 'unrated';
      else g = applyOverrides(matrixGrade(marginClass(M), bufferClass(Rt, moT)), M, fillT, moT);

      var sigmaT = sig.rel != null ? sig.rel * Math.sqrt(Math.max(1, (t - TL_BASE) / H_BT)) : null;

      grades.push(g); Rarr.push(Rt); resArr.push(reserveT); moArr.push(moT); fillArr.push(fillT);
      phaseArr.push(_phaseOf(t)); sigmaArr.push(sigmaT);
      rangeArr.push(_gradeBandAt(g, M, fillT, Rt, moT, sigmaT));
      if (firstAtRiskYear == null && GRADE_RANK[g] != null && GRADE_RANK[g] >= GRADE_RANK.atrisk) firstAtRiskYear = t;
      if (firstCriticalYear == null && g === 'critical') firstCriticalYear = t;
    }

    // 확정지연 가드(기본 OFF) — 켜지면 1년 반전 억제 후 firstAtRisk/Critical 재산출
    if (opts.confirmDelay) {
      grades = _applyConfirmDelay(grades);
      firstAtRiskYear = null; firstCriticalYear = null;
      for (i = 0; i < n; i++) {
        if (firstAtRiskYear == null && GRADE_RANK[grades[i]] != null && GRADE_RANK[grades[i]] >= GRADE_RANK.atrisk) firstAtRiskYear = years[i];
        if (firstCriticalYear == null && grades[i] === 'critical') firstCriticalYear = years[i];
      }
    }

    var confidence = (isNoUg || isGrad) ? 'low' : (schoolSim.bt != null ? 'ok' : 'beta');

    return {
      years: years, grades: grades,
      M: Mseries, reserve: resArr, runway: Rarr, reserveMonths: moArr, fill: fillArr,
      phase: phaseArr, sigma: sigmaArr, gradeRange: rangeArr,
      depletionYear: depletionYear, firstAtRiskYear: firstAtRiskYear, firstCriticalYear: firstCriticalYear,
      confidence: confidence, bandSrc: sig.src
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  //  B8 — 전국 연도별 등급 시계열 집계  SIM.closureAggregateTimeline  (설계 §3.3)
  //  각 학교 closureTimeline 1회(+r=0 기준선) → 연도×등급 카운트·위험진입 incidence·
  //  권역별 소계·기준 대비 하락 시계열. 성능계약: 344교×21년 사전계산 1회 ≤100ms.
  //  슬라이더/재생은 bySchool[i].grades[year] 판독만(재계산 0).
  // ══════════════════════════════════════════════════════════════════════
  function _median(arr) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return (s.length % 2) ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // σ(t) 그룹·전역 폴백 사전계산(bt.mape_rev 보유교로만). 전 학교 bt=null이면 전부 null.
  function _buildSigmaFallback(bySchoolMap, schoolsMeta) {
    var all = [], byTypeArr = {}, byScaleArr = {};
    Object.keys(bySchoolMap).forEach(function (idx) {
      var bt = bySchoolMap[idx].bt;
      if (!bt || bt.mape_rev == null) return;
      var v = bt.mape_rev, sm = schoolsMeta[+idx] || {};
      all.push(v);
      if (sm.type) (byTypeArr[sm.type] = byTypeArr[sm.type] || []).push(v);
      if (sm.scale) (byScaleArr[sm.scale] = byScaleArr[sm.scale] || []).push(v);
    });
    var byType = {}, byScale = {}, t, s;
    for (t in byTypeArr) byType[t] = _median(byTypeArr[t]);
    for (s in byScaleArr) byScale[s] = _median(byScaleArr[s]);
    return { byType: byType, byScale: byScale, global: _median(all) };
  }

  function _mkCounts() { return { stable: 0, caution: 0, atrisk: 0, critical: 0, unrated: 0 }; }
  function _bumpTL(bucketMap, key, grade) {
    var b = bucketMap[key];
    if (!b) { b = bucketMap[key] = { stable: 0, caution: 0, atrisk: 0, critical: 0, unrated: 0, atRiskOrWorse: 0, total: 0 }; }
    b[grade]++; b.total++;
    if (GRADE_RANK[grade] != null && GRADE_RANK[grade] >= GRADE_RANK.atrisk) b.atRiskOrWorse++;
  }

  function closureAggregateTimeline(simData, params, opts) {
    opts = opts || {};
    var bySchoolMap = simData.bySchool || simData;
    var meta = opts.meta || simData.meta || {};
    var schoolsMeta = opts.schools || [];
    var P = _timelineWindow(params);
    var baseP = {}; for (var k in P) baseP[k] = P[k];
    baseP.r = 0;                                        // 전이 비교 기준(r=0)
    var sameAsBase = (P.r == null || P.r === 0);        // r=0이면 기준선 재계산 생략(성능)

    var sigmaFallback = _buildSigmaFallback(bySchoolMap, schoolsMeta);
    var idxs = Object.keys(bySchoolMap);

    var years = null, Y = 0;
    var counts = null, atRiskOrWorse = null, atRiskLo = null, atRiskHi = null,
        byRegion = null, byScale = null, downgraded = null;
    var incidence = null;                               // year → [idx...] (위험+ 최초 진입)
    var bySchoolOut = [];

    function initYears(yrs) {
      years = yrs; Y = yrs.length;
      counts = []; atRiskOrWorse = []; atRiskLo = []; atRiskHi = [];
      byRegion = []; byScale = []; downgraded = []; incidence = [];
      for (var j = 0; j < Y; j++) {
        counts.push(_mkCounts()); atRiskOrWorse.push(0); atRiskLo.push(0); atRiskHi.push(0);
        byRegion.push({}); byScale.push({}); downgraded.push(0); incidence.push([]);
      }
    }

    for (var ii = 0; ii < idxs.length; ii++) {
      var idx = idxs[ii], sSim = bySchoolMap[idx], sm = schoolsMeta[+idx] || {};
      var o = {
        meta: meta, sido: sm.sido, type: sm.type, scale: sm.scale,
        useCorpSupport: opts.useCorpSupport, sigmaFallback: sigmaFallback,
        driftTail: opts.driftTail, confirmDelay: opts.confirmDelay
      };
      var tl = closureTimeline(sSim, P, o);
      var tl0 = sameAsBase ? tl : closureTimeline(sSim, baseP, o);
      if (years == null) initYears(tl.years);

      for (var i = 0; i < Y; i++) {
        var g = tl.grades[i];
        counts[i][g]++;
        if (GRADE_RANK[g] != null && GRADE_RANK[g] >= GRADE_RANK.atrisk) atRiskOrWorse[i]++;
        var rng = tl.gradeRange[i];
        if (g !== 'unrated') {
          if (GRADE_RANK[rng[0]] >= GRADE_RANK.atrisk) atRiskLo[i]++;
          if (GRADE_RANK[rng[1]] >= GRADE_RANK.atrisk) atRiskHi[i]++;
        }
        _bumpTL(byRegion[i], sm.region || '기타', g);
        _bumpTL(byScale[i], sm.scale || '기타', g);
        var gb = tl0.grades[i];
        if (g !== 'unrated' && gb !== 'unrated' && GRADE_RANK[g] > GRADE_RANK[gb]) downgraded[i]++;
      }
      if (tl.firstAtRiskYear != null) {
        var fi = tl.firstAtRiskYear - years[0];
        if (fi >= 0 && fi < Y) incidence[fi].push(+idx);
      }
      bySchoolOut.push({
        idx: +idx, grades: tl.grades, depletionYear: tl.depletionYear,
        firstAtRiskYear: tl.firstAtRiskYear, firstCriticalYear: tl.firstCriticalYear
      });
    }

    var perYear = [];
    for (var y = 0; y < Y; y++) {
      perYear.push({
        year: years[y], counts: counts[y], atRiskOrWorse: atRiskOrWorse[y],
        atRiskRange: [atRiskLo[y], atRiskHi[y]],
        byRegion: byRegion[y], byScale: byScale[y],
        newAtRisk: { count: incidence[y].length, schools: incidence[y] },
        downgradedVsBase: downgraded[y]
      });
    }

    return {
      years: years, perYear: perYear, bySchool: bySchoolOut,
      honesty: { base: TL_BASE, validatedTo: TL_VALIDATED_TO, driftDataTo: TL_DRIFT_TO, horizonTo: years[Y - 1] },
      bandSrc: sigmaFallback.global != null ? 'group/global' : 'none'
    };
  }

  // ── 전역 노출 ───────────────────────────────────────────
  global.SIM = {
    project: project,
    computeKPIs: computeKPIs,
    flatAccounts: flatAccounts,
    kpisForRow: kpisForRow,
    recalcSeries: recalcSeries,
    scenarios: scenarios,
    residualBand: residualBand,
    closureGrade: closureGrade,
    closureAggregate: closureAggregate,
    closureTimeline: closureTimeline,
    closureAggregateTimeline: closureAggregateTimeline,
    // 내부 유틸(테스트·트랙 C 편의)
    _util: {
      reductionOf: reductionOf, piRateOf: piRateOf, cumDrift: cumDrift,
      resolveParams: resolveParams, KPI_DEFS: KPI_DEFS, SCENARIO_BUNDLES: SCENARIO_BUNDLES,
      marginClass: marginClass, bufferClass: bufferClass, matrixGrade: matrixGrade,
      applyOverrides: applyOverrides, runwayRollforward: runwayRollforward,
      runwayFromMonths: runwayFromMonths, CLOSURE_MATRIX: CLOSURE_MATRIX,
      GRADE_RANK: GRADE_RANK, GRADE_BY_RANK: GRADE_BY_RANK,
      phaseOf: _phaseOf, buildSigmaFallback: _buildSigmaFallback, timelineWindow: _timelineWindow
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SIM;

})(typeof window !== 'undefined' ? window : globalThis);
