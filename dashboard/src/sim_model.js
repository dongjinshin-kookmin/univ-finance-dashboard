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
    if (params.rSchedule) {                    // 명시 스케줄 우선
      var v = params.rSchedule[String(c)];
      return v != null ? v : (c < t0 ? 0 : r);
    }
    if (c < t0) return 0;
    if ((params.profile || 'immediate') === 'linear') {
      var ramp = params.rampYears || 5;
      return r * Math.min(1, (c - t0 + 1) / ramp);
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
  function runwayRollforward(reserve0, perYearBal, corpAddl, years, t0, win) {
    var reserve = reserve0 != null ? reserve0 : 0;
    var i, bal, next;
    for (i = 0; i < years.length; i++) {
      bal = (perYearBal[i] != null ? perYearBal[i] : 0) + corpAddl;
      next = reserve + bal;
      if (next < 0) {
        var frac = bal < 0 ? reserve / (-bal) : 0;
        frac = frac < 0 ? 0 : (frac > 1 ? 1 : frac);
        var R = (years[i] - t0) + frac;
        return { R: R, depletionYear: Math.round(t0 + R) };
      }
      reserve = next;
    }
    var settle = 0, cnt = 0;
    for (i = Math.max(0, perYearBal.length - win); i < perYearBal.length; i++) {
      if (perYearBal[i] != null) { settle += perYearBal[i]; cnt++; }
    }
    settle = (cnt ? settle / cnt : 0) + corpAddl;
    if (settle >= 0) return { R: Infinity, depletionYear: null };
    var lastY = years[years.length - 1];
    var R2 = (lastY - t0) + reserve / (-settle);
    return { R: R2, depletionYear: Math.round(t0 + R2) };
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
    // 내부 유틸(테스트·트랙 C 편의)
    _util: {
      reductionOf: reductionOf, piRateOf: piRateOf, cumDrift: cumDrift,
      resolveParams: resolveParams, KPI_DEFS: KPI_DEFS, SCENARIO_BUNDLES: SCENARIO_BUNDLES,
      marginClass: marginClass, bufferClass: bufferClass, matrixGrade: matrixGrade,
      applyOverrides: applyOverrides, runwayRollforward: runwayRollforward,
      runwayFromMonths: runwayFromMonths, CLOSURE_MATRIX: CLOSURE_MATRIX,
      GRADE_RANK: GRADE_RANK
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SIM;

})(typeof window !== 'undefined' ? window : globalThis);
