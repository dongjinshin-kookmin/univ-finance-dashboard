/* app.js — 단일 state + render. 사립대학 교비회계 수지분석 대시보드.
 * 데이터는 <script id="DATA"> 인라인 JSON. 외부 fetch 없음.
 */
(function () {
  'use strict';
  var F = window.FMT, C = window.CHARTS;

  // ── 데이터 로드 ─────────────────────────────────────────
  var raw = document.getElementById('DATA').textContent;
  var DATA;
  try {
    if (/^\s*\/\*__DATA__\*\/\s*$/.test(raw)) throw new Error('데이터 토큰 미치환 — build_html.py로 번들하세요.');
    DATA = JSON.parse(raw);
  } catch (e) {
    document.getElementById('view').innerHTML =
      '<div class="card"><h3>데이터를 불러올 수 없습니다</h3><p class="hint">' + e.message + '</p></div>';
    return;
  }

  var YEARS = DATA.meta.years;
  var Y_FIRST = YEARS[0], Y_LAST = YEARS[YEARS.length - 1];
  var schools = DATA.schools;
  var rows = DATA.rows;
  var LITE = !!DATA.meta.lite;

  // KMU — 국민대 엔티티(색 계약: 파랑 #004F9F 영구 고정). 단일 진실.
  var KMU_ID = schools.findIndex(function (s) { return s.kmu; });
  if (KMU_ID < 0) KMU_ID = 0;

  // ── 기본설정 · 파생 전역 (settings.js) ─────────────────────
  // 색(엔티티 정체성) = KMU_ID→파랑 영구, 강조(분석 주체) = MAIN_ID 추종. 둘을 분리.
  var SET = window.SETTINGS;
  var SCHOOL_NAMES = new Set(schools.map(function (s) { return s.n; }));
  function idByName(name) { return schools.findIndex(function (s) { return s.n === name; }); }

  // 파생 런타임 전역(설정 적용 시 재계산). 초기값은 computeDerived가 채움.
  var SETTINGS_STATE = null;     // 정규화된 현재 설정 {v,mainSchoolName,competitorNames,typeFilter}
  var MAIN_ID = KMU_ID;          // 분석 주체(가변). 기본 = 국민대.
  var MAIN_NAME = schools[KMU_ID] ? schools[KMU_ID].n : '';
  var COMP_IDS = [];             // 경쟁대학 id (메인과 서로소, 1~7)
  var COMP_ID_SET = new Set();
  var TYPE_SET = new Set();      // 전역 기준군(전국·수도권) 집계 대상 형태 — 사이드바 S.types와 독립 축
  var nonMain = [];              // 메인 제외 전체 id

  // 설정 → 파생 전역 재계산(렌더/지속 없음). 이름→id 해석, 메인·경쟁 서로소, 폴백(§7).
  function computeDerived(settings) {
    var norm = SET.normalize(settings, { validNames: SCHOOL_NAMES });
    // 메인 해석: 미해석 시 국민대(없으면 schools[0]) 폴백(§7-5)
    var mid = idByName(norm.mainSchoolName);
    if (mid < 0) mid = (KMU_ID >= 0 ? KMU_ID : 0);
    MAIN_ID = mid;
    MAIN_NAME = schools[MAIN_ID] ? schools[MAIN_ID].n : '';
    norm.mainSchoolName = MAIN_NAME;
    // 경쟁 해석: 미해석 드롭 + 메인 제외(서로소). 공집합 시 기본 6교(메인·미존재 제외).
    var seen = {}, ids = [];
    norm.competitorNames.forEach(function (nm) {
      var i = idByName(nm);
      if (i >= 0 && i !== MAIN_ID && !seen[i]) { seen[i] = 1; ids.push(i); }
    });
    if (ids.length === 0) {
      SET.defaults().competitorNames.forEach(function (nm) {
        var i = idByName(nm);
        if (i >= 0 && i !== MAIN_ID && !seen[i]) { seen[i] = 1; ids.push(i); }
      });
    }
    if (ids.length > 7) ids = ids.slice(0, 7);
    COMP_IDS = ids;
    COMP_ID_SET = new Set(ids);
    // 정규화된 경쟁 이름을 id 기준으로 재작성(가나다 유지)
    norm.competitorNames = SET.sortKo(ids.map(function (i) { return schools[i].n; }));
    TYPE_SET = new Set(norm.typeFilter);
    nonMain = schools.map(function (s, i) { return i; }).filter(function (i) { return i !== MAIN_ID; });
    SETTINGS_STATE = norm;
    setMainVisual();
    return norm;
  }

  // 분석 주체 시각 게이트(§5): data-main 속성 + --main 토큰. 파랑 제품 크롬은 불변.
  function setMainVisual() {
    if (typeof document === 'undefined' || !document.body) return;
    var isKmu = (MAIN_ID === KMU_ID);
    document.body.setAttribute('data-main', isKmu ? 'kmu' : 'other');
    document.documentElement.style.setProperty('--main', isKmu ? 'var(--kmu)' : 'var(--main-alt)');
  }

  // 부트: 저장된 설정 로드 → 파생 전역 확정(S 정의보다 먼저).
  var SETTINGS_LOAD = SET.load();
  computeDerived(SETTINGS_LOAD.settings);

  // row 인덱스 + 값 배열 확장(희소 → 밀집)
  var rowIndex = {};
  rows.forEach(function (r, i) { rowIndex[r[0] + '_' + r[1]] = i; });
  function expand(entry) {
    if (Array.isArray(entry)) return entry;
    var a = new Array(rows.length).fill(null);
    for (var i = 0; i < entry.i.length; i++) a[entry.i[i]] = entry.x[i];
    return a;
  }
  var VIN = {}, VEX = {};
  Object.keys(DATA.v.in).forEach(function (c) { VIN[c] = expand(DATA.v.in[c]); });
  Object.keys(DATA.v.ex).forEach(function (c) { VEX[c] = expand(DATA.v.ex[c]); });

  function ridx(sid, year) { var k = rowIndex[sid + '_' + year]; return k === undefined ? -1 : k; }
  function gv(side, code, sid, year) {
    var arr = (side === 'in' ? VIN : VEX)[code];
    if (!arr) return null;
    var i = ridx(sid, year);
    return i < 0 ? null : arr[i];
  }
  function kv(name, sid, year) {
    var arr = DATA.kpi[name]; if (!arr) return null;
    var i = ridx(sid, year); return i < 0 ? null : arr[i];
  }

  // 계정 맵
  function accMap(side) {
    var m = {}, list = DATA.accounts[side];
    list.forEach(function (a) { m[a.code] = a; });
    return m;
  }
  var ACC = { in: accMap('in'), ex: accMap('ex') };
  function childrenOf(side, code) {
    return DATA.accounts[side].filter(function (a) { return a.p === code; });
  }
  function rootsOf(side) {
    return DATA.accounts[side].filter(function (a) { return a.lv === 1; });
  }

  // ── 확장 데이터(ext) 접근 ───────────────────────────────
  var EXT = DATA.ext || {};
  var HAS_EXT = !!(EXT && EXT.series && EXT.kpi2);
  function exSer(name, sid, year) {
    var arr = EXT.series && EXT.series[name]; if (!arr) return null;
    var i = ridx(sid, year); return i < 0 ? null : arr[i];
  }
  function exK2(name, sid, year) {
    var arr = EXT.kpi2 && EXT.kpi2[name]; if (!arr) return null;
    var i = ridx(sid, year); return i < 0 ? null : arr[i];
  }
  // 학교별 최신 가용 연도의 값 (getter(sid,year) → 값). 폐교/결측 대응.
  function latestOf(getter, sid) {
    for (var k = YEARS.length - 1; k >= 0; k--) {
      var v = getter(sid, YEARS[k]);
      if (v != null && !isNaN(v)) return { v: v, year: YEARS[k] };
    }
    return null;
  }
  function latestScore(sid) {
    var r = latestOf(function (s, y) { return exK2('위기스코어', s, y); }, sid);
    return r ? r.v : null;
  }
  function schoolExtra(sid) { return (EXT.schools_extra && EXT.schools_extra[sid]) || {}; }
  function closedYear(sid) { var e = schoolExtra(sid); return e.closed != null ? e.closed : null; }

  // 시도 → 권역 매핑 + 시도 인구감소율(2024→2040)
  var SIDO_REGION = {};
  schools.forEach(function (s) { if (s.sido) SIDO_REGION[s.sido] = s.region; });
  var SIDO_DECLINE = {};
  (EXT.region_outlook || []).forEach(function (r) { SIDO_DECLINE[r.sido] = r.decline18_2040; });

  // ── 시뮬레이션 데이터(sim 블록) + 계산 엔진(window.SIM) ─────
  var SIMD = DATA.sim || null;            // 데이터: sim.meta · sim.bySchool
  var ENG = window.SIM || null;           // 엔진: project·scenarios·recalcSeries·residualBand
  var HAS_SIM = !!(SIMD && SIMD.bySchool && ENG);
  function simEntry(sid) { return SIMD && SIMD.bySchool ? SIMD.bySchool[String(sid)] : null; }
  function simOpts(sid) { return { meta: SIMD.meta, sido: schools[sid] ? schools[sid].sido : null }; }

  // ── 위기 색상 (dataviz 순차 팔레트: 단일 색조, 명도 단조) ──
  // 라이트: 밝은 주홍 → 진한 적색(고위험 진함). 다크: 어두운 저위험 → 밝은 고위험.
  var RISK_STOPS_LIGHT = [[255, 197, 156], [244, 138, 92], [214, 74, 44], [140, 29, 10]];
  var RISK_STOPS_DARK = [[110, 66, 48], [190, 96, 60], [235, 120, 78], [255, 150, 110]];
  function isDarkTheme() {
    var a = document.documentElement.getAttribute('data-theme');
    if (a === 'dark') return true; if (a === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
  function rampColor(stops, frac) {
    frac = Math.max(0, Math.min(1, frac == null ? 0 : frac));
    var seg = frac * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(seg)), t = seg - i;
    var a = stops[i], b = stops[i + 1];
    return 'rgb(' + lerp(a[0], b[0], t) + ',' + lerp(a[1], b[1], t) + ',' + lerp(a[2], b[2], t) + ')';
  }
  // score 0~100 → hex-ish rgb. 테마 반영.
  function riskColor(score) {
    return rampColor(isDarkTheme() ? RISK_STOPS_DARK : RISK_STOPS_LIGHT, (score == null ? 0 : score) / 100);
  }
  function riskGradientCSS() {
    var st = isDarkTheme() ? RISK_STOPS_DARK : RISK_STOPS_LIGHT;
    return 'linear-gradient(90deg,' + st.map(function (c, i) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ') ' + Math.round(i / (st.length - 1) * 100) + '%'; }).join(',') + ')';
  }
  // 종합 스코어 밴드 (≥70 고위험 / 40~70 주의 / <40 양호)
  function scoreBand(score) { return score == null ? null : (score >= 70 ? 'hi' : (score >= 40 ? 'mid' : 'lo')); }
  var SCORE_BAND_LABEL = { hi: '고위험', mid: '주의', lo: '양호' };
  // 월수·인구·지수 포맷
  function fmtMonths(x) { return x == null || isNaN(x) ? '—' : x.toFixed(1) + '개월'; }
  function fmtPop(v) { if (v == null || isNaN(v)) return '—'; return (v / 10000).toFixed(v >= 100000 ? 0 : 1) + '만명'; }
  function fmtPopAxis(v) { if (v == null || isNaN(v)) return ''; return (v / 10000).toFixed(0) + '만'; }
  function fmtIdx(v) { return v == null || isNaN(v) ? '—' : v.toFixed(0); }

  // ── KPI 메타 ────────────────────────────────────────────
  var KPI_META = {
    '등록금의존율_총계': { label: '등록금의존율(총계)', fmt: 'pct', higher: false, desc: '등록금및수강료수입 ÷ 자금수입총계' },
    '등록금의존율_운영': { label: '등록금의존율(운영)', fmt: 'pct', higher: false, desc: '등록금및수강료수입 ÷ 운영수입' },
    '운영수지': { label: '운영수지', fmt: 'krw', higher: true, desc: '운영수입 − 운영지출' },
    '운영수지율': { label: '운영수지율', fmt: 'pct', higher: true, desc: '(운영수입 − 운영지출) ÷ 운영수입' },
    '법인전입금비율': { label: '법인전입금비율', fmt: 'pct', higher: true, desc: '법인전입금 ÷ 운영수입' },
    '장학금지원율': { label: '장학금지원율', fmt: 'pct', higher: true, desc: '장학금 ÷ 등록금및수강료수입' },
    '인건비부담률': { label: '인건비부담률', fmt: 'pct', higher: false, desc: '보수(인건비) ÷ 등록금및수강료수입' },
    '이월금비율': { label: '이월금비율', fmt: 'pct', higher: false, desc: '미사용차기이월자금 ÷ 자금지출총계' },
    '적립금순증': { label: '적립금순증', fmt: 'krw', higher: true, desc: '적립·기금 적립 − 인출' },
    '교육비환원율': { label: '교육비환원율', fmt: 'pct', higher: true, desc: '총교육비 ÷ 등록금및수강료수입' },
  };
  var KPI_KEYS = Object.keys(KPI_META);
  var OVERVIEW_KPIS = ['등록금의존율_총계', '운영수지율', '법인전입금비율', '장학금지원율', '인건비부담률', '교육비환원율'];
  // KPI별 스쿼클 아이콘 + 파스텔 틴트 색 (장식용 — 데이터 시리즈 아님, 국민대 네이비와 무관)
  var KPI_ICON = {
    '등록금의존율_총계': { ic: 'cap',   c: 'var(--series-1)' },
    '등록금의존율_운영': { ic: 'cap',   c: 'var(--series-1)' },
    '운영수지':         { ic: 'scale', c: 'var(--series-2)' },
    '운영수지율':       { ic: 'scale', c: 'var(--series-2)' },
    '법인전입금비율':   { ic: 'bank',  c: 'var(--series-4)' },
    '장학금지원율':     { ic: 'award', c: 'var(--series-3)' },
    '인건비부담률':     { ic: 'users', c: 'var(--series-5)' },
    '이월금비율':       { ic: 'data',  c: 'var(--series-6)' },
    '적립금순증':       { ic: 'bank',  c: 'var(--series-4)' },
    '교육비환원율':     { ic: 'book',  c: 'var(--series-6)' },
  };
  function kpiIcon(name) { return KPI_ICON[name] || { ic: 'overview', c: 'var(--series-1)' }; }

  // ── 색상 배정 (엔티티 고정) ─────────────────────────────
  var nonKmu = schools.map(function (s, i) { return i; }).filter(function (i) { return i !== KMU_ID; });
  var schoolColorMap = {};
  // 파랑(series-1)은 국민대 전용으로 예약 → 타교는 series-2~8만 순환
  nonKmu.forEach(function (sid, k) { schoolColorMap[sid] = 'var(--series-' + ((k % 7) + 2) + ')'; });
  function schoolColor(sid) { return sid === KMU_ID ? 'var(--kmu)' : schoolColorMap[sid]; }
  // 강조(굵기·★·라벨·마커)는 분석 주체(MAIN_ID) 추종 — 색과 분리(§5).
  // 색은 schoolColor(엔티티: 국민대→파랑 영구), 강조는 schoolEmphasis(메인).
  function schoolEmphasis(sid) { return sid === MAIN_ID; }

  // ── 통계 ────────────────────────────────────────────────
  function quantile(sorted, p) {
    var n = sorted.length; if (!n) return null; if (n === 1) return sorted[0];
    var idx = p * (n - 1), lo = Math.floor(idx), hi = Math.min(lo + 1, n - 1), fr = idx - lo;
    return sorted[lo] * (1 - fr) + sorted[hi] * fr;
  }
  function stats(vals) {
    var s = vals.filter(function (v) { return v != null && !isNaN(v); }).sort(function (a, b) { return a - b; });
    if (!s.length) return null;
    var mean = s.reduce(function (a, b) { return a + b; }, 0) / s.length;
    return { p25: quantile(s, .25), p50: quantile(s, .5), p75: quantile(s, .75), mean: mean, n: s.length, min: s[0], max: s[s.length - 1], all: s };
  }

  // ── 상태 ────────────────────────────────────────────────
  var regionsAll = uniq(schools.map(function (s) { return s.region; }));
  var scalesAll = uniq(schools.map(function (s) { return s.scale; }));
  var typesAll = uniq(schools.map(function (s) { return s.type; }));

  var S = {
    tab: 'home',
    cohort: 'all',
    regions: new Set(regionsAll),
    scales: new Set(scalesAll),
    types: new Set(typesAll),
    y0: Y_FIRST, y1: Y_LAST,
    t2_school: KMU_ID, t2_year: Y_LAST,
    t2_sel: { side: 'ex', code: '4100' },     // {side,code} — 수입/지출 어느 쪽이든 단일 선택
    t2_open: new Set(['ex:4100', 'in:5100']), // "side:code" 확장 노드
    t2_cmode: 'abs',                          // 추이 차트 토글: abs|share
    t3_metric: { type: 'kpi', name: '등록금의존율_총계' },
    t4_schools: [KMU_ID].concat(nonKmu.slice(0, 2)),
    t4_metric: '등록금의존율_총계',
    t4_x: 'enroll', t4_y: '등록금의존율_총계',
    t4_sort: { key: '등록금의존율_총계', asc: false },
    t5_school: KMU_ID, t5_year: Y_LAST, t5_side: 'in',
    t6_traj: KMU_ID,                        // 폐교 궤적 비교 대상 학교
    t7_sidos: new Set(['서울', '경기', '경북']), // 학령인구 절벽 표시 시도
    t7_natl: true,                          // 전국 합계 표시
    // 탭 — 계정 분석
    t8_school: KMU_ID, t8_year: Y_LAST,
    t8_side: 'ex',                          // 'ex' 지출 | 'in' 수입 (기본 지출)
    t8_depth: 'gwanhang',                   // 'gwan'(관) | 'gwanhang'(관+항) | 'mok'(전체·목까지)
    t8_zero: false,                         // 값 0 계정 표시 토글
    t8_hl: null,                            // 인사이트 클릭 → 매트릭스 하이라이트 코드
    // 탭 — 입학정원 감소 시뮬레이션
    sim_school: MAIN_ID,
    sim_focus: null,                        // KPI 델타 포커스 연도(null=투영 종착연도)
    sim_mode: 'single',                     // 'single' 개별 대학 | 'cohort' 코호트 집계(C5)
    sim_closure_all: false,                 // 폐교위험 판정 학교표 전체 펼침(C6)
    sim_params: defaultSimParams(),
  };

  function uniq(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

  // 필터 통과 학교(코호트 모집단). 메인 대학 강제 포함(§2.3 일반화).
  function filteredSchoolIds() {
    var out = [];
    schools.forEach(function (s, i) {
      if (i === MAIN_ID) { out.push(i); return; }
      if (S.cohort === 'c100' && !s.c100) return;
      if (!S.regions.has(s.region)) return;
      if (!S.scales.has(s.scale)) return;
      if (!S.types.has(s.type)) return;
      out.push(i);
    });
    return out;
  }
  // 코호트 KPI 사분위 (필터 실시간 계산)
  function cohortStats(kpiName, year) {
    var pop = filteredSchoolIds();
    var vals = pop.map(function (sid) { return kv(kpiName, sid, year); });
    return stats(vals);
  }

  // ── 전역 기준군 엔진 (benchmark.js) ────────────────────────
  // 전국/수도권/경쟁 코호트 집계. 설정(typeFilter·COMP_IDS·MAIN) 구동, 사이드바 필터와 독립 축.
  var BENCH = window.BENCH.create({
    schools: schools, YEARS: YEARS, kv: kv, stats: stats,
    getMainId: function () { return MAIN_ID; },
    getCompIds: function () { return COMP_IDS; },
    getTypeSet: function () { return TYPE_SET; },
  });

  // ── 설정 적용 (런타임: P1 설정 페이지가 호출) ───────────────
  // ①정규화·파생 전역 재계산 ②기준군 캐시 무효화 ③지속(try/catch) ④refresh() 1회.
  // 반환: { ok, persisted, source, error?, warning? } — P1이 토스트/배너에 사용.
  function applySettings(next) {
    var norm = computeDerived(next);          // 검증·정규화 + 파생 전역 + 시각 게이트
    BENCH.invalidate();                        // 설정 변경 → 기준군 무효화
    var res = SET.save(norm);                  // 지속(전 경로 try/catch)
    refresh();                                 // 무캐시 단일 재렌더로 전파(§2.3)
    return { ok: res.ok, persisted: res.persisted, error: res.error, settings: norm };
  }

  // ═══════════════════════════════════════════════════════
  //  DOM 헬퍼
  // ═══════════════════════════════════════════════════════
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c == null) return; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function chartBox(h_) { var d = document.createElement('div'); d.style.width = '100%'; d.style.height = (h_ || 300) + 'px'; return d; }

  // ── 아이콘 (인라인 SVG, currentColor) ───────────────────
  var IC = {
    home:      '<path d="M3 11.5l9-7.5 9 7.5"/><path d="M5.5 10v9.5h5v-6h3v6h5V10"/>',
    overview:  '<path d="M4 4h7v7H4z"/><path d="M13 4h7v4h-7z"/><path d="M13 11h7v9h-7z"/><path d="M4 14h7v6H4z"/>',
    structure: '<path d="M3 5h18"/><path d="M6 5v14"/><path d="M6 10h9"/><path d="M6 15h6"/>',
    accounts:  '<path d="M4 5h16"/><path d="M4 10h9"/><path d="M4 15h5"/><circle cx="16" cy="15.5" r="3.4"/><path d="M18.4 17.9 21 20.5"/>',
    timeseries:'<path d="M3 3v18h18"/><path d="M7 14l3-4 3 3 4-6"/>',
    compare:   '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M4 20h16"/>',
    data:      '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    cap:       '<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1 2.7 2 6 2s6-1 6-2v-5"/>',
    scale:     '<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-2.5 6h5z"/><path d="M19 7l-2.5 6h5z"/><path d="M8 21h8"/>',
    bank:      '<path d="M3 10l9-6 9 6"/><path d="M5 10v8"/><path d="M9 10v8"/><path d="M15 10v8"/><path d="M19 10v8"/><path d="M3 21h18"/>',
    award:     '<circle cx="12" cy="9" r="5"/><path d="M9 13.5L8 21l4-2 4 2-1-7.5"/>',
    users:     '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5a3.5 3.5 0 0 1 0 7"/><path d="M21 20a6 6 0 0 0-4-5.6"/>',
    book:      '<path d="M4 4h9a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H4z"/><path d="M20 4h-4a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2.5H20z"/>',
    crisis:    '<path d="M12 3l9 16H3z"/><path d="M12 10v4"/><path d="M12 17.5v.5"/>',
    outlook:   '<path d="M3 3v18h18"/><path d="M20 8l-6 7-4-3-5 6"/><circle cx="20" cy="8" r="1.4"/>',
    shield:    '<path d="M12 3l7 3v5c0 4.4-3 8-7 10-4-2-7-5.6-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    simulation:'<path d="M4 7h9"/><circle cx="16" cy="7" r="2.4"/><path d="M18.5 7H20"/><path d="M4 12h2.5"/><circle cx="10" cy="12" r="2.4"/><path d="M12.5 12H20"/><path d="M4 17h11"/><circle cx="18" cy="17" r="2.4"/>',
    settings:  '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>'
  };
  function svgIcon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + (IC[name] || IC.overview) + '</svg>';
  }
  // 스쿼클/아이콘 컨테이너: 색 틴트 배경 + 컬러 글리프
  function iconTile(cls, name, colorVar) {
    return h('span', { class: cls + ' sq', style: 'color:' + colorVar + ';background:color-mix(in srgb,' + colorVar + ' 14%,transparent)', html: svgIcon(name) });
  }
  // 틱(세로 세그먼트) 프로그레스 미터
  function tickMeter(frac, colorVar, ticks) {
    ticks = ticks || 18;
    frac = Math.max(0, Math.min(1, frac == null ? 0 : frac));
    var fill = Math.round(frac * ticks);
    var m = h('div', { class: 'tick-meter' });
    for (var i = 0; i < ticks; i++) {
      var on = i < fill;
      m.appendChild(h('span', { class: 'tick' + (on ? ' fill' : ''), style: on ? 'background:' + colorVar : '' }));
    }
    return m;
  }
  // 둥근 사각형 막대 미터 (rounded-rect bar) — 강조형 tick/pill 막대 대체용
  function barMeter(frac, colorVar) {
    frac = Math.max(0, Math.min(1, frac == null ? 0 : frac));
    return h('div', { class: 'rrbar' }, [
      h('div', { class: 'rrbar-fill', style: 'width:' + (frac * 100).toFixed(1) + '%;background:' + colorVar })
    ]);
  }
  // 관/항/목 숫자 코드 배지 (컬러 스쿼클 안에 계정코드). depth 0=관,1=항,2=목.
  function codeBadge(code, colorVar, depth) {
    var bgPct = depth === 0 ? 22 : depth === 1 ? 13 : 7;
    var brPct = depth === 0 ? 55 : depth === 1 ? 38 : 24;
    var style = 'color:' + colorVar +
      ';background:color-mix(in srgb,' + colorVar + ' ' + bgPct + '%,var(--surface-1))' +
      ';border-color:color-mix(in srgb,' + colorVar + ' ' + brPct + '%,transparent)';
    return h('span', { class: 'tcode lv' + (depth + 1), style: style, text: code });
  }

  // 파이 글리프 (백분위 부분 채움 원)
  function pieGlyph(frac, colorVar) {
    frac = Math.max(0, Math.min(1, frac == null ? 0 : frac));
    var cx = 9, cy = 9, r = 7.5, a = frac * 2 * Math.PI;
    var x = (cx + r * Math.sin(a)).toFixed(2), y = (cy - r * Math.cos(a)).toFixed(2);
    var large = frac > 0.5 ? 1 : 0;
    var wedge = frac >= 0.999
      ? '<circle cx="9" cy="9" r="7.5" style="fill:' + colorVar + '"/>'
      : (frac <= 0.001 ? '' : '<path d="M9 9 L9 1.5 A7.5 7.5 0 ' + large + ' 1 ' + x + ' ' + y + ' Z" style="fill:' + colorVar + '"/>');
    return h('span', { class: 'pie-glyph', html:
      '<svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="7.5" style="fill:var(--surface-3)"/>' + wedge +
      '<circle cx="9" cy="9" r="7.5" fill="none" style="stroke:var(--border-strong)" stroke-width="1"/></svg>' });
  }
  // 카드 헤더 (스쿼클 아이콘 + 제목/부제)
  function cardHead(iconName, colorVar, title, sub) {
    return h('div', { class: 'card-head' }, [
      iconTile('ch-ico', iconName, colorVar),
      h('div', { class: 'ch-txt' }, [h('h3', { text: title }), sub ? h('div', { class: 'card-sub', text: sub }) : null]),
    ]);
  }

  // ═══════════════════════════════════════════════════════
  //  필터바
  // ═══════════════════════════════════════════════════════
  function chipRow(label, values, selectedSet, onToggle, single) {
    var row = h('div', { class: 'chip-row' });
    values.forEach(function (v) {
      var on = single ? (selectedSet === v) : selectedSet.has(v);
      var chip = h('button', { class: 'chip' + (on ? ' on' : ''), text: v, onClick: function () { onToggle(v); } });
      row.appendChild(chip);
    });
    return h('div', { class: 'filter-group' }, [h('label', { text: label }), row]);
  }

  function renderFilterbar() {
    var fb = document.getElementById('filterbar');
    fb.innerHTML = '';
    // 코호트
    fb.appendChild(chipRow('코호트', ['전체', '100개'],
      S.cohort === 'all' ? '전체' : '100개',
      function (v) { S.cohort = v === '전체' ? 'all' : 'c100'; refresh(); }, true));
    // 권역
    fb.appendChild(chipRow('권역', regionsAll, S.regions, function (v) { toggleSet(S.regions, v, regionsAll); refresh(); }));
    // 규모
    fb.appendChild(chipRow('규모', scalesAll, S.scales, function (v) { toggleSet(S.scales, v, scalesAll); refresh(); }));
    // 학교구분
    fb.appendChild(chipRow('학교구분', typesAll, S.types, function (v) { toggleSet(S.types, v, typesAll); refresh(); }));
    // 연도 슬라이더 (범위)
    var y0i = h('input', { type: 'range', min: Y_FIRST, max: Y_LAST, value: S.y0, step: 1 });
    var y1i = h('input', { type: 'range', min: Y_FIRST, max: Y_LAST, value: S.y1, step: 1 });
    var lbl0 = h('span', { class: 'yr', text: S.y0 }), lbl1 = h('span', { class: 'yr', text: S.y1 });
    y0i.addEventListener('input', function () { var v = +y0i.value; if (v > S.y1) v = S.y1; S.y0 = v; y0i.value = v; lbl0.textContent = v; refresh(); });
    y1i.addEventListener('input', function () { var v = +y1i.value; if (v < S.y0) v = S.y0; S.y1 = v; y1i.value = v; lbl1.textContent = v; refresh(); });
    var slid = h('div', { class: 'filter-group' }, [
      h('label', { text: '연도 범위' }),
      h('div', { class: 'year-slider' }, [lbl0, y0i, y1i, lbl1])
    ]);
    fb.appendChild(slid);
  }
  function toggleSet(set, v, all) {
    if (set.has(v)) { if (set.size > 1) set.delete(v); } else set.add(v);
  }

  // ═══════════════════════════════════════════════════════
  //  탭 네비
  // ═══════════════════════════════════════════════════════
  var TABS = [
    { id: 'home', label: '홈', title: '홈', eyebrow: 'Home · 시작하기' },
    { id: 'overview', label: '개요', title: '개요', eyebrow: 'Overview · 국민대학교 핵심 진단' },
    { id: 'structure', label: '수지 구조', title: '수지 구조', eyebrow: 'Structure · 관·항·목 드릴다운' },
    { id: 'accounts', label: '계정 분석', title: '계정 분석', eyebrow: 'Account Analysis · 전 계정 자동 인사이트 + 벤치마크 매트릭스' },
    { id: 'timeseries', label: '시계열', title: '시계열 추이', eyebrow: 'Time Series · KPI 시계열' },
    { id: 'compare', label: '대학 비교', title: '대학 비교', eyebrow: 'Comparison · 코호트 벤치마크' },
    { id: 'crisis', label: '위기 진단', title: '위기 진단', eyebrow: 'Risk Diagnosis · 구조 리스크 지수(참고용)' },
    { id: 'outlook', label: '구조 전망', title: '구조 전망', eyebrow: 'Outlook · 학령인구 절벽과 수요-공급' },
    { id: 'simulation', label: '감축 시뮬레이션', title: '입학정원 감소 시뮬레이션', eyebrow: 'Simulation · 정원 감축 시나리오 (베타 · 가정 기반)' },
    { id: 'data', label: '데이터·검증', title: '데이터 · 검증', eyebrow: 'Data · 항등식 검증과 원장' },
    { id: 'settings', label: '기본설정', title: '기본설정', eyebrow: 'Settings · 메인 대학 · 경쟁대학 · 기준군', foot: true },
  ];
  function renderTabs() {
    var nav = document.getElementById('tabs');
    nav.innerHTML = '';
    TABS.forEach(function (t, i) {
      var ico = h('span', { class: 'ni-ico', html: svgIcon(t.id) });
      var lab = h('span', { class: 'ni-label', text: t.label });
      nav.appendChild(h('button', {
        class: 'navitem' + (S.tab === t.id ? ' on' : ''), title: t.label,
        onClick: function () { S.tab = t.id; closeDrawer(); render(); }
      }, [ico, lab]));
    });
  }

  function refresh() { renderFilterbar(); render(); }
  function render() {
    renderTabs();
    var t = TABS.filter(function (x) { return x.id === S.tab; })[0];
    document.body.setAttribute('data-tab', S.tab);   // 홈에서 스테이지 대형 타이틀 숨김(CSS)
    var eb = document.getElementById('stageEyebrow'); if (eb) eb.textContent = t ? t.eyebrow : '';
    var st = document.getElementById('stageTitle'); if (st) st.textContent = t ? t.title : '';
    var cr = document.getElementById('crumbTab'); if (cr) cr.textContent = t ? t.title : '';
    var v = document.getElementById('view');
    v.innerHTML = '';
    ({ home: renderHome, overview: renderOverview, structure: renderStructure, accounts: renderAccounts, timeseries: renderTimeseries, compare: renderCompare, crisis: renderCrisis, outlook: renderOutlook, simulation: renderSimulation, data: renderData, settings: renderSettings })[S.tab](v);
  }

  // ═══════════════════════════════════════════════════════
  //  탭 10 — 기본설정 (P1)
  // ═══════════════════════════════════════════════════════
  // 편집은 인메모리 초안(draft)에 즉시 반영(미리보기 카운트 갱신), "저장"에서만
  // applySettings()로 지속 + 파생전역 재계산 + refresh(). 저장 시 typeFilter를
  // S.types(사이드바)에도 반영(기본설정=전역 필터라는 사용자 멘탈 모델과 일치).
  // 색/강조는 schoolColor(엔티티)·schoolEmphasis(메인), SET(window.SETTINGS)로 이관.

  // 화면에 잠깐 떠서 알리는 토스트(#view 밖 body에 붙어 재렌더에도 생존).
  function settingsToast(text, kind) {
    if (typeof document === 'undefined' || !document.body) return;
    var t = h('div', { class: 'settings-toast' + (kind ? ' ' + kind : ''), text: text });
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
    }, 2600);
  }
  // 초안 typeFilter로 전국·수도권 멤버수 미리보기(적용 전이므로 BENCH 대신 직접 계산).
  function previewCounts(typeFilter) {
    var ts = new Set(typeFilter), nat = 0, metro = 0;
    schools.forEach(function (s) { if (ts.has(s.type)) { nat++; if (s.region === '수도권') metro++; } });
    return { national: nat, metro: metro };
  }

  function renderSettings(v) {
    // 진입 시마다 현재 적용 설정의 사본으로 초안 시작(적용 전 편집 = 미리보기).
    var draft = JSON.parse(JSON.stringify(SETTINGS_STATE));
    var host = h('div', { class: 'settings-page' });
    v.appendChild(host);

    function build() {
      host.innerHTML = '';
      var mainId = idByName(draft.mainSchoolName);
      var mainOk = mainId >= 0;
      var dispMainId = mainOk ? mainId : (KMU_ID >= 0 ? KMU_ID : 0);

      // ── 카드 ① 메인 분석 대학 ─────────────────────────────
      var mainInfo = h('div', { class: 'set-mainbox' });
      var ms = schools[dispMainId];
      var enr = enrollOf(dispMainId, Y_LAST);
      var finR = latestOf(function (s, y) { return kv('운영수지율', s, y); }, dispMainId);
      mainInfo.appendChild(h('div', { class: 'set-mainname' }, [
        h('span', { class: 'set-mainbadge', text: '메인' }),
        h('strong', { text: mainOk ? ms.n : (draft.mainSchoolName + ' (미해석 → ' + ms.n + ')') }),
        schools[dispMainId].kmu ? h('span', { class: 'set-kmu-tag', text: '국민대' }) : null,
      ]));
      mainInfo.appendChild(h('div', { class: 'set-mainmeta', text:
        ms.region + ' · ' + ms.scale + (enr ? ' · 재학생 ' + enr.toLocaleString() + '명(' + Y_LAST + ')' : ' · 재학생 정보 없음') }));
      if (!finR) mainInfo.appendChild(h('div', { class: 'set-warn-inline', text: '⚠ 최근 재무데이터가 없어 일부 지표가 표시되지 않을 수 있습니다.' }));

      var mainSearch = buildSchoolSearch(dispMainId, function (i) {
        var nm = schools[i].n;
        draft.mainSchoolName = nm;
        // 메인이 경쟁에 있으면 자동 제외(서로소, §7-1)
        var idx = draft.competitorNames.indexOf(nm);
        if (idx >= 0) {
          draft.competitorNames.splice(idx, 1);
          build();
          settingsToast('메인 대학은 경쟁대학에서 자동 제외되었습니다', 'warn');
          return;
        }
        build();
      }, 300);

      host.appendChild(h('div', { class: 'card' }, [
        cardHead('settings', 'var(--main)', '① 메인 분석 대학', '분석 주체가 되는 대학 (기본 국민대학교)'),
        mainSearch,
        mainInfo,
      ]));

      // ── 카드 ② 경쟁대학 (1~7) ─────────────────────────────
      var comps = SET.sortKo(draft.competitorNames);
      var chipRow = h('div', { class: 'set-chips' });
      comps.forEach(function (nm) {
        var cid = idByName(nm);
        var chip = h('span', { class: 'set-chip', html:
          '<i style="background:' + C.resolveColor(cid >= 0 ? schoolColor(cid) : 'var(--muted)') + '"></i>' + nm });
        var x = h('span', { class: 'set-chip-x' + (comps.length <= 1 ? ' off' : ''), text: '✕' });
        if (comps.length > 1) {
          x.addEventListener('click', function () {
            var idx = draft.competitorNames.indexOf(nm);
            if (idx >= 0) draft.competitorNames.splice(idx, 1);
            build();
          });
        } else {
          x.setAttribute('title', '경쟁대학은 최소 1개가 필요합니다');
        }
        chip.appendChild(x);
        chipRow.appendChild(chip);
      });

      var addSearch = buildSchoolSearch(dispMainId, function (i) {
        var nm = schools[i].n;
        if (nm === draft.mainSchoolName) { settingsToast('메인 대학은 경쟁대학에 추가할 수 없습니다', 'warn'); return; }
        if (draft.competitorNames.indexOf(nm) >= 0) { settingsToast('이미 추가된 경쟁대학입니다', 'warn'); return; }
        if (draft.competitorNames.length >= 7) { settingsToast('경쟁대학은 최대 7개까지 추가할 수 있습니다', 'warn'); return; }
        draft.competitorNames.push(nm);
        build();
      }, 300);

      var restore6 = h('button', { class: 'btn-mini', type: 'button', text: '기본 6개교 복원',
        onClick: function () {
          var d = SET.defaults().competitorNames.filter(function (n) {
            return n !== draft.mainSchoolName && SCHOOL_NAMES.has(n);
          });
          draft.competitorNames = d;
          build();
          settingsToast('기본 경쟁 6개교로 되돌렸습니다 (저장 필요)', 'ok');
        } });

      host.appendChild(h('div', { class: 'card' }, [
        cardHead('compare', 'var(--series-4)', '② 경쟁대학', '개별 비교선으로 쓰이는 대학 (1~7개, 집계 필터 미적용)'),
        h('div', { class: 'set-count-tag', text: comps.length + ' / 7개' }),
        chipRow,
        h('div', { class: 'set-addrow' }, [
          h('span', { class: 'set-addlabel', text: '추가 —' }),
          addSearch,
          restore6,
        ]),
      ]));

      // ── 카드 ③ 집계 필터(typeFilter) ─────────────────────
      var pc = previewCounts(draft.typeFilter);
      var typeSet = new Set(draft.typeFilter);
      var typeRow = h('div', { class: 'set-types' });
      SET.ALL_TYPES.forEach(function (ty) {
        var on = typeSet.has(ty);
        var cnt = schools.filter(function (s) { return s.type === ty; }).length;
        var b = h('button', { class: 'set-typechip' + (on ? ' on' : ''), type: 'button',
          html: '<span class="stc-check">' + (on ? '✓' : '') + '</span>' + ty + ' <span class="stc-n">' + cnt + '</span>',
          onClick: function () {
            if (on && draft.typeFilter.length <= 1) { settingsToast('집계 형태는 최소 1개가 필요합니다', 'warn'); return; }
            if (on) draft.typeFilter = draft.typeFilter.filter(function (t) { return t !== ty; });
            else draft.typeFilter = draft.typeFilter.concat([ty]);
            build();
          } });
        typeRow.appendChild(b);
      });
      var mainType = schools[dispMainId].type;
      var mainExcluded = !typeSet.has(mainType);
      host.appendChild(h('div', { class: 'card' }, [
        cardHead('data', 'var(--series-5)', '③ 집계 필터', '전국·수도권 기준군의 집계 대상 형태 (경쟁대학에는 미적용)'),
        typeRow,
        h('div', { class: 'set-counts' }, [
          h('span', { class: 'set-countpill', html: '전국 <b>' + pc.national + '</b>' }),
          h('span', { class: 'set-countpill', html: '수도권 <b>' + pc.metro + '</b>' }),
          h('span', { class: 'set-countpill', html: '경쟁 <b>' + comps.length + '</b>' }),
        ]),
        mainExcluded ? h('div', { class: 'set-warn-inline', text:
          '⚠ 메인 대학(' + mainType + ')이 현재 집계 필터에 포함되지 않아, 전국·수도권 집계 모집단에서는 제외되고 개별 값으로만 표시됩니다.' }) : null,
      ]));

      // ── 카드 ④ 저장 · 초기화 · 이관 ──────────────────────
      var storable = SET.storageAvailable();
      var saveBtn = h('button', { class: 'btn-primary', type: 'button', text: '저장',
        onClick: function () {
          // 저장 시 typeFilter를 S.types(사이드바)에도 동기화(전역 필터 일치).
          S.types = new Set(draft.typeFilter);
          var res = applySettings(draft);   // 정규화·파생전역·지속·refresh() 1회(→ 이 페이지 재렌더)
          if (res.persisted) settingsToast('저장되었습니다', 'ok');
          else settingsToast(res.error || '세션에만 적용됩니다 — 내보내기로 백업하세요', 'warn');
        } });
      var resetBtn = h('button', { class: 'btn-ghost', type: 'button', text: '기본값 복원',
        onClick: function () {
          if (!window.confirm('모든 설정을 기본값(메인=국민대학교, 경쟁 6개교, 집계=대학)으로 되돌립니다. 계속할까요?')) return;
          draft = SET.defaults();
          build();
          settingsToast('기본값으로 되돌렸습니다 (저장을 눌러 적용)', 'ok');
        } });

      var actions = h('div', { class: 'set-actions' }, [saveBtn, resetBtn]);

      // 내보내기 / 가져오기
      var exArea = h('textarea', { class: 'set-json', readonly: 'readonly', rows: '5' });
      exArea.value = SET.exportJSON(draft);
      var copyBtn = h('button', { class: 'btn-mini', type: 'button', text: '클립보드 복사',
        onClick: function () {
          var done = function () { settingsToast('설정 JSON을 복사했습니다', 'ok'); };
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(exArea.value).then(done, function () { exArea.select(); settingsToast('복사 실패 — 텍스트를 직접 선택해 복사하세요', 'warn'); });
            } else { exArea.select(); document.execCommand && document.execCommand('copy'); done(); }
          } catch (e) { exArea.select(); settingsToast('복사 실패 — 텍스트를 직접 선택해 복사하세요', 'warn'); }
        } });
      var imArea = h('textarea', { class: 'set-json', rows: '5', placeholder: '내보낸 설정 JSON을 붙여넣고 "가져오기"를 누르세요…' });
      var imBtn = h('button', { class: 'btn-mini', type: 'button', text: '가져오기',
        onClick: function () {
          var txt = imArea.value.trim();
          if (!txt) { settingsToast('가져올 JSON을 붙여넣으세요', 'warn'); return; }
          var res = SET.importJSON(txt);
          if (!res.ok) { settingsToast(res.error || 'JSON을 인식할 수 없습니다', 'warn'); return; }
          draft = SET.normalize(res.settings, { validNames: SCHOOL_NAMES });
          build();
          settingsToast('가져왔습니다 — "저장"을 눌러 적용하세요', 'ok');
        } });

      var transfer = h('div', { class: 'set-transfer' }, [
        h('div', { class: 'set-transfer-col' }, [
          h('div', { class: 'set-sub', text: '내보내기 — 현재 편집 중인 설정' }),
          exArea, copyBtn,
        ]),
        h('div', { class: 'set-transfer-col' }, [
          h('div', { class: 'set-sub', text: '가져오기 — JSON 붙여넣기' }),
          imArea, imBtn,
        ]),
      ]);

      host.appendChild(h('div', { class: 'card' }, [
        cardHead('settings', 'var(--main)', '④ 저장 · 이관', '변경은 저장 전까지 미리보기입니다'),
        !storable ? h('div', { class: 'set-warn-banner', text:
          '이 브라우저에서는 설정이 저장되지 않습니다 — 아래 내보내기로 백업하세요.' }) : null,
        actions,
        transfer,
      ]));
    }

    build();
  }

  // ═══════════════════════════════════════════════════════
  //  탭 0 — 홈 (랜딩)
  // ═══════════════════════════════════════════════════════
  // 메뉴 카드: 사이드바 아이콘 + 메뉴명 + 한 줄 설명 + 이동. 아이콘 틴트색만 장식.
  var HOME_CARDS = [
    { id: 'overview',   c: 'var(--kmu)',      desc: '국민대 핵심 지표 6종과 코호트 대비 위치를 한눈에' },
    { id: 'structure',  c: 'var(--series-3)', desc: '관→항→목 드릴다운과 선택 계정 심층 분석' },
    { id: 'accounts',   c: 'var(--series-5)', desc: '전 계정 자동 인사이트와 벤치마크 매트릭스' },
    { id: 'timeseries', c: 'var(--series-2)', desc: 'KPI 10종의 9개년 추이를 코호트 밴드와 비교' },
    { id: 'compare',    c: 'var(--series-4)', desc: '최대 8개 대학 나란히 비교하고 랭킹 확인' },
    { id: 'crisis',     c: 'var(--series-7)', desc: '충원율×등록금의존율 매트릭스와 구조 리스크 지수' },
    { id: 'outlook',    c: 'var(--series-6)', desc: '학령인구 절벽과 권역별 수요-공급 전망' },
    { id: 'simulation', c: 'var(--kmu)',      desc: '입학정원 감축 시나리오의 수입·수지·KPI 파급(베타)' },
    { id: 'data',       c: 'var(--series-1)', desc: '원데이터 탐색, 항등식 검증, CSV 다운로드' },
  ];
  function goTab(id) { S.tab = id; closeDrawer(); window.scrollTo(0, 0); render(); }

  function renderHome(v) {
    var wrap = h('div', { class: 'home' });
    var isKmuMain = (MAIN_ID === KMU_ID);

    // ── 히어로 (메인=국민대 → 80주년 캠퍼스 사진, 그 외 → 중립 그라데이션) ──
    // 히어로 스탯은 분석 주체(MAIN_ID) 기준. 사진 게이트는 body[data-main]로 CSS 처리.
    var stats = h('div', { class: 'hero-stats' });
    [
      { name: '등록금의존율_총계', label: '등록금의존율' },
      { name: '운영수지율', label: '운영수지율' },
      { name: '교육비환원율', label: '교육비환원율' },
    ].forEach(function (s) {
      var meta = KPI_META[s.name];
      var r = latestOf(function (sid, y) { return kv(s.name, sid, y); }, MAIN_ID);
      stats.appendChild(h('div', { class: 'hero-stat' }, [
        h('div', { class: 'hs-val', text: r ? F.byFmt(r.v, meta.fmt) : '—' }),
        h('div', { class: 'hs-lab', text: s.label + (r ? ' · ' + r.year : '') }),
      ]));
    });

    var eyebrowMark = h('span', { class: 'brand-mark sq' + (isKmuMain ? '' : ' main'),
      text: isKmuMain ? 'KMU' : (MAIN_NAME ? MAIN_NAME.slice(0, 2) : '대학') });
    var eyebrowTxt = h('span', { text: isKmuMain ? '국민대학교 · 개교 80주년 캠퍼스' : (MAIN_NAME + ' · 분석 주체 대학') });

    var hero = h('div', { class: 'home-hero' }, [
      h('div', { class: 'home-hero-scrim' }),
      h('div', { class: 'home-hero-inner' }, [
        h('div', { class: 'hero-eyebrow' }, [eyebrowMark, eyebrowTxt]),
        h('h1', { class: 'hero-title', text: '사립대학 교비회계 수지분석' }),
        h('p', { class: 'hero-sub', text:
          Y_FIRST + '~' + Y_LAST + ' · ' + schools.length + '개교 · 사학기관 재무·회계 특례규칙 기준' }),
        stats,
      ]),
    ]);
    wrap.appendChild(hero);

    // ── 현재 기준 설정 요약 카드 + 기본설정 버튼(§6.2) ──
    var bc = BENCH.counts();
    var summaryCompChips = h('div', { class: 'set-chips' });
    SET.sortKo(SETTINGS_STATE.competitorNames).forEach(function (nm) {
      var cid = idByName(nm);
      summaryCompChips.appendChild(h('span', { class: 'set-chip static', html:
        '<i style="background:' + C.resolveColor(cid >= 0 ? schoolColor(cid) : 'var(--muted)') + '"></i>' + nm }));
    });
    var settingsBtn = h('button', { class: 'home-settings-btn', type: 'button',
      onClick: function () { goTab('settings'); } }, [
        h('span', { class: 'ni-ico', html: svgIcon('settings') }),
        h('span', { text: '기본설정' }),
        h('span', { class: 'hsb-arrow', text: '→' }),
      ]);
    wrap.appendChild(h('div', { class: 'home-settings' }, [
      h('div', { class: 'hs-body' }, [
        h('div', { class: 'hs-eyebrow', text: '현재 기준 설정' }),
        h('div', { class: 'hs-main' }, [
          h('span', { class: 'set-mainbadge', text: '메인' }),
          h('strong', { text: MAIN_NAME }),
          isKmuMain ? h('span', { class: 'set-kmu-tag', text: '국민대' }) : null,
        ]),
        h('div', { class: 'hs-row' }, [
          h('span', { class: 'hs-rowlabel', text: '경쟁대학 ' + SETTINGS_STATE.competitorNames.length + '개교' }),
          summaryCompChips,
        ]),
        h('div', { class: 'hs-row' }, [
          h('span', { class: 'hs-rowlabel', text: '집계 필터' }),
          h('span', { class: 'hs-filterval', text: SETTINGS_STATE.typeFilter.join(' · ') }),
        ]),
        h('div', { class: 'set-counts' }, [
          h('span', { class: 'set-countpill', html: '전국 <b>' + bc.national + '</b>' }),
          h('span', { class: 'set-countpill', html: '수도권 <b>' + bc.metro + '</b>' }),
          h('span', { class: 'set-countpill', html: '경쟁 <b>' + bc.competitor + '</b>' }),
        ]),
      ]),
      settingsBtn,
    ]));

    // ── 메뉴 안내 카드 그리드 ──
    wrap.appendChild(h('div', { class: 'home-menu-head' }, [
      h('span', { class: 'hm-eyebrow', text: '메뉴' }),
      h('span', { class: 'hm-desc', text: '분석 화면을 선택하세요 — 카드를 누르면 해당 탭으로 이동합니다' }),
    ]));
    var menu = h('div', { class: 'home-menu' });
    HOME_CARDS.forEach(function (card) {
      var t = TABS.filter(function (x) { return x.id === card.id; })[0];
      if (!t) return;
      menu.appendChild(h('button', {
        class: 'home-card', type: 'button', onClick: function () { goTab(card.id); },
      }, [
        iconTile('hc-ico', t.id, card.c),
        h('div', { class: 'hc-txt' }, [
          h('div', { class: 'hc-name', text: t.label }),
          h('div', { class: 'hc-desc', text: card.desc }),
        ]),
        h('span', { class: 'hc-arrow', text: '→' }),
      ]));
    });
    wrap.appendChild(menu);
    v.appendChild(wrap);
  }

  // ═══════════════════════════════════════════════════════
  //  탭 1 — 개요
  // ═══════════════════════════════════════════════════════
  function renderOverview(v) {
    var yr = S.y1;
    // KPI 카드 6
    v.appendChild(h('div', { class: 'card' }, [
      cardHead('overview', 'var(--kmu)', '핵심 지표 — 국민대학교 ' + yr + '년',
        '값 · Δ전년(개선 초록/악화 빨강) · 코호트 백분위 · 미니 추이 · 중앙값 대비 인사이트. 카드 클릭 → 시계열'),
    ]));
    var grid = h('div', { class: 'grid k6' });
    OVERVIEW_KPIS.forEach(function (name) {
      var meta = KPI_META[name], kc = kpiIcon(name);
      var cur = kv(name, KMU_ID, yr), prev = kv(name, KMU_ID, yr - 1);
      var delta = (cur != null && prev != null) ? cur - prev : null;
      var cs = cohortStats(name, yr);
      var med = cs ? cs.p50 : null;

      // 코호트 백분위 (지표 방향 반영 → "좋은 방향" 기준 상위 비율)
      var pctile = null;
      if (cs && cur != null) {
        var below = cs.all.filter(function (val) { return val < cur; }).length;
        var raw = cs.all.length > 1 ? below / (cs.all.length - 1) : 1;
        pctile = meta.higher === false ? 1 - raw : raw;
      }

      // 델타 필 (방향 = higher 반영)
      var deltaGood = (delta == null || meta.higher == null) ? null : ((delta >= 0) === meta.higher);
      var pillCls = delta == null ? 'flat' : (deltaGood == null ? 'flat' : (deltaGood ? 'up' : 'down'));
      var arrow = delta == null ? '–' : (delta > 0 ? '▲' : (delta < 0 ? '▼' : '–'));
      var dMag = delta == null ? '—' : (meta.fmt === 'pct' ? Math.abs(delta * 100).toFixed(1) + '%p' : F.krw(Math.abs(delta)));

      // 인사이트 배너 (실데이터: 코호트 중앙값 대비)
      var insCls = 'neutral', insTxt = '코호트 데이터 부족';
      if (med != null && cur != null) {
        var hi = cur > med;
        var good = meta.higher == null ? null : (hi === meta.higher);
        var mag = meta.fmt === 'pct' ? Math.abs((cur - med) * 100).toFixed(1) + '%p' : F.krw(Math.abs(cur - med));
        insCls = good == null ? 'neutral' : (good ? 'good' : 'bad');
        insTxt = '코호트 중앙값보다 ' + mag + ' ' + (hi ? '높습니다' : '낮습니다');
      }

      var mini = chartBox(44); mini.className = 'kpi-mini';
      var card = h('div', { class: 'kpi-card card', onClick: function () { S.tab = 'timeseries'; S.t3_metric = { type: 'kpi', name: name }; render(); } }, [
        h('div', { class: 'kpi-head' }, [
          iconTile('kpi-icon', kc.ic, kc.c),
          h('div', { class: 'kpi-titles' }, [
            h('div', { class: 'kpi-name', text: meta.label }),
            h('div', { class: 'kpi-sub', text: '국민대 · ' + yr + '년' }),
          ]),
        ]),
        h('div', { class: 'kpi-valrow' }, [
          h('div', { class: 'kpi-value', text: F.byFmt(cur, meta.fmt) }),
          h('span', { class: 'delta-pill ' + pillCls, html: arrow + ' ' + dMag + ' <span class="dp-vs">vs ' + (yr - 1) + '</span>' }),
        ]),
        h('div', { class: 'meter-row' }, [
          h('span', { class: 'meter-lab', text: '코호트 백분위' }),
          tickMeter(pctile, kc.c),
          h('span', { class: 'meter-val', style: 'color:' + kc.c, text: pctile == null ? '—' : F.percentileLabel(pctile) }),
        ]),
        mini,
        h('div', { class: 'insight ' + insCls }, [h('span', { text: insTxt }), h('span', { class: 'in-arrow', text: '→' })]),
      ]);
      grid.appendChild(card);
      var pts = YEARS.filter(function (y) { return y >= S.y0 && y <= S.y1; }).map(function (y) { return [y, kv(name, KMU_ID, y)]; });
      C.miniBars(mini, { points: pts, color: kc.c, height: 44, fmt: function (x) { return F.byFmt(x, meta.fmt); } });
    });
    // ── 7번째 카드: 재정 완충력 (적립금 지속가능월수) ──
    if (HAS_EXT) {
      var bc = { ic: 'shield', c: 'var(--series-2)' };
      var months = fmtMonths;
      var curM = exK2('적립금지속월수', KMU_ID, yr), prevM = exK2('적립금지속월수', KMU_ID, yr - 1);
      var dM = (curM != null && prevM != null) ? curM - prevM : null;
      // 코호트 백분위(월수 많을수록 완충 우위 → higher good)
      var pop = filteredSchoolIds();
      var msVals = pop.map(function (sid) { return exK2('적립금지속월수', sid, yr); });
      var csM = stats(msVals), medM = csM ? csM.p50 : null, pctM = null;
      if (csM && curM != null) { var belowM = csM.all.filter(function (x) { return x < curM; }).length; pctM = csM.all.length > 1 ? belowM / (csM.all.length - 1) : 1; }
      var dGood = dM == null ? null : dM >= 0;
      var pillM = dM == null ? 'flat' : (dGood ? 'up' : 'down');
      var arrM = dM == null ? '–' : (dM > 0 ? '▲' : (dM < 0 ? '▼' : '–'));
      var magM = dM == null ? '—' : Math.abs(dM).toFixed(1) + '개월';
      var insMcls = 'neutral', insM = '운영지출 기준 ' + (curM == null ? '—' : curM.toFixed(1)) + '개월치 적립금 확보';
      if (medM != null && curM != null) { var hiM = curM > medM; insMcls = hiM ? 'good' : 'bad'; insM = '운영지출 ' + curM.toFixed(1) + '개월분 — 코호트 중앙값(' + medM.toFixed(1) + '개월)보다 ' + Math.abs(curM - medM).toFixed(1) + '개월 ' + (hiM ? '여유' : '부족'); }
      var miniM = chartBox(44); miniM.className = 'kpi-mini';
      var cardM = h('div', { class: 'kpi-card card', onClick: function () { S.tab = 'crisis'; render(); } }, [
        h('div', { class: 'kpi-head' }, [
          iconTile('kpi-icon', bc.ic, bc.c),
          h('div', { class: 'kpi-titles' }, [
            h('div', { class: 'kpi-name', text: '재정 완충력' }),
            h('div', { class: 'kpi-sub', text: '적립금 지속가능월수 · 국민대 · ' + yr + '년' }),
          ]),
        ]),
        h('div', { class: 'kpi-valrow' }, [
          h('div', { class: 'kpi-value', text: months(curM) }),
          h('span', { class: 'delta-pill ' + pillM, html: arrM + ' ' + magM + ' <span class="dp-vs">vs ' + (yr - 1) + '</span>' }),
        ]),
        h('div', { class: 'meter-row' }, [
          h('span', { class: 'meter-lab', text: '코호트 백분위' }),
          tickMeter(pctM, bc.c),
          h('span', { class: 'meter-val', style: 'color:' + bc.c, text: pctM == null ? '—' : F.percentileLabel(pctM) }),
        ]),
        miniM,
        h('div', { class: 'insight ' + insMcls }, [h('span', { text: insM }), h('span', { class: 'in-arrow', text: '→' })]),
      ]);
      grid.appendChild(cardM);
      var ptsM = YEARS.map(function (y) { return [y, exSer('적립금총액', KMU_ID, y)]; });
      C.miniBars(miniM, { points: ptsM, color: bc.c, height: 44, fmt: F.krw });
    }
    v.appendChild(grid);
    v.appendChild(h('div', { class: 'spacer-v' }));

    // 운영수지 시계열 + 밴드
    var row2 = h('div', { class: 'grid c2' });
    var opCard = h('div', { class: 'card' }, [cardHead('timeseries', 'var(--series-2)', '운영수지 추이', '국민대 실선 · 코호트 p25~p75 밴드 · p50 점선(현재 필터 모집단)')]);
    var opBox = chartBox(280); opCard.appendChild(opBox);
    opCard.appendChild(bandLegend('운영수지'));
    row2.appendChild(opCard);

    // 등록금의존율 분포
    var distCard = h('div', { class: 'card' }, [cardHead('compare', 'var(--series-6)', '등록금의존율 분포 — ' + yr + '년', '현재 필터 모집단 히스토그램 · 국민대 위치 표시')]);
    var distBox = chartBox(260); distCard.appendChild(distBox);
    row2.appendChild(distCard);
    v.appendChild(row2);
    v.appendChild(h('div', { class: 'spacer-v' }));

    // 부문 스택바
    var secCard = h('div', { class: 'card' }, [cardHead('structure', 'var(--series-3)', '수입·지출 부문 구성 — 국민대 ' + yr + '년', '운영 · 자산/부채 · 기본금 · 이월')]);
    var secBox = chartBox(150); secCard.appendChild(secBox);
    secCard.appendChild(sectionLegend());
    v.appendChild(secCard);

    // 렌더 차트
    drawOpTrend(opBox);
    var distVals = filteredSchoolIds().map(function (sid) { return kv('등록금의존율_총계', sid, yr); });
    C.histogram(distBox, { values: distVals, marker: { x: kv('등록금의존율_총계', KMU_ID, yr), label: '국민대' }, xFmt: function (x) { return F.pct(x, 0); }, color: 'var(--band)' });
    drawSectionBar(secBox, yr);
  }

  function drawOpTrend(box) {
    var yrs = YEARS.filter(function (y) { return y >= S.y0 && y <= S.y1; });
    var kmu = yrs.map(function (y) { return [y, kv('운영수지', KMU_ID, y)]; });
    var lo = [], hi = [], mid = [];
    yrs.forEach(function (y) {
      var cs = cohortStats('운영수지', y);
      lo.push([y, cs ? cs.p25 : null]); hi.push([y, cs ? cs.p75 : null]); mid.push([y, cs ? cs.p50 : null]);
    });
    C.line(box, {
      height: 280, yZero: true,
      series: [{ name: '국민대', color: 'var(--kmu)', points: kmu, emphasize: true, label: '국민대' }],
      band: { lo: lo, hi: hi, mid: mid, color: 'var(--band)' },
      xTicks: yrs, yFmt: F.krwAxis, tipFmt: F.krw,
    });
  }
  function drawSectionBar(box, yr) {
    var inItems = {
      label: '수입', emphasize: true, segs: [
        { name: '운영수입', value: gv('in', 'OP_IN', KMU_ID, yr), color: 'var(--sec-op)' },
        { name: '자산·부채', value: gv('in', 'AL_IN', KMU_ID, yr), color: 'var(--sec-asset)' },
        { name: '기본금', value: gv('in', 'F_기본금', KMU_ID, yr) || 0, color: 'var(--sec-debt)' },
        { name: '전기이월', value: gv('in', 'CF_PREV', KMU_ID, yr), color: 'var(--sec-carry)' },
      ]
    };
    var exItems = {
      label: '지출', segs: [
        { name: '운영지출', value: gv('ex', 'OP_EX', KMU_ID, yr), color: 'var(--sec-op)' },
        { name: '자산·부채', value: gv('ex', 'AL_EX', KMU_ID, yr), color: 'var(--sec-asset)' },
        { name: '차기이월', value: gv('ex', 'CF_NEXT', KMU_ID, yr), color: 'var(--sec-carry)' },
      ]
    };
    C.bar(box, { items: [inItems, exItems], stacked: true, valFmt: F.krwAxis, labelW: 60, rowH: 46, maxBar: 26 });
  }
  function bandLegend(name) {
    return h('div', { class: 'legend' }, [
      h('span', { class: 'lg kmu', html: '<i></i>국민대' }),
      h('span', { class: 'lg', html: '<i class="band" style="background:var(--band)"></i>코호트 p25~p75' }),
      h('span', { class: 'lg', html: '<i class="dash" style="color:var(--band)"></i>중앙값(p50)' }),
    ]);
  }
  function sectionLegend() {
    return h('div', { class: 'legend' }, [
      h('span', { class: 'lg', html: '<i style="background:var(--sec-op)"></i>운영' }),
      h('span', { class: 'lg', html: '<i style="background:var(--sec-asset)"></i>자산·부채' }),
      h('span', { class: 'lg', html: '<i style="background:var(--sec-debt)"></i>기본금' }),
      h('span', { class: 'lg', html: '<i style="background:var(--sec-carry)"></i>이월' }),
    ]);
  }

  // ═══════════════════════════════════════════════════════
  //  탭 2 — 수지 구조 (수입·지출 병렬 트리 + 분석 패널)
  // ═══════════════════════════════════════════════════════
  // 운영/자산부채 관(館) 구분 (lv1 코드는 p=None 이라 코드셋으로 판정)
  var IN_OP_ROOTS = ['5100', '5200', '5300', '5400'];
  var EX_OP_ROOTS = ['4100', '4200', '4300', '4400', '4500', '4600'];
  function ancestorChain(side, code) {          // [lv1 … code]
    var chain = [], c = code;
    while (c) { var a = ACC[side][c]; if (!a) break; chain.unshift(a); c = a.p; }
    return chain;
  }
  function sectionOf(side, code) {               // 선택 계정이 속한 lv0 부문(운영/자산부채)
    var chain = ancestorChain(side, code);
    if (!chain.length) return null;
    var lv1 = chain[0];
    var opset = side === 'in' ? IN_OP_ROOTS : EX_OP_ROOTS;
    if (opset.indexOf(lv1.code) >= 0)
      return { code: side === 'in' ? 'OP_IN' : 'OP_EX', name: side === 'in' ? '운영수입' : '운영지출' };
    return { code: side === 'in' ? 'AL_IN' : 'AL_EX', name: side === 'in' ? '자산·부채수입' : '자산·부채지출' };
  }
  function totCodeOf(side) { return side === 'in' ? 'T_IN' : 'T_EX'; }
  function totWordOf(side) { return side === 'in' ? '총수입' : '총지출'; }
  function breadcrumbChain(side, code) {
    return ancestorChain(side, code).map(function (a) { return '<b>' + a.name + '</b>'; }).join(' › ');
  }
  function enrollOf(sid, yr) {                    // 해당 연도, 없으면 최근 가용
    var e = schools[sid].enroll; if (!e) return null;
    if (e[String(yr)] != null) return e[String(yr)];
    for (var k = YEARS.length - 1; k >= 0; k--) { if (e[String(YEARS[k])] != null) return e[String(YEARS[k])]; }
    return null;
  }
  // 선택 상태 정규화: 연도 가용성 + 값 없으면 관(lv1) 폴백
  function normalizeStructSel() {
    var sid = S.t2_school;
    var avail = YEARS.filter(function (y) { return gv('in', 'T_IN', sid, y) != null || gv('ex', 'T_EX', sid, y) != null; });
    if (avail.length && avail.indexOf(S.t2_year) < 0) S.t2_year = avail[avail.length - 1];
    var sel = S.t2_sel;
    if (gv(sel.side, sel.code, sid, S.t2_year) == null) {
      var chain = ancestorChain(sel.side, sel.code);
      if (chain.length && gv(sel.side, chain[0].code, sid, S.t2_year) != null)
        S.t2_sel = { side: sel.side, code: chain[0].code };
    }
  }

  function renderStructure(v) {
    normalizeStructSel();
    var sid = S.t2_school, yr = S.t2_year, sel = S.t2_sel;
    v.appendChild(structControls());
    var grid = h('div', { class: 't2-grid' });
    var trees = h('div', { class: 't2-trees' });
    trees.appendChild(treeCard('in', sid, yr));
    trees.appendChild(treeCard('ex', sid, yr));
    grid.appendChild(trees);
    grid.appendChild(renderAnalysisPanel(sel.side, sel.code, sid, yr));
    v.appendChild(grid);
  }

  // ── 대학 검색 셀렉터 (단일 선택, 전체 학교 부분일치) — 수지 구조·계정 분석 공용 ──
  function buildSchoolSearch(curSid, onPick, width) {
    var searchWrap = h('div', { class: 'school-search' });
    var input = h('input', { class: 'txt', type: 'text', placeholder: schools[curSid].n + ' — 대학 검색…', style: 'width:' + (width || 260) + 'px', autocomplete: 'off' });
    var drop = h('div', { class: 'ss-dropdown' }); drop.style.display = 'none';
    searchWrap.appendChild(input); searchWrap.appendChild(drop);
    var hits = [], active = -1;
    function cand(q) { var out = []; schools.forEach(function (s, i) { if (q && s.n.indexOf(q) < 0) return; out.push(i); }); return out.slice(0, 12); }
    function pick(i) { onPick(i); }
    // active 하이라이트만 갱신(옵션 DOM 재생성 없음). mouseenter가 draw()로 옵션을
    // 통째로 재생성하면, 커서 아래 옵션이 detach되어 곧이어 발생할 mousedown(선택)이
    // 유실됨 → 대학을 클릭해도 반영 안 되는 버그. 클래스 토글로만 강조.
    function hi() {
      var kids = drop.querySelectorAll('.ss-opt');
      for (var k = 0; k < kids.length; k++) kids[k].classList.toggle('active', k === active);
    }
    function draw() {
      drop.innerHTML = ''; drop.style.display = 'block';
      if (!hits.length) { drop.appendChild(h('div', { class: 'ss-empty', text: input.value.trim() ? '일치하는 대학이 없습니다' : '대학명을 입력하세요' })); return; }
      hits.forEach(function (i, k) {
        var o = h('div', { class: 'ss-opt' + (k === active ? ' active' : '') + (i === KMU_ID ? ' kmu' : ''),
          html: '<span class="ss-nm">' + schools[i].n + (schools[i].kmu ? ' ★' : '') + '</span><span class="ss-region">' + schools[i].region + ' · ' + schools[i].scale + '</span>' });
        o.addEventListener('mousedown', function (e) { e.preventDefault(); pick(i); });
        o.addEventListener('mouseenter', function () { active = k; hi(); });
        drop.appendChild(o);
      });
    }
    // 방향키 이동: 옵션이 이미 그려져 있으면 하이라이트만, 아니면(숨김 상태 등) 재생성.
    function nav(delta) {
      if (!hits.length) return;
      active = (active + delta + hits.length) % hits.length;
      if (drop.style.display === 'none' || !drop.querySelector('.ss-opt')) draw(); else hi();
    }
    function refr() { hits = cand(input.value.trim()); active = hits.length ? 0 : -1; draw(); }
    input.addEventListener('input', refr); input.addEventListener('focus', refr);
    input.addEventListener('blur', function () { setTimeout(function () { drop.style.display = 'none'; }, 150); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); nav(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); nav(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0 && hits[active] != null) pick(hits[active]); }
      else if (e.key === 'Escape') { drop.style.display = 'none'; }
    });
    return searchWrap;
  }

  // ── 상단 컨트롤: 대학 검색(단일 선택) + 연도 칩 ──
  function structControls() {
    var sid = S.t2_school, yr = S.t2_year;
    var searchWrap = buildSchoolSearch(sid, function (i) { S.t2_school = i; render(); }, 260);

    var chips = h('div', { class: 'chip-row yearchips' });
    YEARS.forEach(function (y) {
      var avail = gv('in', 'T_IN', sid, y) != null || gv('ex', 'T_EX', sid, y) != null;
      var b = h('button', { class: 'chip yearchip' + (y === yr ? ' on' : '') + (avail ? '' : ' disabled'), text: String(y),
        onClick: avail ? function () { S.t2_year = y; render(); } : null });
      if (!avail) b.setAttribute('disabled', 'disabled');
      chips.appendChild(b);
    });

    return h('div', { class: 'row-controls t2-controls' }, [
      ctrl('대학 (검색)', searchWrap),
      ctrl('연도', chips),
      LITE ? h('span', { class: 'pill warn', html: '<i></i>LITE: 목(目) 미표시' }) : null,
    ]);
  }

  // ── 계층 트리 카드 (수입/지출 각 1개) ──
  function treeCard(side, sid, yr) {
    var totCode = totCodeOf(side);
    var total = gv(side, totCode, sid, yr);
    var prevTot = gv(side, totCode, sid, yr - 1);
    var yoy = (total != null && prevTot != null && prevTot !== 0) ? (total - prevTot) / prevTot : null;
    var totDelta = (total != null && prevTot != null) ? total - prevTot : null;
    var sideWord = side === 'in' ? '수입' : '지출';
    var sideColor = side === 'in' ? 'var(--series-1)' : 'var(--series-3)';
    var totName = side === 'in' ? '자금수입총계' : '자금지출총계';

    var deltaPill = h('span', { class: 'delta-pill neu', html: yoy == null ? '—' :
      ((yoy >= 0 ? '▲' : '▼') + ' ' + F.pct(Math.abs(yoy), 1) +
       ' <span class="dp-vs">' + (totDelta == null ? '' : F.eokDelta(totDelta) + ' · ') + 'vs ' + (yr - 1) + '</span>') });

    var head = h('div', { class: 't2-treehead' }, [
      iconTile('th-ico', side === 'in' ? 'cap' : 'scale', sideColor),
      h('div', { class: 'th-body' }, [
        h('div', { class: 'th-title', text: sideWord + ' 계층' }),
        h('div', { class: 'th-totlabel', text: '총 ' + sideWord + ' · ' + totName }),
        h('div', { class: 'th-totrow' }, [
          h('span', { class: 'th-total', style: 'color:' + sideColor, text: F.eok(total) }),
          deltaPill,
        ]),
        h('div', { class: 'th-sub', text: schools[sid].n + ' · ' + yr + '년 · 관→항' + (LITE ? '' : '→목') + ' (행 클릭 선택)' }),
      ]),
    ]);

    var card = h('div', { class: 'card t2-treecard' }, [head]);
    var tree = h('div', { class: 'tree' });
    tree.appendChild(treeHeader());
    rootsOf(side).forEach(function (root) { appendTreeNode(tree, side, root, sid, yr, total || 1, 0, sideColor); });
    card.appendChild(tree);
    return card;
  }
  function ctrl(label, node) { return h('div', { class: 'ctrl' }, [h('label', { text: label }), node]); }
  function treeHeader() {
    return h('div', { class: 'tnode', style: 'font-size:11px;color:var(--muted);text-transform:uppercase;cursor:default' }, [
      h('div', { class: 'tname', text: '계정' }),
      h('div', { text: '비중', style: 'text-align:center' }),
      h('div', { text: '금액', style: 'text-align:right' }),
      h('div', { text: '구성비', style: 'text-align:right' }),
      h('div', { text: '전년비', style: 'text-align:right' })
    ]);
  }
  function appendTreeNode(container, side, acc, sid, yr, total, depth, sideColor) {
    if (LITE && acc.lv === 3) return;
    var val = gv(side, acc.code, sid, yr) || 0;
    var prev = gv(side, acc.code, sid, yr - 1);
    var yoy = (prev != null && prev !== 0) ? (val - prev) / prev : null;
    var kids = childrenOf(side, acc.code).filter(function (a) { return !(LITE && a.lv === 3); });
    var hasKids = kids.length > 0;
    var okey = side + ':' + acc.code;
    var open = S.t2_open.has(okey);
    var share = total ? val / total : 0;
    var isSel = S.t2_sel.side === side && S.t2_sel.code === acc.code;
    var node = h('div', {
      class: 'tnode' + (depth === 0 ? ' lv1' : '') + ' clickable' + (isSel ? ' selected' : ''),
      onClick: function () {
        S.t2_sel = { side: side, code: acc.code };
        if (hasKids) { if (open) S.t2_open.delete(okey); else S.t2_open.add(okey); }
        render();
      }
    }, [
      h('div', { class: 'tname' + (depth ? ' indent-' + depth : '') }, [
        h('span', { class: 'caret', text: hasKids ? (open ? '▾' : '▸') : '' }),
        codeBadge(acc.code, sideColor, depth),
        h('span', { class: 'nm', text: acc.name, title: acc.name }),
      ]),
      h('div', { class: 'tbar-wrap' }, [h('div', { class: 'tbar', style: 'width:' + (Math.max(1, share * 100)).toFixed(1) + '%;background:' + sideColor + ';opacity:' + (depth === 0 ? '1' : depth === 1 ? '0.72' : '0.5') })]),
      h('div', { class: 'tval', text: F.eok(val) }),
      h('div', { class: 'tshare', text: F.pct(share, 1) }),
      h('div', { class: 'tyoy ' + (yoy == null ? '' : (yoy >= 0 ? 'up' : 'down')), text: yoy == null ? '—' : (yoy >= 0 ? '+' : '') + F.pct(yoy, 1) }),
    ]);
    container.appendChild(node);
    if (hasKids && open) kids.forEach(function (k) { appendTreeNode(container, side, k, sid, yr, total, depth + 1, sideColor); });
  }
  function treeColor(ri) { return 'var(--series-' + ((ri % 8) + 1) + ')'; }

  // ═══════════════════════════════════════════════════════
  //  분석 패널 (선택 계정 기준, sticky) — A~G
  // ═══════════════════════════════════════════════════════
  function renderAnalysisPanel(side, code, sid, yr) {
    var panel = h('aside', { class: 't2-panel', id: 't2-panel' });
    var acc = ACC[side][code];
    if (!acc) { panel.appendChild(h('div', { class: 'card' }, [h('p', { class: 'hint', text: '트리에서 계정을 선택하세요.' })])); return panel; }
    var val = gv(side, code, sid, yr), tot = gv(side, totCodeOf(side), sid, yr);
    var share = (val != null && tot) ? val / tot : null;
    panel.appendChild(headlineCard(side, code, sid, yr, val, tot, share));   // A
    panel.appendChild(ladderCard(side, code, sid, yr, val));                 // B
    panel.appendChild(trendCard(side, code, sid));                          // C
    panel.appendChild(benchCard(side, code, sid, yr, share));               // D
    var per = perStudentCard(side, code, sid, yr, val);                     // E
    if (per) panel.appendChild(per);
    panel.appendChild(diagCard(side, code, sid, yr, val));                   // F
    panel.appendChild(simCard(side, code, sid, yr, share));                 // G
    return panel;
  }

  // A — 헤드라인 (브레드크럼 · BAN · Δ전년 증감률 · 9개년 스파크라인)
  function headlineCard(side, code, sid, yr, val, tot, share) {
    var prev = gv(side, code, sid, yr - 1);
    var rate = (val != null && prev != null && prev !== 0) ? (val - prev) / prev : null;
    var spark = chartBox(46); spark.className = 'panel-spark';
    var sideWord = side === 'in' ? '수입' : '지출';
    var card = h('div', { class: 'card apanel-head' }, [
      h('div', { class: 'ap-crumb', html: sideWord + ' › ' + breadcrumbChain(side, code) }),
      h('div', { class: 'ap-banrow' }, [
        h('div', { class: 'ap-ban', text: val == null ? '—' : F.eok(val) }),
        h('span', { class: 'delta-pill neu', html: rate == null ? '—' :
          ((rate >= 0 ? '▲' : '▼') + ' ' + F.pct(Math.abs(rate), 1) + ' <span class="dp-vs">vs ' + (yr - 1) + '</span>') }),
      ]),
      h('div', { class: 'ap-sub', text: (share == null ? schools[sid].n : totWordOf(side) + ' 대비 ' + F.pct(share, 1) + ' · ' + schools[sid].n + ' · ' + yr + '년') }),
      spark,
    ]);
    C.sparkline(spark, { points: YEARS.map(function (y) { return [y, gv(side, code, sid, y)]; }),
      color: side === 'in' ? 'var(--series-1)' : 'var(--series-3)', height: 46 });
    return card;
  }

  // B — 포지션 래더 (상위 계층 구성비 계단, 클릭 시 이동)
  function ladderRungs(side, code) {
    var X = ACC[side][code], chain = ancestorChain(side, code), rungs = [];
    if (X.lv >= 3) rungs.push({ label: chain[chain.length - 2].name + ' 대비', code: chain[chain.length - 2].code });
    if (X.lv >= 2) rungs.push({ label: chain[0].name + '(관) 대비', code: chain[0].code });
    if (X.lv >= 1) { var sec = sectionOf(side, code); if (sec) rungs.push({ label: sec.name + ' 대비', code: sec.code }); }
    rungs.push({ label: (side === 'in' ? '자금수입총계' : '자금지출총계') + ' 대비', code: totCodeOf(side) });
    return rungs;
  }
  function ladderCard(side, code, sid, yr, val) {
    var body = h('div', { class: 'ladder' });
    ladderRungs(side, code).forEach(function (r) {
      var dv = gv(side, r.code, sid, yr);
      var sh = (val != null && dv && dv !== 0) ? val / dv : null;
      body.appendChild(h('div', { class: 'lad-row clickable', onClick: function () { S.t2_sel = { side: side, code: r.code }; render(); } }, [
        h('div', { class: 'lad-lab', text: r.label }),
        h('div', { class: 'lad-track' }, [h('div', { class: 'lad-fill', style: 'width:' + (sh == null ? 0 : Math.max(2, sh * 100)).toFixed(1) + '%' })]),
        h('div', { class: 'lad-val', text: sh == null ? '—' : F.pct(sh, 1) }),
      ]));
    });
    return h('div', { class: 'card' }, [
      cardHead('structure', 'var(--series-4)', '포지션 래더', '상위 계층 대비 구성비 · 단계 클릭 시 이동'),
      body,
    ]);
  }

  // C — 추이 (절대액 | 구성비 토글)
  function trendCard(side, code, sid) {
    var mode = S.t2_cmode;
    var toggle = h('div', { class: 'chip-row' }, [
      h('button', { class: 'chip' + (mode === 'abs' ? ' on' : ''), text: '절대액', onClick: function () { S.t2_cmode = 'abs'; render(); } }),
      h('button', { class: 'chip' + (mode === 'share' ? ' on' : ''), text: '구성비', onClick: function () { S.t2_cmode = 'share'; render(); } }),
    ]);
    var card = h('div', { class: 'card' }, [
      cardHead('timeseries', 'var(--series-2)', '9개년 추이 — ' + ACC[side][code].name,
        mode === 'share' ? (schools[sid].n + ' 실선 · 모집단 p25~p75 밴드 · p50 점선') : (schools[sid].n + ' 실선 · 모집단 중앙값 점선')),
      toggle,
    ]);
    var box = chartBox(220); card.appendChild(box);
    if (mode === 'share') {
      var ins = shareTrendInsight(side, code, sid);
      if (ins) card.appendChild(h('div', { class: 'insight neutral', style: 'margin-top:12px' }, [h('span', { text: ins }), h('span', { class: 'in-arrow', text: '→' })]));
    }
    drawStructTrend(box, side, code, sid, mode);
    return card;
  }
  function drawStructTrend(box, side, code, sid, mode) {
    var yrs = YEARS.slice(), pop = filteredSchoolIds(), totCode = totCodeOf(side);
    var selfColor = sid === KMU_ID ? 'var(--kmu)' : 'var(--series-1)';
    if (mode === 'abs') {
      var self = yrs.map(function (y) { return [y, gv(side, code, sid, y)]; });
      var mid = yrs.map(function (y) { var st = stats(pop.map(function (p) { return gv(side, code, p, y); })); return [y, st ? st.p50 : null]; });
      C.line(box, { height: 220, yZero: true,
        series: [{ name: schools[sid].n, color: selfColor, points: self, emphasize: true },
                 { name: '모집단 중앙값', color: 'var(--muted)', points: mid, dashed: true, dim: true }],
        xTicks: [2016, 2018, 2020, 2022, 2024], yFmt: F.krwAxis, tipFmt: F.eok });
    } else {
      var shr = function (p, y) { var vv = gv(side, code, p, y), tt = gv(side, totCode, p, y); return (vv != null && tt) ? vv / tt : null; };
      var selfS = yrs.map(function (y) { return [y, shr(sid, y)]; });
      var lo = [], hi = [], m2 = [];
      yrs.forEach(function (y) { var st = stats(pop.map(function (p) { return shr(p, y); })); lo.push([y, st ? st.p25 : null]); hi.push([y, st ? st.p75 : null]); m2.push([y, st ? st.p50 : null]); });
      C.line(box, { height: 220, yZero: true,
        series: [{ name: schools[sid].n, color: selfColor, points: selfS, emphasize: true }],
        band: { lo: lo, hi: hi, mid: m2, color: 'var(--band)' },
        xTicks: [2016, 2018, 2020, 2022, 2024], yFmt: function (x) { return F.pct(x, 0); }, tipFmt: function (x) { return F.pct(x); } });
    }
  }
  function shareTrendInsight(side, code, sid) {
    var totCode = totCodeOf(side);
    function shr(y) { var vv = gv(side, code, sid, y), tt = gv(side, totCode, sid, y); return (vv != null && tt) ? vv / tt : null; }
    var first = null, last = null, fy, ly;
    for (var i = 0; i < YEARS.length; i++) { var s = shr(YEARS[i]); if (s != null) { if (first == null) { first = s; fy = YEARS[i]; } last = s; ly = YEARS[i]; } }
    if (first == null || last == null || fy === ly) return null;
    var dp = (last - first) * 100;
    return totWordOf(side) + ' 대비 비중이 ' + fy + '→' + ly + ' ' + (dp >= 0 ? '+' : '') + dp.toFixed(1) + '%p ' + (dp >= 0 ? '확대' : '축소');
  }

  // ── 공유 벤치마크: 총계 대비 구성비 백분위(모집단·같은 규모·같은 권역) ──
  // renderAnalysisPanel(수지 구조 패널)과 계정 분석 매트릭스가 동일 값을 쓰도록 단일 구현.
  // 반환: [{name,short,ids,n,mean,pctile,diff,selfShare}] · pctile 0~1(높을수록 구성비 상위)
  function benchmarkGroups(side, code, sid, yr) {
    var totCode = totCodeOf(side);
    function shareOf(id) { var vv = gv(side, code, id, yr), tt = gv(side, totCode, id, yr); return (vv != null && tt) ? vv / tt : null; }
    var selfShare = shareOf(sid);
    var allIds = schools.map(function (s, i) { return i; });
    var defs = [
      { name: '현재 필터 모집단', short: '모집단', ids: filteredSchoolIds() },
      { name: '같은 규모 · ' + schools[sid].scale, short: '같은 규모', ids: allIds.filter(function (i) { return schools[i].scale === schools[sid].scale; }) },
      { name: '같은 권역 · ' + schools[sid].region, short: '같은 권역', ids: allIds.filter(function (i) { return schools[i].region === schools[sid].region; }) },
    ];
    return defs.map(function (g) {
      var vals = g.ids.map(shareOf).filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; });
      var n = vals.length;
      var mean = n ? vals.reduce(function (a, b) { return a + b; }, 0) / n : null;
      var pctile = (n > 1 && selfShare != null) ? vals.filter(function (x) { return x < selfShare; }).length / (n - 1) : null;
      var diff = (mean != null && selfShare != null) ? (selfShare - mean) * 100 : null;
      return { name: g.name, short: g.short, n: n, mean: mean, pctile: pctile, diff: diff, selfShare: selfShare };
    });
  }

  // ── 공유 변동성(9개년 YoY 변동계수) — 성격 진단·계정 분석 공용 ──
  function yoyCV(side, code, sid) {
    var rates = [];
    for (var i = 1; i < YEARS.length; i++) {
      var a = gv(side, code, sid, YEARS[i - 1]), b = gv(side, code, sid, YEARS[i]);
      if (a != null && b != null && a !== 0) rates.push((b - a) / a);
    }
    if (rates.length < 3) return null;
    var mean = rates.reduce(function (x, y) { return x + y; }, 0) / rates.length;
    var variance = rates.reduce(function (x, y) { return x + (y - mean) * (y - mean); }, 0) / rates.length;
    var sd = Math.sqrt(variance);
    return Math.abs(mean) > 1e-6 ? sd / Math.abs(mean) : (sd > 0.05 ? 1 : 0);
  }
  function cvBand(cv) { return cv == null ? null : (cv < 0.15 ? 'rigid' : (cv > 0.4 ? 'volatile' : 'mid')); }
  var CV_LABEL = { rigid: '경직성', mid: '보통', volatile: '변동성' };

  // D — 3중 벤치마크 (모집단 · 같은 규모 · 같은 권역)
  function benchCard(side, code, sid, yr, selfShare) {
    var body = h('div', { class: 'bench' });
    benchmarkGroups(side, code, sid, yr).forEach(function (g) {
      var n = g.n, mean = g.mean, pctile = g.pctile, diff = g.diff;
      var diffClr = (side === 'ex' && diff != null && diff > 0) ? 'var(--serious)' : 'var(--text-secondary)';
      body.appendChild(h('div', { class: 'bench-row' }, [
        h('div', { class: 'bench-head' }, [h('span', { class: 'bench-name', text: g.name }), h('span', { class: 'bench-n', text: 'n=' + n })]),
        h('div', { class: 'bench-meter' }, [barMeter(pctile, 'var(--kmu)'),
          h('span', { class: 'meter-val', style: 'color:var(--kmu)', text: pctile == null ? '—' : F.percentileLabel(pctile) })]),
        h('div', { class: 'bench-diff', style: 'color:' + diffClr, text: diff == null ? '집단 평균 대비 —' : ('집단 평균 대비 ' + (diff >= 0 ? '+' : '') + diff.toFixed(1) + '%p') }),
      ]));
    });
    return h('div', { class: 'card' }, [
      cardHead('compare', 'var(--series-6)', '3중 벤치마크', totWordOf(side) + ' 대비 구성비 백분위 · 중립 표기'),
      body,
    ]);
  }

  // E — 학생 1인당 (재학생수, 같은 규모 백분위) · enroll 결측 시 숨김
  function perStudentCard(side, code, sid, yr, val) {
    var enr = enrollOf(sid, yr);
    if (enr == null || enr <= 0 || val == null) return null;
    var per = val / enr; // 천원/명
    var ids = schools.map(function (s, i) { return i; }).filter(function (i) { return schools[i].scale === schools[sid].scale; });
    var vals = ids.map(function (id) { var v2 = gv(side, code, id, yr), e2 = enrollOf(id, yr); return (v2 != null && e2) ? v2 / e2 : null; })
      .filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; });
    var n = vals.length;
    var pctile = (n > 1) ? vals.filter(function (x) { return x < per; }).length / (n - 1) : null;
    return h('div', { class: 'card' }, [
      cardHead('users', 'var(--series-5)', '학생 1인당', schools[sid].scale + ' 집단 · 재학생 ' + F.intComma(enr) + '명'),
      h('div', { class: 'per-ban' }, [h('span', { class: 'per-val', text: F.krw(per) }), h('span', { class: 'per-unit', text: '/ 학생 1인' })]),
      h('div', { class: 'meter-row' }, [h('span', { class: 'meter-lab', text: '같은 규모 백분위' }), barMeter(pctile, 'var(--series-5)'),
        h('span', { class: 'meter-val', style: 'color:var(--series-5)', text: pctile == null ? '—' : F.percentileLabel(pctile) })]),
    ]);
  }

  // F — 성격 진단 (성장 기여도 · 변동성)
  function diagCard(side, code, sid, yr, val) {
    var body = h('div', { class: 'diag' });
    var totCode = totCodeOf(side);
    var prev = gv(side, code, sid, yr - 1);
    var tot = gv(side, totCode, sid, yr), totp = gv(side, totCode, sid, yr - 1);
    if (val != null && prev != null && tot != null && totp != null) {
      var dTot = tot - totp;
      if (Math.abs(dTot) >= 1) {
        var contrib = (val - prev) / dTot * 100;
        body.appendChild(h('div', { class: 'diag-item' }, [
          h('div', { class: 'diag-lab', text: '성장 기여도 (' + (yr - 1) + '→' + yr + ')' }),
          h('div', { class: 'diag-txt', html: '최근 1년 ' + totWordOf(side) + ' 증가분의 <b>' + contrib.toFixed(0) + '%</b>를 이 계정이 차지' }),
        ]));
      }
    }
    var cv = yoyCV(side, code, sid);
    if (cv != null) {
      var band = cvBand(cv), lbl = CV_LABEL[band];
      body.appendChild(h('div', { class: 'diag-item' }, [
        h('div', { class: 'diag-lab', text: '변동성 (9개년 YoY 변동계수)' }),
        h('div', {}, [h('span', { class: 'diag-badge ' + band, text: lbl + ' · CV ' + cv.toFixed(2) })]),
      ]));
    }
    body.appendChild(h('div', { class: 'footnote', html: '<b>경직성</b> = 매년 일정하게 발생(CV&lt;0.15) · <b>변동성</b> CV&gt;0.4' }));
    return h('div', { class: 'card' }, [cardHead('data', 'var(--series-8)', '성격 진단', '성장 기여도 · 변동성'), body]);
  }

  // G — 유사 대학 스니펫 (같은 규모+권역, 부족 시 규모만)
  function simCard(side, code, sid, yr, selfShare) {
    var totCode = totCodeOf(side);
    function shr(id) { var vv = gv(side, code, id, yr), tt = gv(side, totCode, id, yr); return (vv != null && tt) ? vv / tt : null; }
    var region = schools[sid].region, scale = schools[sid].scale;
    var allIds = schools.map(function (s, i) { return i; });
    var ids = allIds.filter(function (i) { return i !== sid && schools[i].scale === scale && schools[i].region === region && shr(i) != null; });
    var groupLabel = '같은 규모+권역';
    if (ids.length < 8) { ids = allIds.filter(function (i) { return i !== sid && schools[i].scale === scale && shr(i) != null; }); groupLabel = '같은 규모'; }
    var arr = ids.map(function (i) { return { sid: i, share: shr(i) }; }).sort(function (a, b) { return b.share - a.share; });
    var rank = (selfShare == null) ? arr.length : arr.filter(function (r) { return r.share > selfShare; }).length;
    var body = h('table', { class: 'sim-table' });
    var tb = h('tbody');
    function row(r, posLabel, self) {
      var isKmu = r.sid === KMU_ID;
      return h('tr', { class: (self ? 'sim-self ' : '') + (isKmu ? 'kmu-row' : '') }, [
        h('td', { class: 'sim-pos', text: posLabel }),
        h('td', { class: 'sim-nm' }, [h('span', { text: schools[r.sid].n }), isKmu ? h('span', { class: 'kmu-star', text: ' ★' }) : null]),
        h('td', { class: 'sim-share', text: r.share == null ? '—' : F.pct(r.share, 1) }),
      ]);
    }
    arr.slice(0, 3).forEach(function (r, i) { tb.appendChild(row(r, (i + 1) + '위')); });
    tb.appendChild(row({ sid: sid, share: selfShare }, (rank + 1) + '위 / ' + (arr.length + 1), true));
    arr.slice(Math.max(3, arr.length - 3)).forEach(function (r) { tb.appendChild(row(r, (arr.indexOf(r) + 1) + '위')); });
    body.appendChild(tb);
    return h('div', { class: 'card' }, [
      cardHead('overview', 'var(--series-3)', '유사 대학 스니펫', groupLabel + ' · 구성비 상·하위 (n=' + arr.length + ')'),
      h('div', { class: 'tbl-wrap' }, [body]),
    ]);
  }

  // ═══════════════════════════════════════════════════════
  //  탭 — 계정 분석 (전 계정 자동 인사이트 + 벤치마크 매트릭스)
  // ═══════════════════════════════════════════════════════
  function accSideColor(side) { return side === 'in' ? 'var(--series-1)' : 'var(--series-3)'; }
  function accSideWord(side) { return side === 'in' ? '수입' : '지출'; }
  function accDepthLv() { return S.t8_depth === 'gwan' ? 1 : (S.t8_depth === 'gwanhang' ? 2 : 3); }

  function normalizeAccSel() {
    var sid = S.t8_school;
    var avail = YEARS.filter(function (y) { return gv('in', 'T_IN', sid, y) != null || gv('ex', 'T_EX', sid, y) != null; });
    if (avail.length && avail.indexOf(S.t8_year) < 0) S.t8_year = avail[avail.length - 1];
    if (LITE && S.t8_depth === 'mok') S.t8_depth = 'gwanhang';
  }

  // 선택 측·연도의 전 계정(lv≥1) 지표 묶음 — 인사이트/매트릭스 공용
  function accountMetrics(side, sid, yr) {
    var tot = gv(side, totCodeOf(side), sid, yr);
    var out = [];
    DATA.accounts[side].forEach(function (a) {
      if (a.lv < 1) return;                 // 합성 총계/부문(lv0) 제외
      if (LITE && a.lv === 3) return;
      var val = gv(side, a.code, sid, yr), prev = gv(side, a.code, sid, yr - 1);
      out.push({
        code: a.code, name: a.name, lv: a.lv, val: val, prev: prev,
        share: (val != null && tot) ? val / tot : null,
        delta: (val != null && prev != null) ? val - prev : null,
        yoy: (val != null && prev != null && prev !== 0) ? (val - prev) / prev : null,
      });
    });
    return out;
  }

  function renderAccounts(v) {
    normalizeAccSel();
    var side = S.t8_side, sid = S.t8_school, yr = S.t8_year, sideColor = accSideColor(side);
    v.appendChild(accControls());
    if (gv(side, totCodeOf(side), sid, yr) == null) {
      v.appendChild(h('div', { class: 'card' }, [h('p', { class: 'hint',
        text: schools[sid].n + ' · ' + yr + '년 ' + accSideWord(side) + ' 데이터가 없습니다. 다른 연도/측을 선택하세요.' })]));
      return;
    }
    var metrics = accountMetrics(side, sid, yr);
    v.appendChild(accInsights(side, sid, yr, metrics, sideColor));
    v.appendChild(h('div', { class: 'spacer-v' }));
    v.appendChild(accMatrix(side, sid, yr, sideColor));

    if (S.t8_hl) {
      var hlCode = S.t8_hl;
      setTimeout(function () {
        var el = document.getElementById('acc-r-' + side + '-' + hlCode);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 60);
    }
  }

  // ── 컨트롤 바 ──
  function accControls() {
    var sid = S.t8_school, yr = S.t8_year;
    var searchWrap = buildSchoolSearch(sid, function (i) { S.t8_school = i; S.t8_hl = null; render(); }, 240);

    var yChips = h('div', { class: 'chip-row yearchips' });
    YEARS.forEach(function (y) {
      var avail = gv('in', 'T_IN', sid, y) != null || gv('ex', 'T_EX', sid, y) != null;
      var b = h('button', { class: 'chip yearchip' + (y === yr ? ' on' : '') + (avail ? '' : ' disabled'), text: String(y),
        onClick: avail ? function () { S.t8_year = y; S.t8_hl = null; render(); } : null });
      if (!avail) b.setAttribute('disabled', 'disabled');
      yChips.appendChild(b);
    });

    var sideChips = h('div', { class: 'chip-row' }, [
      h('button', { class: 'chip' + (S.t8_side === 'ex' ? ' on' : ''), text: '지출', onClick: function () { S.t8_side = 'ex'; S.t8_hl = null; render(); } }),
      h('button', { class: 'chip' + (S.t8_side === 'in' ? ' on' : ''), text: '수입', onClick: function () { S.t8_side = 'in'; S.t8_hl = null; render(); } }),
    ]);

    var depths = [{ v: 'gwan', l: '관' }, { v: 'gwanhang', l: '관+항' }];
    if (!LITE) depths.push({ v: 'mok', l: '전체(목)' });
    var depthChips = h('div', { class: 'chip-row' }, depths.map(function (d) {
      return h('button', { class: 'chip' + (S.t8_depth === d.v ? ' on' : ''), text: d.l, onClick: function () { S.t8_depth = d.v; S.t8_hl = null; render(); } });
    }));

    var zeroChip = h('div', { class: 'chip-row' }, [
      h('button', { class: 'chip' + (S.t8_zero ? ' on' : ''), text: (S.t8_zero ? '✓ ' : '') + '0원 계정 표시', onClick: function () { S.t8_zero = !S.t8_zero; render(); } }),
    ]);

    return h('div', { class: 'row-controls t2-controls' }, [
      ctrl('대학 (검색)', searchWrap),
      ctrl('연도', yChips),
      ctrl('측', sideChips),
      ctrl('계층 깊이', depthChips),
      ctrl('0원 계정', zeroChip),
      LITE ? h('span', { class: 'pill warn', html: '<i></i>LITE: 목(目) 미표시' }) : null,
    ]);
  }

  // 인사이트/매트릭스 → 특정 계정 하이라이트 (필요 시 깊이 자동 확장)
  function accInsightPick(code, lv) {
    S.t8_hl = code;
    if (lv === 3 && !LITE && S.t8_depth !== 'mok') S.t8_depth = 'mok';
    else if (lv === 2 && S.t8_depth === 'gwan') S.t8_depth = 'gwanhang';
    render();
  }
  // 매트릭스 행 클릭 → 수지 구조 탭으로 이동 + 해당 계정 선택
  function accGotoStructure(side, code) {
    S.t2_school = S.t8_school; S.t2_year = S.t8_year; S.t2_sel = { side: side, code: code };
    ancestorChain(side, code).forEach(function (a) { if (childrenOf(side, a.code).length) S.t2_open.add(side + ':' + a.code); });
    S.t8_hl = null; S.tab = 'structure'; window.scrollTo(0, 0); render();
  }

  // ── 섹션 1: 자동 인사이트 (3 카드) ──
  function accInsights(side, sid, yr, metrics, sideColor) {
    var sig = metrics.filter(function (m) { return m.share != null && m.share >= 0.01 && m.val != null; });

    // 1) 동류(같은 규모) 대비 편차 극단 Top 5
    var dev = sig.map(function (m) { var g = benchmarkGroups(side, m.code, sid, yr)[1]; return { m: m, pctile: g.pctile, diff: g.diff }; })
      .filter(function (x) { return x.pctile != null && (x.pctile <= 0.15 || x.pctile >= 0.85); })
      .sort(function (a, b) { return Math.abs(b.pctile - 0.5) - Math.abs(a.pctile - 0.5); }).slice(0, 5);
    // 2) 급증·급감 Top 5 (절대 증감액)
    var jump = sig.filter(function (m) { return m.delta != null; })
      .slice().sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); }).slice(0, 5);
    // 3) 변동성 상위 Top 5 (+ 경직성 계정 수)
    var cvList = sig.map(function (m) { return { m: m, cv: yoyCV(side, m.code, sid) }; }).filter(function (x) { return x.cv != null; });
    var vol = cvList.slice().sort(function (a, b) { return b.cv - a.cv; }).slice(0, 5);
    var rigidCount = cvList.filter(function (x) { return x.cv < 0.15; }).length;

    function item(m, right) {
      return h('button', { class: 'ins-item', type: 'button', onClick: function () { accInsightPick(m.code, m.lv); } }, [
        codeBadge(m.code, sideColor, m.lv - 1),
        h('span', { class: 'ins-nm', text: m.name, title: m.name }),
        right,
      ]);
    }
    function emptyRow(txt) { return h('div', { class: 'ins-empty', text: txt }); }

    // 카드 1
    var c1 = h('div', { class: 'card' }, [cardHead('compare', 'var(--series-6)', '동류 대비 편차 Top 5',
      '같은 규모 집단 구성비 백분위가 극단(상위/하위 15% 이내) · 구성비 1%↑')]);
    var l1 = h('div', { class: 'ins-list' });
    if (!dev.length) l1.appendChild(emptyRow('극단 편차 계정이 없습니다.'));
    dev.forEach(function (x) {
      l1.appendChild(item(x.m, h('span', { class: 'ins-right' }, [
        h('span', { class: 'ins-pct', text: F.percentileLabel(x.pctile) }),
        h('span', { class: 'ins-sub', text: (x.diff >= 0 ? '+' : '') + x.diff.toFixed(1) + '%p' }),
      ])));
    });
    c1.appendChild(l1);

    // 카드 2
    var c2 = h('div', { class: 'card' }, [cardHead('timeseries', 'var(--series-2)', '급증·급감 Top 5',
      '전년(' + (yr - 1) + '→' + yr + ') 절대 증감액 · 구성비 1%↑')]);
    var l2 = h('div', { class: 'ins-list' });
    if (!jump.length) l2.appendChild(emptyRow('증감 데이터가 없습니다.'));
    jump.forEach(function (m) {
      l2.appendChild(item(m, h('span', { class: 'delta-pill neu', html: (m.delta >= 0 ? '▲ ' : '▼ ') + F.eok(Math.abs(m.delta)) })));
    });
    c2.appendChild(l2);

    // 카드 3
    var c3 = h('div', { class: 'card' }, [cardHead('data', 'var(--series-8)', '변동성 주의',
      '9개년 YoY 변동계수(CV) 상위 · 구성비 1%↑')]);
    var l3 = h('div', { class: 'ins-list' });
    if (!vol.length) l3.appendChild(emptyRow('변동성 계정이 없습니다.'));
    vol.forEach(function (x) {
      var band = cvBand(x.cv);
      l3.appendChild(item(x.m, h('span', { class: 'cv-badge ' + band, text: 'CV ' + x.cv.toFixed(2) })));
    });
    c3.appendChild(l3);
    c3.appendChild(h('div', { class: 'footnote', html: '경직성(CV&lt;0.15) 계정 <b>' + rigidCount + '개</b> — 매년 일정하게 발생하는 고정성 항목' }));

    return h('div', { class: 'grid c3 acc-insights' }, [c1, c2, c3]);
  }

  // ── 섹션 2: 전 계정 분석 매트릭스 ──
  function accMatrix(side, sid, yr, sideColor) {
    var maxLv = accDepthLv();
    var tot = gv(side, totCodeOf(side), sid, yr);
    var enr = enrollOf(sid, yr);
    var color = accSideColor(side);
    var ordered = [];
    function walk(acc, depth) {
      ordered.push({ acc: acc, depth: depth });
      if (acc.lv < maxLv) childrenOf(side, acc.code).forEach(function (k) { if (LITE && k.lv === 3) return; if (k.lv <= maxLv) walk(k, depth + 1); });
    }
    rootsOf(side).forEach(function (r) { walk(r, 0); });

    var tbl = h('table', { class: 'data acc-matrix' });
    tbl.appendChild(h('thead', {}, [h('tr', {}, [
      h('th', { text: '계정' }), h('th', { text: '금액(억원)' }), h('th', { text: '구성비' }), h('th', { text: '전년비' }),
      h('th', { class: 'spk', text: '9개년' }), h('th', { text: '모집단' }), h('th', { text: '같은 규모' }), h('th', { text: '같은 권역' }),
      h('th', { text: '학생 1인당' }), h('th', { text: '성격' }),
    ])]));
    var tbody = h('tbody');
    var sparkTasks = [], shown = 0, hiddenZero = 0;

    function benchCell(g) {
      return h('td', {}, [h('div', { class: 'acc-bench' }, [
        h('div', { class: 'mini-rr' }, [h('div', { class: 'mini-rr-fill', style: g.pctile == null ? 'width:0' : ('width:' + Math.max(3, g.pctile * 100).toFixed(0) + '%;background:' + color) })]),
        h('span', { class: 'meter-val', text: g.pctile == null ? '—' : ('상위' + Math.round((1 - g.pctile) * 100) + '%') }),
      ])]);
    }

    ordered.forEach(function (o) {
      var acc = o.acc, depth = o.depth, val = gv(side, acc.code, sid, yr);
      if ((val == null || val === 0) && !S.t8_zero) { hiddenZero++; return; }
      shown++;
      var prev = gv(side, acc.code, sid, yr - 1);
      var yoy = (val != null && prev != null && prev !== 0) ? (val - prev) / prev : null;
      var share = (val != null && tot) ? val / tot : null;
      var bg = benchmarkGroups(side, acc.code, sid, yr);
      var cv = yoyCV(side, acc.code, sid), band = cvBand(cv);
      var per = (val != null && enr) ? val / enr : null;

      var sparkDiv = h('div', { class: 'acc-spark' });
      var row = h('tr', {
        id: 'acc-r-' + side + '-' + acc.code, class: 'acc-row lv' + acc.lv + (S.t8_hl === acc.code ? ' acc-hl' : ''),
        onClick: function () { accGotoStructure(side, acc.code); },
      }, [
        h('td', { class: 'acc-name' }, [h('span', { class: 'acc-name-in', style: 'padding-left:' + (depth * 16) + 'px' }, [
          codeBadge(acc.code, sideColor, depth), h('span', { class: 'acc-nm', text: acc.name, title: acc.name })])]),
        h('td', { text: val == null ? '—' : F.eok(val, { noUnit: true }) }),
        h('td', { class: 'tshare', text: share == null ? '—' : F.pct(share, 1) }),
        h('td', { class: 'tyoy ' + (yoy == null ? '' : (yoy >= 0 ? 'up' : 'down')), text: yoy == null ? '—' : ((yoy >= 0 ? '+' : '') + F.pct(yoy, 1)) }),
        h('td', { class: 'spk' }, [sparkDiv]),
        benchCell(bg[0]), benchCell(bg[1]), benchCell(bg[2]),
        h('td', { text: per == null ? '—' : F.krw(per) }),
        h('td', {}, [band ? h('span', { class: 'cv-badge ' + band, text: CV_LABEL[band] }) : h('span', { class: 'muted-dash', text: '—' })]),
      ]);
      tbody.appendChild(row);
      sparkTasks.push({ box: sparkDiv, code: acc.code });
    });
    tbl.appendChild(tbody);

    var card = h('div', { class: 'card' }, [
      cardHead('accounts', sideColor, '전 계정 분석 매트릭스 — ' + schools[sid].n + ' · ' + yr + '년 ' + accSideWord(side),
        '계층 들여쓰기 · 금액/구성비/전년비 · 9개년 스파크라인 · 벤치마크 백분위 3종(총계 대비 구성비, 상위%) · 학생 1인당 · 성격(CV). 행 클릭 → 수지 구조 심층 분석'
        + (hiddenZero && !S.t8_zero ? ' · 0원 ' + hiddenZero + '개 숨김' : '')),
    ]);
    card.appendChild(h('div', { class: 'tbl-wrap acc-wrap' }, [tbl]));
    if (!shown) card.appendChild(h('p', { class: 'hint', text: '표시할 계정이 없습니다. (0원 계정 표시를 켜보세요)' }));

    function drawSpark(t) { C.sparkline(t.box, { points: YEARS.map(function (y) { return [y, gv(side, t.code, sid, y)]; }), color: color, height: 30, last: false }); }
    if (sparkTasks.length <= 60) { sparkTasks.forEach(drawSpark); }
    else {
      var i = 0, raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
      (function chunk() { var n = 0; while (i < sparkTasks.length && n < 40) { drawSpark(sparkTasks[i++]); n++; } if (i < sparkTasks.length) raf(chunk); })();
    }
    return card;
  }

  // ═══════════════════════════════════════════════════════
  //  탭 3 — 시계열
  // ═══════════════════════════════════════════════════════
  function renderTimeseries(v) {
    var m = S.t3_metric;
    // 지표 선택: KPI select + 계정 검색
    var kpiSel = h('select', { class: 'sel', onChange: function () { S.t3_metric = { type: 'kpi', name: this.value }; render(); } },
      KPI_KEYS.map(function (k) { return h('option', { value: k, selected: (m.type === 'kpi' && m.name === k) ? 'selected' : null, text: KPI_META[k].label }); }));
    var search = h('input', { class: 'txt', type: 'text', placeholder: '계정 검색 (예: 장학금, 4100)', style: 'width:220px' });
    var results = h('div', { class: 'opt-list' });
    search.addEventListener('input', function () {
      var q = this.value.trim(); results.innerHTML = '';
      if (!q) return;
      var hits = [];
      ['in', 'ex'].forEach(function (side) {
        DATA.accounts[side].forEach(function (a) {
          if (LITE && a.lv === 3) return;
          if (a.name.indexOf(q) >= 0 || a.code.indexOf(q) >= 0) hits.push({ side: side, a: a });
        });
      });
      hits.slice(0, 12).forEach(function (hit) {
        results.appendChild(h('button', { class: 'chip', text: (hit.side === 'in' ? '수입·' : '지출·') + hit.a.name, onClick: function () { S.t3_metric = { type: 'acc', side: hit.side, code: hit.a.code }; render(); } }));
      });
    });
    v.appendChild(h('div', { class: 'row-controls' }, [
      ctrl('KPI 지표', kpiSel),
      ctrl('또는 계정 검색', h('div', {}, [search, results])),
    ]));

    // 메인 차트
    var title, fmt, tipFmt, yFmt, higher;
    var yrs = YEARS.filter(function (y) { return y >= S.y0 && y <= S.y1; });
    var kmuPts, band = null;
    if (m.type === 'kpi') {
      var meta = KPI_META[m.name]; title = meta.label; fmt = meta.fmt;
      kmuPts = yrs.map(function (y) { return [y, kv(m.name, KMU_ID, y)]; });
      var lo = [], hi = [], mid = [];
      yrs.forEach(function (y) { var cs = cohortStats(m.name, y); lo.push([y, cs ? cs.p25 : null]); hi.push([y, cs ? cs.p75 : null]); mid.push([y, cs ? cs.p50 : null]); });
      band = { lo: lo, hi: hi, mid: mid, color: 'var(--band)' };
      yFmt = fmt === 'pct' ? function (x) { return F.pct(x, 0); } : F.krwAxis;
      tipFmt = fmt === 'pct' ? function (x) { return F.pct(x); } : F.krw;
    } else {
      var acc = ACC[m.side][m.code]; title = (m.side === 'in' ? '수입·' : '지출·') + acc.name; fmt = 'krw';
      kmuPts = yrs.map(function (y) { return [y, gv(m.side, m.code, KMU_ID, y)]; });
      var lo2 = [], hi2 = [], mid2 = [], pop = filteredSchoolIds();
      yrs.forEach(function (y) { var st = stats(pop.map(function (p) { return gv(m.side, m.code, p, y); })); lo2.push([y, st ? st.p25 : null]); hi2.push([y, st ? st.p75 : null]); mid2.push([y, st ? st.p50 : null]); });
      band = { lo: lo2, hi: hi2, mid: mid2, color: 'var(--band)' };
      yFmt = F.krwAxis; tipFmt = F.krw;
    }
    var events = (DATA.meta.notes || []).map(function (nt) { return { x0: nt.span[0], x1: nt.span[1], label: nt.label }; });

    var mainCard = h('div', { class: 'card' }, [
      h('h3', { text: title + ' — 국민대 vs 코호트' }),
      h('div', { class: 'card-sub', text: '국민대 실선 · 코호트 p25~p75 밴드 · p50 점선 · 이벤트 음영(입학금 폐지 등)' }),
    ]);
    var mainBox = chartBox(320); mainCard.appendChild(mainBox);
    mainCard.appendChild(bandLegend());
    v.appendChild(mainCard);
    v.appendChild(h('div', { class: 'spacer-v' }));

    C.line(mainBox, { height: 320, series: [{ name: '국민대', color: 'var(--kmu)', points: kmuPts, emphasize: true, label: '국민대' }], band: band, events: events, xTicks: yrs, yFmt: yFmt, tipFmt: tipFmt, yZero: fmt === 'krw' });

    // Small multiples (KPI 10)
    var smCard = h('div', { class: 'card' }, [h('h3', { text: 'KPI Small Multiples — 국민대 ' + S.y0 + '~' + S.y1 }), h('div', { class: 'card-sub', text: '10개 지표 동시 조망 · 클릭하면 위 차트에 로드' })]);
    var sm = h('div', { class: 'small-mult' });
    KPI_KEYS.forEach(function (k) {
      var meta = KPI_META[k];
      var cur = kv(k, KMU_ID, S.y1);
      var cell = h('div', { class: 'sm-cell', style: 'cursor:pointer', onClick: function () { S.t3_metric = { type: 'kpi', name: k }; render(); } }, [
        h('div', { class: 'sm-title', text: meta.label }),
        h('div', { class: 'sm-val', text: S.y1 + ': ' + F.byFmt(cur, meta.fmt) }),
      ]);
      var box = chartBox(46); cell.appendChild(box);
      sm.appendChild(cell);
      var pts = yrs.map(function (y) { return [y, kv(k, KMU_ID, y)]; });
      C.sparkline(box, { points: pts, color: 'var(--kmu)', height: 46 });
    });
    smCard.appendChild(sm);
    v.appendChild(smCard);
  }

  // ═══════════════════════════════════════════════════════
  //  탭 4 — 대학 비교
  // ═══════════════════════════════════════════════════════
  function renderCompare(v) {
    // 다중 선택
    var tagWrap = h('div', { class: 'multi-tags' });
    S.t4_schools.forEach(function (sid) {
      var s = schools[sid];
      tagWrap.appendChild(h('span', { class: 'tag' + (sid === KMU_ID ? ' kmu' : ''), html: '<i style="width:9px;height:9px;border-radius:2px;background:' + C.resolveColor(schoolColor(sid)) + '"></i>' + s.n + '<span class="x">✕</span>' + (sid === KMU_ID ? ' ★' : '') },
        // remove handler on x
      ));
    });
    // wire removes
    Array.prototype.forEach.call(tagWrap.querySelectorAll('.tag'), function (tag, i) {
      var sid = S.t4_schools[i];
      var x = tag.querySelector('.x');
      if (x && sid !== KMU_ID) x.addEventListener('click', function () { S.t4_schools = S.t4_schools.filter(function (z) { return z !== sid; }); render(); });
    });
    // 검색 기반 대학 추가 선택기 (전체 나열 대신 부분일치 드롭다운)
    var searchWrap = h('div', { class: 'school-search' });
    var input = h('input', { class: 'txt', type: 'text', placeholder: '대학명 검색해서 추가…', style: 'width:300px', autocomplete: 'off' });
    var dropdown = h('div', { class: 'ss-dropdown' });
    dropdown.style.display = 'none';
    searchWrap.appendChild(input); searchWrap.appendChild(dropdown);
    var ssHits = [], ssActive = -1;
    function ssCandidates(q) {
      var out = [];
      filteredSchoolIds().forEach(function (sid) {          // 현재 필터 모집단만
        if (sid === KMU_ID) return;                          // 국민대는 고정 → 목록 제외
        if (S.t4_schools.indexOf(sid) >= 0) return;          // 이미 선택 제외
        if (q && schools[sid].n.indexOf(q) < 0) return;
        out.push(sid);
      });
      return out.slice(0, 10);
    }
    function ssAdd(sid) {
      if (S.t4_schools.length >= 8) { alert('국민대 포함 최대 8개'); return; }
      if (S.t4_schools.indexOf(sid) >= 0) return;
      S.t4_schools.push(sid); render();
    }
    function ssRender() {
      dropdown.innerHTML = '';
      if (!ssHits.length) {
        dropdown.style.display = 'block';
        dropdown.appendChild(h('div', { class: 'ss-empty', text: input.value.trim() ? '일치하는 대학이 없습니다' : '검색어를 입력하세요 (현재 필터 모집단 내)' }));
        return;
      }
      dropdown.style.display = 'block';
      ssHits.forEach(function (sid, i) {
        var opt = h('div', { class: 'ss-opt' + (i === ssActive ? ' active' : ''),
          html: '<i style="background:' + C.resolveColor(schoolColor(sid)) + '"></i><span class="ss-nm">' + schools[sid].n + '</span><span class="ss-region">' + schools[sid].region + ' · ' + schools[sid].scale + '</span>' });
        opt.addEventListener('mousedown', function (e) { e.preventDefault(); ssAdd(sid); });
        opt.addEventListener('mouseenter', function () { ssActive = i; ssRender(); });
        dropdown.appendChild(opt);
      });
    }
    function ssRefresh() { ssHits = ssCandidates(input.value.trim()); ssActive = ssHits.length ? 0 : -1; ssRender(); }
    input.addEventListener('input', ssRefresh);
    input.addEventListener('focus', ssRefresh);
    input.addEventListener('blur', function () { setTimeout(function () { dropdown.style.display = 'none'; }, 150); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (ssHits.length) { ssActive = (ssActive + 1) % ssHits.length; ssRender(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (ssHits.length) { ssActive = (ssActive - 1 + ssHits.length) % ssHits.length; ssRender(); } }
      else if (e.key === 'Enter') { e.preventDefault(); if (ssActive >= 0 && ssHits[ssActive] != null) ssAdd(ssHits[ssActive]); }
      else if (e.key === 'Escape') { dropdown.style.display = 'none'; }
    });
    var metricSel = h('select', { class: 'sel', onChange: function () { S.t4_metric = this.value; render(); } },
      KPI_KEYS.map(function (k) { return h('option', { value: k, selected: k === S.t4_metric ? 'selected' : null, text: KPI_META[k].label }); }));
    v.appendChild(h('div', { class: 'row-controls' }, [
      ctrl('비교 대학 (국민대 고정 + 최대 7)', h('div', {}, [tagWrap, searchWrap])),
      ctrl('라인 지표', metricSel),
    ]));

    var yrs = YEARS.filter(function (y) { return y >= S.y0 && y <= S.y1; });
    // 라인 비교
    var meta = KPI_META[S.t4_metric];
    var lineCard = h('div', { class: 'card' }, [h('h3', { text: meta.label + ' — 대학 비교' }), h('div', { class: 'card-sub', text: '국민대 굵은 강조선' })]);
    var lineBox = chartBox(320); lineCard.appendChild(lineBox);
    var series = S.t4_schools.map(function (sid) {
      return { name: schools[sid].n, color: schoolColor(sid), emphasize: sid === KMU_ID, label: sid === KMU_ID ? '국민대' : null, points: yrs.map(function (y) { return [y, kv(S.t4_metric, sid, y)]; }) };
    });
    lineCard.appendChild(compareLegend(S.t4_schools));
    v.appendChild(lineCard);
    v.appendChild(h('div', { class: 'spacer-v' }));
    C.line(lineBox, { height: 320, series: series, xTicks: yrs, yFmt: meta.fmt === 'pct' ? function (x) { return F.pct(x, 0); } : F.krwAxis, tipFmt: meta.fmt === 'pct' ? function (x) { return F.pct(x); } : F.krw, yZero: meta.fmt === 'krw' });

    // 산점도
    var axisOpts = [{ v: 'enroll', label: '재학생수' }].concat(KPI_KEYS.map(function (k) { return { v: k, label: KPI_META[k].label }; }));
    function axisSel(cur, on) { return h('select', { class: 'sel', onChange: function () { on(this.value); render(); } }, axisOpts.map(function (o) { return h('option', { value: o.v, selected: o.v === cur ? 'selected' : null, text: o.label }); })); }
    var scCard = h('div', { class: 'card' }, [
      h('h3', { text: '산점도 — ' + S.y1 + '년' }),
      h('div', { class: 'card-sub', text: '국민대 강조 · 선택 대학 색상 · 그 외 모집단 회색' }),
      h('div', { class: 'row-controls' }, [ctrl('X축', axisSel(S.t4_x, function (v2) { S.t4_x = v2; })), ctrl('Y축', axisSel(S.t4_y, function (v2) { S.t4_y = v2; }))]),
    ]);
    var scBox = chartBox(360); scCard.appendChild(scBox);
    v.appendChild(scCard);
    v.appendChild(h('div', { class: 'spacer-v' }));
    drawCompareScatter(scBox);

    // 랭킹 테이블
    v.appendChild(renderRankingTable());
  }
  function compareLegend(sids) {
    return h('div', { class: 'legend' }, sids.map(function (sid) {
      return h('span', { class: 'lg' + (sid === KMU_ID ? ' kmu' : ''), html: '<i style="background:' + C.resolveColor(schoolColor(sid)) + '"></i>' + schools[sid].n });
    }));
  }
  function axisValue(key, sid, yr) {
    if (key === 'enroll') { var e = schools[sid].enroll; return e ? e[String(yr)] : null; }
    return kv(key, sid, yr);
  }
  function axisFmt(key) {
    if (key === 'enroll') return F.intComma;
    return KPI_META[key].fmt === 'pct' ? function (x) { return F.pct(x, 0); } : F.krwAxis;
  }
  function drawCompareScatter(box) {
    var yr = S.y1, pop = filteredSchoolIds();
    var sel = S.t4_schools;
    var pts = [];
    // 모집단 회색(미선택)
    pop.forEach(function (sid) {
      if (sel.indexOf(sid) >= 0) return;
      pts.push({ x: axisValue(S.t4_x, sid, yr), y: axisValue(S.t4_y, sid, yr), label: schools[sid].n, color: 'var(--muted)', dim: true });
    });
    sel.forEach(function (sid) {
      pts.push({ x: axisValue(S.t4_x, sid, yr), y: axisValue(S.t4_y, sid, yr), label: schools[sid].n, color: schoolColor(sid), emphasize: sid === KMU_ID });
    });
    C.scatter(box, {
      points: pts, height: 360,
      xLabel: S.t4_x === 'enroll' ? '재학생수' : KPI_META[S.t4_x].label,
      yLabel: S.t4_y === 'enroll' ? '재학생수' : KPI_META[S.t4_y].label,
      xFmt: axisFmt(S.t4_x), yFmt: axisFmt(S.t4_y),
    });
  }
  function renderRankingTable() {
    var yr = S.y1, metric = S.t4_sort.key, meta = KPI_META[metric];
    var pop = filteredSchoolIds();
    var rowsD = pop.map(function (sid) {
      return { sid: sid, name: schools[sid].n, kmu: sid === KMU_ID, val: kv(metric, sid, yr) };
    }).filter(function (r) { return r.val != null; });
    // 백분위 (higher-good이면 값 클수록 상위)
    var sortedVals = rowsD.map(function (r) { return r.val; }).slice().sort(function (a, b) { return a - b; });
    rowsD.forEach(function (r) {
      var below = sortedVals.filter(function (v) { return v < r.val; }).length;
      var pct = sortedVals.length > 1 ? below / (sortedVals.length - 1) : 1;
      r.pctile = meta.higher === false ? 1 - pct : pct; // 낮을수록 좋은 지표는 반전
    });
    rowsD.sort(function (a, b) { return S.t4_sort.asc ? a.val - b.val : b.val - a.val; });

    var card = h('div', { class: 'card' }, [
      h('h3', { text: '랭킹 — ' + meta.label + ' (' + yr + '년, 현재 필터 모집단)' }),
      h('div', { class: 'card-sub', text: '헤더 클릭 정렬 · 국민대 행 고정 강조 · 백분위(지표 방향 반영)' }),
    ]);
    var tbl = h('table', { class: 'data' });
    var metricOpts = KPI_KEYS;
    var thMetric = h('th', { class: 'sorted' + (S.t4_sort.asc ? ' asc' : ''), text: meta.label, onClick: function () { S.t4_sort = { key: metric, asc: !S.t4_sort.asc }; render(); } });
    var head = h('tr', {}, [
      h('th', { text: '순위' }),
      h('th', { text: '대학' }),
      thMetric,
      h('th', { text: '백분위' }),
    ]);
    var thead = h('thead', {}, [head]);
    // 지표 변경 select in caption
    var sel = h('select', { class: 'sel', style: 'margin-bottom:10px', onChange: function () { S.t4_sort = { key: this.value, asc: false }; render(); } },
      metricOpts.map(function (k) { return h('option', { value: k, selected: k === metric ? 'selected' : null, text: '정렬 지표: ' + KPI_META[k].label }); }));
    card.appendChild(sel);
    var tbody = h('tbody');
    rowsD.forEach(function (r, i) {
      var nameCell = h('span', { class: 'name-cell' }, [
        h('span', { class: 'tsq', style: 'background:' + schoolColor(r.sid) }),
        h('span', { text: r.name }),
        r.kmu ? h('span', { class: 'kmu-star', text: '★' }) : null,
      ]);
      var pctCell = h('span', { class: 'pctcell' }, [
        pieGlyph(r.pctile, schoolColor(r.sid)),
        h('span', { text: F.percentileLabel(r.pctile) }),
      ]);
      tbody.appendChild(h('tr', { class: r.kmu ? 'kmu-row' : '' }, [
        h('td', { text: (i + 1) }),
        h('td', {}, [nameCell]),
        h('td', { text: F.byFmt(r.val, meta.fmt) }),
        h('td', {}, [pctCell]),
      ]));
    });
    tbl.appendChild(thead); tbl.appendChild(tbody);
    card.appendChild(h('div', { class: 'tbl-wrap' }, [tbl]));
    return card;
  }

  // ═══════════════════════════════════════════════════════
  //  탭 6 — 위기 진단 (구조 리스크 지수, 참고용)
  // ═══════════════════════════════════════════════════════
  function noExt(v, msg) {
    v.appendChild(h('div', { class: 'card' }, [h('h3', { text: '확장 데이터 없음' }), h('p', { class: 'hint', text: msg })]));
  }
  // 위험 방향 백분위 (0~1, 높을수록 위험). sortedAsc = 오름차순 값 배열.
  function riskPct(sortedAsc, value, higherIsRisk) {
    if (value == null || isNaN(value) || sortedAsc.length < 2) return null;
    var below = 0;
    for (var i = 0; i < sortedAsc.length; i++) if (sortedAsc[i] < value) below++;
    var frac = below / (sortedAsc.length - 1);
    return higherIsRisk ? frac : 1 - frac;
  }
  function factorCell(frac) {
    if (frac == null) return h('div', { class: 'factor-cell' }, [h('span', { class: 'fc-val', text: '—' })]);
    return h('div', { class: 'factor-cell' }, [
      h('div', { class: 'fc-track' }, [h('div', { class: 'fc-fill', style: 'width:' + Math.max(3, frac * 100).toFixed(0) + '%;background:' + riskColor(frac * 100) })]),
      h('span', { class: 'fc-val', text: Math.round(frac * 100) }),
    ]);
  }

  function renderCrisis(v) {
    if (!HAS_EXT) return noExt(v, 'ext 블록이 없어 위기 진단을 표시할 수 없습니다.');
    var yr = Y_LAST, pop = filteredSchoolIds();

    // ── A) 리스크 매트릭스 ──
    var mCard = h('div', { class: 'card' }, [
      cardHead('crisis', 'var(--serious)', '리스크 매트릭스 — ' + yr + '년',
        'x 충원율 · y 등록금의존율(총계) · 점 크기 = 재학생 규모 · 색 = 구조 리스크 지수(낮음→높음) · 국민대 강조'),
    ]);
    var mBox = chartBox(430); mCard.appendChild(mBox);
    mCard.appendChild(h('div', { class: 'risk-legend' }, [
      h('span', { class: 'rl-grad', html: '<span class="rl-cap">낮음</span><span class="rl-bar" style="background:' + riskGradientCSS() + '"></span><span class="rl-cap">높음</span> 구조 리스크 지수' }),
      h('span', { class: 'rl-size', html: '규모 <i style="width:8px;height:8px"></i><i style="width:15px;height:15px"></i> 재학생 수' }),
      h('span', { class: 'lg kmu', html: '<i style="width:11px;height:11px;border-radius:50%;background:var(--kmu)"></i>국민대' }),
    ]));
    v.appendChild(mCard);
    v.appendChild(h('div', { class: 'spacer-v' }));
    drawRiskMatrix(mBox, pop, yr);

    // ── B) 구조 리스크 지수 테이블 ──
    // 5요소 분포(전체 학교, 최신 가용값) 사전 계산
    function sortedVals(getter) {
      var a = [];
      schools.forEach(function (s, i) { var r = latestOf(getter, i); if (r) a.push(r.v); });
      return a.sort(function (x, y2) { return x - y2; });
    }
    var G = {
      fill: function (s, y) { return exSer('충원율', s, y); },
      dep: function (s, y) { return kv('등록금의존율_총계', s, y); },
      op: function (s, y) { return kv('운영수지율', s, y); },
      ms: function (s, y) { return exK2('적립금지속월수', s, y); },
    };
    var SORTED = { fill: sortedVals(G.fill), dep: sortedVals(G.dep), op: sortedVals(G.op), ms: sortedVals(G.ms) };
    var declineVals = Object.keys(SIDO_DECLINE).map(function (k) { return -SIDO_DECLINE[k]; }).sort(function (a, b) { return a - b; });
    function fac(sid) {
      var f = latestOf(G.fill, sid), d = latestOf(G.dep, sid), o = latestOf(G.op, sid), m = latestOf(G.ms, sid);
      var dec = SIDO_DECLINE[schools[sid].sido];
      return {
        fill: f ? riskPct(SORTED.fill, f.v, false) : null,
        dep: d ? riskPct(SORTED.dep, d.v, true) : null,
        op: o ? riskPct(SORTED.op, o.v, false) : null,
        ms: m ? riskPct(SORTED.ms, m.v, false) : null,
        pop: dec != null ? riskPct(declineVals, -dec, true) : null,
      };
    }
    var scored = schools.map(function (s, i) { return { sid: i, score: latestScore(i) }; })
      .filter(function (r) { return r.score != null; })
      .sort(function (a, b) { return b.score - a.score; });
    scored.forEach(function (r, i) { r.rank = i + 1; });
    var TOPN = 20;
    var shown = scored.slice(0, TOPN);
    var kmuRow = scored.filter(function (r) { return r.sid === KMU_ID; })[0];
    var kmuInTop = shown.some(function (r) { return r.sid === KMU_ID; });

    var tCard = h('div', { class: 'card' }, [
      cardHead('crisis', 'var(--critical)', '구조 리스크 지수 (참고용) — 상위 ' + TOPN + '개교',
        '위기스코어 내림차순 · 5요소 위험 백분위 분해(0~100, 높을수록 위험) · 국민대 고정 하이라이트 · 폐교 대학 회색'),
    ]);
    var rt = h('table', { class: 'risk-table' });
    rt.appendChild(h('thead', {}, [h('tr', {}, [
      h('th', { class: 'tal', text: '순위' }), h('th', { class: 'tal', text: '대학' }), h('th', { text: '시도' }),
      h('th', { text: '충원율' }), h('th', { text: '등록금의존' }), h('th', { text: '운영수지' }),
      h('th', { text: '적립금월수' }), h('th', { text: '소재지 인구' }), h('th', { text: '종합' }),
    ])]));
    var rtb = h('tbody');
    function riskRow(r) {
      var s = schools[r.sid], cy = closedYear(r.sid), f = fac(r.sid), band = scoreBand(r.score);
      var nameKids = [h('span', { class: 'rt-name', text: s.n })];
      if (s.kmu) nameKids.push(h('span', { class: 'kmu-star', text: '★' }));
      if (cy != null) nameKids.push(h('span', { class: 'closed-badge', text: '폐교 ' + cy }));
      return h('tr', { class: (r.sid === KMU_ID ? 'kmu-row ' : '') + (cy != null ? 'closed-row' : '') }, [
        h('td', { class: 'tal rt-rank', text: r.rank }),
        h('td', { class: 'tal' }, nameKids),
        h('td', { text: s.sido }),
        h('td', {}, [factorCell(f.fill)]), h('td', {}, [factorCell(f.dep)]), h('td', {}, [factorCell(f.op)]),
        h('td', {}, [factorCell(f.ms)]), h('td', {}, [factorCell(f.pop)]),
        h('td', {}, [h('span', { class: 'score-pill ' + band, html: '<i></i>' + SCORE_BAND_LABEL[band] + ' ' + r.score.toFixed(0) })]),
      ]);
    }
    shown.forEach(function (r) { rtb.appendChild(riskRow(r)); });
    if (!kmuInTop && kmuRow) {
      rtb.appendChild(h('tr', {}, [h('td', { colspan: 9, style: 'text-align:center;color:var(--muted);font-size:0.72rem;padding:6px', text: '⋯ 국민대 순위 ' + kmuRow.rank + '위 / ' + scored.length + '개교 ⋯' })]));
      rtb.appendChild(riskRow(kmuRow));
    }
    rt.appendChild(rtb);
    tCard.appendChild(h('div', { class: 'tbl-wrap' }, [rt]));
    tCard.appendChild(h('div', { class: 'footnote', html: '<b>구조 리스크 지수 정의</b> · ' + (EXT.meta2 ? EXT.meta2.위기스코어_정의 : '') }));
    v.appendChild(tCard);
    v.appendChild(h('div', { class: 'spacer-v' }));

    // ── C) 폐교 궤적 오버레이 ──
    var ct = EXT.closure_traj || { offsets: [], 충원율: [], n: 0 };
    var schoolSel = h('select', { class: 'sel', onChange: function () { S.t6_traj = +this.value; render(); } },
      schools.map(function (s, i) { return h('option', { value: i, selected: i === S.t6_traj ? 'selected' : null, text: s.n + (s.kmu ? ' ★' : '') }); }));
    var cCard = h('div', { class: 'card' }, [
      cardHead('timeseries', 'var(--serious)', '폐교 궤적 오버레이 — 충원율',
        '폐교 ' + ct.n + '개교의 폐교 직전 5년(t-5~t-1) 충원율 중앙값 · 선택 대학 최근 5년을 겹쳐 "폐교 패턴과의 거리" 확인'),
      h('div', { class: 'row-controls' }, [ctrl('비교 대학', schoolSel)]),
    ]);
    var cBox = chartBox(320); cCard.appendChild(cBox);
    cCard.appendChild(h('div', { class: 'legend' }, [
      h('span', { class: 'lg', html: '<i class="dash" style="color:var(--serious)"></i>폐교 ' + ct.n + '교 중앙값' }),
      h('span', { class: 'lg' + (S.t6_traj === KMU_ID ? ' kmu' : ''), html: '<i style="background:' + (S.t6_traj === KMU_ID ? 'var(--kmu)' : 'var(--series-2)') + '"></i>' + schools[S.t6_traj].n + ' 최근 5년' }),
    ]));
    var opMed = ct.운영수지율 && ct.운영수지율.length ? ct.운영수지율[Math.floor(ct.운영수지율.length / 2)] : null;
    cCard.appendChild(h('div', { class: 'footnote', html: '표본 <b>n=' + ct.n + '</b>교로 통계적 일반화에는 한계가 있습니다. 폐교군은 충원율뿐 아니라 운영수지율·등록금의존율도 폐교 직전 급격히 악화되나(운영수지율 t-2 중앙값 약 ' + (opMed != null ? F.pct(opMed, 0) : '—') + '), 표본 편차가 큽니다.' }));
    v.appendChild(cCard);
    drawClosureTraj(cBox, ct);
  }

  function drawRiskMatrix(box, pop, yr) {
    var plotted = pop.filter(function (sid) { return exSer('충원율', sid, yr) != null && kv('등록금의존율_총계', sid, yr) != null; });
    var enrolls = plotted.map(function (sid) { var e = schools[sid].enroll; return e ? e[String(yr)] : null; }).filter(function (x) { return x != null; });
    var eMin = enrolls.length ? Math.min.apply(null, enrolls) : 0, eMax = enrolls.length ? Math.max.apply(null, enrolls) : 1;
    function rad(sid) {
      var e = schools[sid].enroll; var val = e ? e[String(yr)] : null;
      if (val == null || eMax === eMin) return 6;
      var t = Math.sqrt((val - eMin) / (eMax - eMin));
      return 4.5 + t * 12;
    }
    var fills = plotted.map(function (sid) { return exSer('충원율', sid, yr); }).sort(function (a, b) { return a - b; });
    var deps = plotted.map(function (sid) { return kv('등록금의존율_총계', sid, yr); }).sort(function (a, b) { return a - b; });
    var medFill = quantile(fills, 0.5), medDep = quantile(deps, 0.5);
    var pts = plotted.map(function (sid) {
      return {
        x: exSer('충원율', sid, yr), y: kv('등록금의존율_총계', sid, yr),
        r: rad(sid), label: schools[sid].n,
        color: sid === KMU_ID ? 'var(--kmu)' : riskColor(latestScore(sid)),
        emphasize: sid === KMU_ID,
      };
    });
    C.scatter(box, {
      points: pts, height: 430,
      xLabel: '충원율(최신연도)', yLabel: '등록금의존율(총계)',
      xFmt: function (x) { return F.pct(x, 0); }, yFmt: function (x) { return F.pct(x, 0); },
      guides: {
        x: medFill, y: medDep, labels: [
          { corner: 'tl', text: '수요↓·의존↑ 고위험' }, { corner: 'tr', text: '의존↑(등록금 편중)' },
          { corner: 'bl', text: '수요↓ 주의' }, { corner: 'br', text: '수요↑·의존↓ 안정' },
        ],
      },
    });
  }
  function drawClosureTraj(box, ct) {
    var offs = ct.offsets || [];
    var med = offs.map(function (o, i) { return [o, ct.충원율[i]]; });
    // 선택 대학 최근 5년 → t-5..t-1 = (Y_LAST-4)..Y_LAST
    var sid = S.t6_traj;
    var sch = offs.map(function (o) { var yy = Y_LAST + (o + 1); return [o, exSer('충원율', sid, yy)]; });
    C.line(box, {
      height: 320,
      series: [
        { name: '폐교 ' + ct.n + '교 중앙값', color: 'var(--serious)', points: med, dashed: true },
        { name: schools[sid].n, color: sid === KMU_ID ? 'var(--kmu)' : 'var(--series-2)', points: sch, emphasize: true, label: sid === KMU_ID ? '국민대' : null },
      ],
      xTicks: offs, yFmt: function (x) { return F.pct(x, 0); }, tipFmt: function (x) { return F.pct(x); },
    });
  }

  // ═══════════════════════════════════════════════════════
  //  탭 7 — 구조 전망
  // ═══════════════════════════════════════════════════════
  function renderOutlook(v) {
    if (!HAS_EXT || !EXT.population) return noExt(v, 'ext.population 이 없어 구조 전망을 표시할 수 없습니다.');
    var P = EXT.population, sidos = P.sidos, pyears = P.years;
    var yi = {}; pyears.forEach(function (y, i) { yi[y] = i; });
    function sidoPop(sido, year) { var si = sidos.indexOf(sido); return si < 0 ? null : P.age18_21[si][yi[year]]; }
    function natPop(year) { var t = 0; sidos.forEach(function (sd, si) { t += P.age18_21[si][yi[year]]; }); return t; }

    // ── A) 학령인구 절벽 ──
    var chips = h('div', { class: 'chip-row' });
    chips.appendChild(h('button', { class: 'chip' + (S.t7_natl ? ' on' : ''), text: '전국 합계', onClick: function () { S.t7_natl = !S.t7_natl; render(); } }));
    sidos.forEach(function (sd) {
      chips.appendChild(h('button', { class: 'chip' + (S.t7_sidos.has(sd) ? ' on' : ''), text: sd, onClick: function () { if (S.t7_sidos.has(sd)) S.t7_sidos.delete(sd); else S.t7_sidos.add(sd); render(); } }));
    });
    var cliffCard = h('div', { class: 'card' }, [
      cardHead('outlook', 'var(--kmu)', '학령인구 절벽 — 18~21세 추계(' + pyears[0] + '~' + pyears[pyears.length - 1] + ')',
        '통계청 시도 장래인구추계 · 2025년~ 추계 구간(점선·음영) · 전국 합계 굵은 선 · 국민대 소재지 서울 강조'),
      h('div', { class: 'filter-group', style: 'margin-bottom:14px' }, [h('label', { text: '표시 시도' }), chips]),
    ]);
    var cliffBox = chartBox(360); cliffCard.appendChild(cliffBox);
    var series = [];
    if (S.t7_natl) series.push({ name: '전국 합계', color: 'var(--band)', points: pyears.map(function (y) { return [y, natPop(y)]; }), emphasize: true, width: 3.4, label: '전국' });
    var cyc = 0;
    Array.from(S.t7_sidos).forEach(function (sd) {
      var col = sd === '서울' ? 'var(--kmu)' : 'var(--series-' + ((cyc++ % 6) + 2) + ')';
      series.push({ name: sd, color: col, emphasize: sd === '서울', points: pyears.map(function (y) { return [y, sidoPop(sd, y)]; }), label: sd === '서울' ? '서울' : null });
    });
    cliffCard.appendChild(h('div', { class: 'legend' }, series.map(function (s) {
      return h('span', { class: 'lg' + (s.color === 'var(--kmu)' ? ' kmu' : ''), html: '<i style="background:' + C.resolveColor(s.color) + '"></i>' + s.name });
    })));
    v.appendChild(cliffCard);
    v.appendChild(h('div', { class: 'spacer-v' }));
    C.line(cliffBox, { height: 360, series: series, projFrom: 2025, projLabel: '추계 구간', xTicks: [2022, 2024, 2028, 2032, 2036, 2040, 2046, 2052], yFmt: fmtPopAxis, tipFmt: fmtPop });

    // ── B) 권역 전망 바 ──
    var ro = (EXT.region_outlook || []).slice().sort(function (a, b) { return a.decline18_2040 - b.decline18_2040; });
    var maxDec = Math.max.apply(null, ro.map(function (r) { return -r.decline18_2040; })) || 1;
    var bars = h('div', { class: 'region-bars' });
    ro.forEach(function (r) {
      var frac = (-r.decline18_2040) / maxDec;
      var isSeoul = r.sido === '서울';
      bars.appendChild(h('div', { class: 'rb-row' + (isSeoul ? ' kmu' : '') }, [
        h('div', { class: 'rb-label', html: r.sido + '<span class="rb-region">' + r.region + '</span>' }),
        h('div', { class: 'rb-track' }, [
          h('div', { class: 'rb-fill', style: 'width:' + (frac * 100).toFixed(1) + '%;background:' + riskColor(frac * 100) }),
          h('span', { class: 'rb-pct', text: F.pct(r.decline18_2040, 1) }),
        ]),
        h('div', { class: 'rb-meta', html: '사립대 <b>' + r.uni_count + '</b>교<br>평균충원 <b>' + F.pct(r.avg_fill, 0) + '</b>' }),
      ]));
    });
    var roCard = h('div', { class: 'card' }, [
      cardHead('outlook', 'var(--serious)', '권역(시도) 전망 — 18~21세 2024→2040 감소율',
        '감소율 큰 순 · 각 시도 소재 사립대 수 · 평균 충원율 병기 · 국민대 소재지 서울 강조'),
      bars,
    ]);
    v.appendChild(roCard);
    v.appendChild(h('div', { class: 'spacer-v' }));

    // ── C) 수요-공급 갭 ──
    function regionPop(region, year) { var t = 0; sidos.forEach(function (sd, si) { if (SIDO_REGION[sd] === region) t += P.age18_21[si][yi[year]]; }); return t; }
    var capByRegion = {};
    schools.forEach(function (s, i) { var cap = exSer('입학정원', i, Y_LAST); if (cap != null) capByRegion[s.region] = (capByRegion[s.region] || 0) + cap; });
    var gapYears = [2024, 2026, 2028, 2030, 2032, 2034, 2036, 2038, 2040];
    var regions = ['수도권', '광역권', '지방권'];
    var regColor = { '수도권': 'var(--kmu)', '광역권': 'var(--series-4)', '지방권': 'var(--series-3)' };
    var gapSeries = regions.map(function (rg) {
      var base = regionPop(rg, 2024);
      return { name: rg + ' 입학자원', color: regColor[rg], emphasize: rg === '수도권', points: gapYears.map(function (y) { return [y, base ? regionPop(rg, y) / base * 100 : null]; }), label: rg === '수도권' ? null : null };
    });
    gapSeries.push({ name: '정원(2024 유지)', color: 'var(--muted)', points: gapYears.map(function (y) { return [y, 100]; }), dashed: true, dim: true });
    var gapCard = h('div', { class: 'card' }, [
      cardHead('outlook', 'var(--series-2)', '수요-공급 갭 — 권역별 입학자원 지수(2024=100)',
        '2024년 정원-자원 균형을 100으로 지수화(정원 2024 수준 유지 가정) · 입학자원(18~21세)이 정원 대비 몇 %로 줄어드는지'),
    ]);
    var gapBox = chartBox(320); gapCard.appendChild(gapBox);
    gapCard.appendChild(h('div', { class: 'legend' }, gapSeries.map(function (s) {
      return h('span', { class: 'lg' + (s.color === 'var(--kmu)' ? ' kmu' : ''), html: '<i class="' + (s.dashed ? 'dash' : '') + '" style="' + (s.dashed ? 'color:' + C.resolveColor(s.color) : 'background:' + C.resolveColor(s.color)) + '"></i>' + s.name });
    })));
    var gapNote = regions.map(function (rg) {
      var idx = regionPop(rg, 2040) / regionPop(rg, 2024) * 100;
      return rg + ' ' + idx.toFixed(0) + '%';
    }).join(' · ');
    gapCard.appendChild(h('div', { class: 'footnote', html: '<b>2040년 입학자원(정원 대비)</b> · ' + gapNote + ' — 정원을 2024 수준으로 유지하면 모든 권역에서 구조적 미충원 위험. 권역 정원 합(2024): 수도권 ' + F.intComma(capByRegion['수도권']) + '명 · 광역권 ' + F.intComma(capByRegion['광역권']) + '명 · 지방권 ' + F.intComma(capByRegion['지방권']) + '명.' }));
    v.appendChild(gapCard);
    v.appendChild(h('div', { class: 'spacer-v' }));
    C.line(gapBox, { height: 320, series: gapSeries, xTicks: [2024, 2028, 2032, 2036, 2040], yFmt: fmtIdx, tipFmt: function (x) { return x == null ? '—' : x.toFixed(0) + ' (2024=100)'; } });

    // ── D) 국민대 포지션 카드 ──
    var seoulDec = SIDO_DECLINE['서울'], seoulIdx = sidoPop('서울', 2040) / sidoPop('서울', 2024) * 100;
    var fillK = exSer('충원율', KMU_ID, Y_LAST), msK = exK2('적립금지속월수', KMU_ID, Y_LAST), scoreK = latestScore(KMU_ID);
    var capIdx = regionPop('수도권', 2040) / regionPop('수도권', 2024) * 100;
    var banners = h('div', { class: 'pos-banners' }, [
      h('div', { class: 'insight neutral' }, [h('span', { text: '국민대는 서울 소재 수도권 대학으로 상대적 프리미엄. 그러나 서울 18~21세 인구도 2024→2040 ' + F.pct(seoulDec, 1) + '(2040년 2024년의 ' + seoulIdx.toFixed(0) + '% 수준)로 감소가 예정 — 수도권도 안전지대는 아님.' }), h('span', { class: 'in-arrow', text: '→' })]),
      h('div', { class: 'insight good' }, [h('span', { text: '국민대 ' + Y_LAST + '년 충원율 ' + F.pct(fillK, 1) + '로 정원 사실상 충족(코호트 상위권). 수도권 입학자원 지수는 2040년 ' + capIdx.toFixed(0) + '%로 하락하나 대규모·수도권 입지가 완충.' }), h('span', { class: 'in-arrow', text: '→' })]),
      h('div', { class: 'insight neutral' }, [h('span', { text: '재정 완충력 ' + fmtMonths(msK) + ' · 구조 리스크 지수 ' + (scoreK != null ? scoreK.toFixed(0) : '—') + '(' + (scoreK != null ? SCORE_BAND_LABEL[scoreBand(scoreK)] : '—') + '). 단기 리스크는 관리 가능하나, 학령인구 절벽 장기 대비(정원·재정 완충력 확충)가 과제.' }), h('span', { class: 'in-arrow', text: '→' })]),
    ]);
    v.appendChild(h('div', { class: 'card' }, [
      cardHead('shield', 'var(--kmu)', '국민대 포지션 — 전망 맥락 요약', '실데이터 기반 인사이트(충원율·완충력·구조 리스크 지수·서울 인구추계)'),
      banners,
    ]));
  }

  // ═══════════════════════════════════════════════════════
  //  탭 — 입학정원 감소 시뮬레이션 (베타 · 가정 기반)
  //  계약: build/d10_report.md · 설계: docs/시뮬레이션_모델_설계.md 2~9장
  // ═══════════════════════════════════════════════════════
  // KPI 델타 카드 노출 순서(설계 5.1 우선순위)
  var SIM_KPI_CARDS = ['운영수지율', '인건비부담률', '등록금의존율_총계', '운영수지', '교육비환원율', '장학금지원율'];
  // 백테스트 집계 게이트 결과 (sim_backtest_report §0 — 고정 검증치, 정직 노출)
  var SIM_BT_AGG = [
    { k: 'L1 재학 전개 MAPE', v: '3.64%', tgt: '<3%', pass: false },
    { k: 'L2 수입(인원 given) MAPE', v: '2.06%', tgt: '<4%', pass: true },
    { k: 'L3 종단 5110 MAPE', v: '2.47%', tgt: '<5%', pass: true },
    { k: '|MPE| 5110 (계통편향)', v: '0.42%', tgt: '<1.5%', pass: true },
    { k: 'skill 5110 (naive 초과)', v: '0.457', tgt: '>0', pass: true },
  ];
  var SIM_LIMITS = [
    '학부 정원내 수업료(5112)만 감축에 반응 — 대학원·정원외 수입은 외생 고정(ρ_g=1.4 가정 분해).',
    '학년별 정밀 코호트 불가(KESS 학년축 부재) → 잔존곡선 근사. 재학 전개(L1) 3% 게이트 미달 원인.',
    '중도탈락 학교별 실측 미확보 → m_in에 순효과 흡수 + 이탈률 스트레스 슬라이더로만.',
    '대학원 정원 정책 연동 · 국가장학금 상호작용 · 정원외 급변은 미모형(외생 고정).',
    '인구 자연감소에 의한 충원율 하락은 기본 OFF(드리프트 λ 토글로만 노출).',
  ];
  var SIM_NOBT_TYPE = { '전문대학': 1, '사이버대학': 1, '대학원대학': 1 };

  function defaultSimParams() {
    var d = (SIMD && SIMD.meta && SIMD.meta.defaults) || {};
    return {
      r: 0, t0: 2025, horizon: 10, profile: 'immediate', rampYears: 5,
      fillMode: 'realistic', beta: d.beta != null ? d.beta : 0.5, fMax: 1.0,
      piMode: 'freeze', piRate: 0.02, eta5120: d.eta_5120 != null ? d.eta_5120 : 0.3,
      gamma: d.gamma != null ? d.gamma : 0.15, dropout: d.dropout || 0, lambda: d.lambda_ || 0,
      useCorpSupport: false,                  // 법인 추가지원 반영(폐교위험 판정 완충) · 기본 OFF
    };
  }
  // 기준(base) 시나리오 파라미터 = 공유 사용자값 + 기준 번들(설계 7.1)
  function baseScenarioParams(P) {
    var out = {};
    ['r', 't0', 'horizon', 'profile', 'rampYears', 'rSchedule', 'eta5120', 'dropout', 'lambda', 'fMax', 'capCarryForward']
      .forEach(function (k) { if (P[k] !== undefined && P[k] !== null) out[k] = P[k]; });
    out.fillMode = 'realistic'; out.beta = 0.5; out.piMode = 'freeze'; out.gamma = 0.15;
    return out;
  }

  function renderSimulation(v) {
    if (!HAS_SIM) {
      v.appendChild(h('div', { class: 'card' }, [
        h('h3', { text: '시뮬레이션 데이터 없음' }),
        h('p', { class: 'hint', text: 'sim 블록 또는 sim_model.js 계산 엔진이 로드되지 않았습니다.' }),
      ]));
      return;
    }
    var sid = S.sim_school;
    if (!simEntry(sid)) { S.sim_school = KMU_ID; sid = KMU_ID; }
    var entry = simEntry(sid);
    var P = S.sim_params;

    // ── 상단 컨트롤: 모드 + 대학 검색 + 초기화 + 베타 배지 ──
    var modeChips = h('div', { class: 'chip-row' }, [
      h('button', { class: 'chip' + (S.sim_mode === 'single' ? ' on' : ''), text: '개별 대학', onClick: function () { S.sim_mode = 'single'; render(); } }),
      h('button', { class: 'chip' + (S.sim_mode === 'cohort' ? ' on' : ''), text: '코호트 집계', onClick: function () { S.sim_mode = 'cohort'; render(); } }),
    ]);
    var searchWrap = buildSchoolSearch(sid, function (i) { S.sim_school = i; S.sim_focus = null; render(); }, 240);
    var resetBtn = h('button', { class: 'chip', text: '↺ 파라미터 초기화', onClick: function () { S.sim_params = defaultSimParams(); S.sim_focus = null; render(); } });
    v.appendChild(h('div', { class: 'row-controls sim-top' }, [
      ctrl('보기 모드', modeChips),
      S.sim_mode === 'single' ? ctrl('대학 (검색 · 기본 국민대)', searchWrap) : ctrl('집계 대상', h('span', { class: 'pill', html: '<i></i>현재 필터 모집단' })),
      ctrl(' ', resetBtn),
      h('span', { class: 'pill warn sim-beta', html: '<i></i>베타 · 가정 기반 — 재학 전개(L1) 3% 게이트 미달, 수입 델타는 검증됨(skill 0.46)' }),
    ]));

    // ── 파라미터 패널 + 결과 (파라미터 변경 시 결과만 debounce 재계산) ──
    var resultsBox = h('div', { class: 'sim-results' });
    v.appendChild(h('div', { class: 'sim-grid' }, [buildSimParamPanel(P, scheduleUpdate), resultsBox]));

    var deb = null;
    function scheduleUpdate() { clearTimeout(deb); deb = setTimeout(updateResults, 110); }
    function updateResults() {
      resultsBox.innerHTML = '';
      try {
        if (S.sim_mode === 'cohort') buildSimAggregate(resultsBox, P);
        else buildSimResults(resultsBox, sid, entry, P);
      } catch (e) {
        resultsBox.appendChild(h('div', { class: 'card' }, [h('h3', { text: '계산 오류' }), h('p', { class: 'hint', text: String((e && e.message) || e) })]));
      }
    }
    updateResults();
  }

  // ── 파라미터 패널 (설계 8장) ──
  function simRange(label, key, min, max, step, fmtFn, onChange, sub) {
    var val = S.sim_params[key];
    var input = h('input', { type: 'range', min: min, max: max, step: step, value: val, class: 'sim-slider' });
    var valLbl = h('span', { class: 'sim-val', text: fmtFn(val) });
    input.addEventListener('input', function () {
      var x = parseFloat(this.value);
      S.sim_params[key] = x; valLbl.textContent = fmtFn(x); onChange();
    });
    return h('div', { class: 'sim-field' }, [
      h('div', { class: 'sim-field-head' }, [h('label', { text: label }), valLbl]),
      input,
      sub ? h('div', { class: 'sim-hint', text: sub }) : null,
    ]);
  }
  function simChoice(label, key, opts, sub) {
    var row = h('div', { class: 'chip-row' });
    opts.forEach(function (o) {
      row.appendChild(h('button', { class: 'chip' + (S.sim_params[key] === o.v ? ' on' : ''), text: o.l, onClick: function () { S.sim_params[key] = o.v; render(); } }));
    });
    return h('div', { class: 'sim-field' }, [h('div', { class: 'sim-field-head' }, [h('label', { text: label })]), row, sub ? h('div', { class: 'sim-hint', text: sub }) : null]);
  }
  function buildSimParamPanel(P, onChange) {
    var panel = h('div', { class: 'card sim-params' });
    panel.appendChild(cardHead('simulation', 'var(--kmu)', '시나리오 파라미터', '설계 8장 · 변경 즉시 재계산'));
    var body = h('div', { class: 'sim-params-body' });

    body.appendChild(simRange('감축률 r', 'r', 0, 0.5, 0.01, function (x) { return F.pct(x, 0); }, onChange, '목표 입학정원 감축률 (0~50%)'));
    body.appendChild(simRange('감축 시작연도 t0', 't0', 2025, 2035, 1, function (x) { return String(x); }, onChange));
    body.appendChild(simRange('투영 기간', 'horizon', 5, 15, 1, function (x) { return x + '년'; }, onChange));
    body.appendChild(simChoice('감축 프로파일', 'profile', [{ v: 'immediate', l: '즉시' }, { v: 'linear', l: '선형 램프' }]));
    if (P.profile === 'linear') body.appendChild(simRange('램프 도달 연차', 'rampYears', 2, 10, 1, function (x) { return x + '년'; }, onChange));

    body.appendChild(h('div', { class: 'sim-sep' }));
    body.appendChild(simChoice('충원율 모드', 'fillMode', [{ v: 'realistic', l: '현실(수요앵커)' }, { v: 'conservative', l: '보수(비례감소)' }], '미충원 학교 손실 비대칭(설계 3장)'));
    if (P.fillMode === 'realistic') body.appendChild(simRange('충원 회복계수 β', 'beta', 0, 1, 0.05, function (x) { return x.toFixed(2); }, onChange, '0=고정 · 1=완전회복'));

    body.appendChild(h('div', { class: 'sim-sep' }));
    body.appendChild(simChoice('단가 상승 π', 'piMode', [{ v: 'freeze', l: '동결' }, { v: 'cap', l: '법정상한' }, { v: 'half', l: '상한½' }, { v: 'custom', l: '사용자' }], '등록금 인상 시나리오(설계 4.2)'));
    if (P.piMode === 'custom') body.appendChild(simRange('연 인상률', 'piRate', 0, 0.06, 0.005, function (x) { return F.pct(x, 1); }, onChange));

    body.appendChild(h('div', { class: 'sim-sep' }));
    body.appendChild(simRange('지출 연동 γ', 'gamma', 0, 1, 0.05, function (x) { return x.toFixed(2); }, onChange, '0=완전경직(수지 최악) · 1=완전연동'));
    body.appendChild(simRange('수강료 탄력 η(5120)', 'eta5120', 0, 0.5, 0.05, function (x) { return x.toFixed(2); }, onChange));
    body.appendChild(simRange('이탈률 스트레스', 'dropout', 0, 0.1, 0.01, function (x) { return F.pct(x, 0); }, onChange, '중도탈락 가중(설계 2.3)'));

    body.appendChild(h('div', { class: 'sim-sep' }));
    var lambdaOn = P.lambda > 0;
    var lamHead = h('div', { class: 'sim-field-head' }, [
      h('label', { text: '충원율 인구 드리프트 λ' }),
      h('button', { class: 'chip mini' + (lambdaOn ? ' on' : ''), text: lambdaOn ? 'ON' : 'OFF', onClick: function () { S.sim_params.lambda = lambdaOn ? 0 : 0.5; render(); } }),
    ]);
    var lamField = h('div', { class: 'sim-field' }, [lamHead]);
    if (lambdaOn) {
      var li = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: P.lambda, class: 'sim-slider' });
      var lv = h('span', { class: 'sim-val', text: P.lambda.toFixed(2) });
      li.addEventListener('input', function () { var x = parseFloat(this.value); S.sim_params.lambda = x; lv.textContent = x.toFixed(2); onChange(); });
      lamHead.appendChild(lv); lamField.appendChild(li);
    }
    lamField.appendChild(h('div', { class: 'sim-hint', text: '시도 18세 감소의 충원율 전가율(미충원 학교만 실효 · 기본 OFF)' }));
    body.appendChild(lamField);

    // 법인 추가지원 반영 토글 (폐교위험 판정 완충에만 작용, 설계 §7-4)
    body.appendChild(h('div', { class: 'sim-sep' }));
    var corpOn = !!P.useCorpSupport;
    body.appendChild(h('div', { class: 'sim-field' }, [
      h('div', { class: 'sim-field-head' }, [
        h('label', { text: '법인 추가지원 반영' }),
        h('button', { class: 'chip mini' + (corpOn ? ' on' : ''), text: corpOn ? 'ON' : 'OFF', onClick: function () { S.sim_params.useCorpSupport = !corpOn; render(); } }),
      ]),
      h('div', { class: 'sim-hint', text: '폐교위험 판정의 완충에 법인전입 여력(corp_capacity) 가산 · 기본 OFF(2024 단일연도 · 커버리지 60.5% · 폐교교 전부 결측이라 보수 산정).' }),
    ]));

    panel.appendChild(body);
    return panel;
  }

  // ── 결과 조립 (개별 대학) ──
  function buildSimResults(box, sid, entry, P) {
    var opts = simOpts(sid);
    var proj = ENG.project(entry, P, opts);
    var scen = ENG.scenarios(entry, P, opts);
    var years = scen.base.projection.years;
    var fy = S.sim_focus; if (fy == null || years.indexOf(fy) < 0) fy = years[years.length - 1];
    var fi = years.indexOf(fy);

    if (!proj.responsive) {
      box.appendChild(h('div', { class: 'card sim-note' }, [
        cardHead('simulation', 'var(--warning)', '학부 반응 세그먼트 없음', schools[sid].n + '은(는) 학부 정원내 수업료가 없어 정원 감축 델타=0'),
        h('p', { class: 'hint', text: '대학원대학 등은 학부 정원 감축 레버에 반응하지 않습니다(설계 1.5·2.5).' }),
      ]));
    }
    box.appendChild(simClosureCard(sid, entry, proj, P));
    box.appendChild(simFanCard(sid, scen, years));
    box.appendChild(simOpBalCard(sid, scen, years));
    box.appendChild(simKpiCard(scen, years, fy, fi));
    box.appendChild(simLaborCard(sid, entry, P, years, fi, opts));
    box.appendChild(simSegmentCard(entry, proj));
    box.appendChild(simAccuracyCard(sid, entry));
  }

  function simScenarioLegend(col) {
    return h('div', { class: 'legend' }, [
      h('span', { class: 'lg', html: '<i style="background:var(--good)"></i>낙관(손실 최소)' }),
      h('span', { class: 'lg', html: '<i style="background:' + C.resolveColor(col) + '"></i>기준' }),
      h('span', { class: 'lg', html: '<i style="background:var(--critical)"></i>비관(손실 최대)' }),
      h('span', { class: 'lg', html: '<i class="dash" style="color:var(--muted)"></i>무정책 기준' }),
    ]);
  }

  // 등록금수입(5110) 팬차트 — 3종 시나리오 + 잔차 밴드 + 무정책 기준선
  function simFanCard(sid, scen, years) {
    var col = schoolColor(sid);
    var optR = scen.optimistic.projection.rows, basR = scen.base.projection.rows, pesR = scen.pessimistic.projection.rows;
    var noPolicy = years.map(function (y, i) { return [y, basR[i].base5110]; });
    var optPts = years.map(function (y, i) { return [y, optR[i].lvl5110]; });
    var basPts = years.map(function (y, i) { return [y, basR[i].lvl5110]; });
    var pesPts = years.map(function (y, i) { return [y, pesR[i].lvl5110]; });
    // 백테스트 잔차 밴드(기준 시나리오, 학교 bt)
    var rb = ENG.residualBand(basR.map(function (r) { return r.lvl5110; }), simEntry(sid).bt, { field: 'mape_rev' });
    var band = null, bandNote;
    if (!rb.omitted) {
      band = { lo: years.map(function (y, i) { return [y, rb.lo[i]]; }), hi: years.map(function (y, i) { return [y, rb.hi[i]]; }), color: col };
      bandNote = ' · 잔차밴드 ±' + (rb.z * rb.sigma_rel * 100).toFixed(1) + '%(P10~P90)';
    } else {
      bandNote = ' · 잔차밴드 생략(백테스트 미검증 학교)';
    }
    var card = h('div', { class: 'card' }, [
      cardHead('cap', col, '등록금수입(5110) 시나리오 팬차트', '무정책 기준선 대비 낙관·기준·비관 3종' + bandNote),
    ]);
    var b = chartBox(320); card.appendChild(b);
    card.appendChild(simScenarioLegend(col));
    C.line(b, {
      height: 320, band: band, xTicks: years, yFmt: F.krwAxis, tipFmt: F.krw,
      series: [
        { name: '무정책 기준', color: 'var(--muted)', points: noPolicy, dashed: true, dim: true },
        { name: '낙관(손실 최소)', color: 'var(--good)', points: optPts },
        { name: '기준', color: col, points: basPts, emphasize: true, label: '기준' },
        { name: '비관(손실 최대)', color: 'var(--critical)', points: pesPts },
      ],
    });
    return card;
  }

  // 운영수지 추이 — 3종 시나리오 레벨 + 무정책 기준
  function simOpBalCard(sid, scen, years) {
    var col = schoolColor(sid);
    var optPts = years.map(function (y, i) { return [y, scen.optimistic.kpis[i].primed['운영수지']]; });
    var basPts = years.map(function (y, i) { return [y, scen.base.kpis[i].primed['운영수지']]; });
    var pesPts = years.map(function (y, i) { return [y, scen.pessimistic.kpis[i].primed['운영수지']]; });
    var orig = scen.base.kpis.length ? scen.base.kpis[0].original['운영수지'] : null;
    var origPts = years.map(function (y) { return [y, orig]; });
    var card = h('div', { class: 'card' }, [cardHead('scale', 'var(--series-2)', '운영수지 추이', '운영수입 − 운영지출 · 3종 시나리오 · 0선 = 흑자/적자 경계')]);
    var b = chartBox(300); card.appendChild(b);
    card.appendChild(simScenarioLegend(col));
    C.line(b, {
      height: 300, yZero: true, xTicks: years, yFmt: F.krwAxis, tipFmt: F.krw,
      series: [
        { name: '무정책 기준', color: 'var(--muted)', points: origPts, dashed: true, dim: true },
        { name: '낙관', color: 'var(--good)', points: optPts },
        { name: '기준', color: col, points: basPts, emphasize: true, label: '기준' },
        { name: '비관', color: 'var(--critical)', points: pesPts },
      ],
    });
    return card;
  }

  // KPI 델타 카드 (기준 시나리오 · 포커스 연도)
  function simKpiCard(scen, years, fy, fi) {
    var card = h('div', { class: 'card' });
    card.appendChild(cardHead('overview', 'var(--series-4)', '파급 KPI 델타 (기준 시나리오)', fy + '년 · 원값 → 시뮬값'));
    var chips = h('div', { class: 'chip-row yearchips' });
    years.forEach(function (y) {
      chips.appendChild(h('button', { class: 'chip yearchip' + (y === fy ? ' on' : ''), text: String(y), onClick: function () { S.sim_focus = y; render(); } }));
    });
    card.appendChild(chips);
    var kb = scen.base.kpis[fi];
    var grid = h('div', { class: 'sim-kpi-grid' });
    SIM_KPI_CARDS.forEach(function (name) {
      var meta = KPI_META[name]; if (!meta) return;
      var o = kb.original[name], p = kb.primed[name], d = kb.delta[name];
      if (o == null && p == null) return;
      var neu = d == null || Math.abs(d) < 1e-9;
      var dir = neu ? 'neu' : (((d > 0) === (meta.higher !== false)) ? 'good' : 'bad');
      var arrow = neu ? '→' : (d > 0 ? '▲' : '▼');
      grid.appendChild(h('div', { class: 'sim-kpi ' + dir }, [
        h('div', { class: 'sk-name', text: meta.label }),
        h('div', { class: 'sk-flow' }, [
          h('span', { class: 'sk-orig', text: F.byFmt(o, meta.fmt) }),
          h('span', { class: 'sk-arr', text: '→' }),
          h('span', { class: 'sk-new', text: F.byFmt(p, meta.fmt) }),
        ]),
        h('div', { class: 'sk-delta ' + dir }, [h('span', { class: 'sk-arrico', text: arrow }), h('span', { text: F.delta(d, meta.fmt) })]),
      ]));
    });
    card.appendChild(grid);
    return card;
  }

  // 인건비부담률 증폭 (설계 5.3): 운영수지 ε_L=0(경직) vs ε_L=0.3(조정)
  function simLaborCard(sid, entry, P, years, fi, opts) {
    var baseP = baseScenarioParams(P);
    function opBal(gL) {
      var p = {}; for (var k in baseP) p[k] = baseP[k]; p.gammaLabor = gL;
      var pr = ENG.project(entry, p, opts); var ks = ENG.recalcSeries(entry, pr, p, opts);
      return { pts: years.map(function (y, i) { return [y, ks[i].primed['운영수지']]; }), ks: ks };
    }
    var rigid = opBal(0), flex = opBal(0.3);
    var fy = years[fi];
    var kb = rigid.ks[fi];
    var o = kb.original['인건비부담률'], p = kb.primed['인건비부담률'];
    var jump = (o != null && p != null) ? (p - o) : null;
    var card = h('div', { class: 'card sim-labor' });
    card.appendChild(cardHead('users', 'var(--series-5)', '인건비부담률 증폭 (설계 5.3)', '수입 분모 축소 + 인건비 경직 → 비선형 급등'));
    card.appendChild(h('div', { class: 'sim-amp' }, [
      h('div', { class: 'amp-lab', text: '인건비부담률 · ' + fy + '년 · 인건비 완전경직(ε_L=0)' }),
      h('div', { class: 'amp-flow' }, [
        h('span', { class: 'amp-orig', text: F.pct(o) }),
        h('span', { class: 'amp-arr', text: '→' }),
        h('span', { class: 'amp-new' + (jump > 0 ? ' up' : '') , text: F.pct(p) }),
        jump != null ? h('span', { class: 'amp-jump' + (jump > 0 ? ' up' : '') , text: F.pctPoint(jump) }) : null,
      ]),
    ]));
    var b = chartBox(250); card.appendChild(b);
    card.appendChild(h('div', { class: 'legend' }, [
      h('span', { class: 'lg', html: '<i style="background:var(--critical)"></i>인건비 경직 ε_L=0 (최악)' }),
      h('span', { class: 'lg', html: '<i style="background:var(--series-2)"></i>인건비 조정 ε_L=0.3' }),
    ]));
    C.line(b, {
      height: 250, yZero: true, xTicks: years, yFmt: F.krwAxis, tipFmt: F.krw,
      series: [
        { name: 'ε_L=0 경직', color: 'var(--critical)', points: rigid.pts, emphasize: true },
        { name: 'ε_L=0.3 조정', color: 'var(--series-2)', points: flex.pts },
      ],
    });
    return card;
  }

  // 세그먼트 분해 φ_in/out/grad + 반응 가능 수입
  function simSegmentCard(entry, proj) {
    var base = entry.base || {};
    var c5112 = base.c5112 || 0;
    var pin = proj.meta.phi_in, pout = proj.meta.phi_out, pgr = proj.meta.phi_grad;
    var respRev = (pin != null) ? pin * c5112 : null;
    var rho = (entry.price && entry.price.rho_g) || 1.4;
    var card = h('div', { class: 'card' });
    card.appendChild(cardHead('data', 'var(--series-1)', '세그먼트 분해 — 반응 가능 수입', '수업료(5112)를 학부정원내·정원외·대학원으로 분해(ρ_g=' + rho + ' 가정)'));
    var b = chartBox(110); card.appendChild(b);
    C.bar(b, {
      height: 110, stacked: true, labelW: 92, valFmt: F.krw,
      items: [{ label: '수업료 5112', segs: [
        { name: '학부 정원내(반응)', value: (pin || 0) * c5112, color: 'var(--series-1)' },
        { name: '학부 정원외', value: (pout || 0) * c5112, color: 'var(--series-3)' },
        { name: '대학원', value: (pgr || 0) * c5112, color: 'var(--series-4)' },
      ] }],
    });
    card.appendChild(h('div', { class: 'sim-seg-call' }, [
      h('div', { class: 'ssc-big', text: F.pct(pin) }),
      h('div', { class: 'ssc-txt', html: '정원 감축에 <b>반응하는 수입 비중(φ_in)</b> · 반응 가능 등록금수입 ≈ <b>' + F.krw(respRev) + '</b>' }),
    ]));
    card.appendChild(h('p', { class: 'hint', text: '나머지(정원외·대학원·입학금·수강료)는 정원 감축과 무관하게 기준 경로 고정(설계 1.5·9장).' }));
    return card;
  }

  function simBtStat(l, val) { return h('div', { class: 'ssb-stat' }, [h('div', { class: 'ssb-v', text: val }), h('div', { class: 'ssb-l', text: l })]); }

  // 정확도 · 한계 패널 (정직 노출)
  function simAccuracyCard(sid, entry) {
    var card = h('div', { class: 'card sim-acc' });
    card.appendChild(cardHead('shield', 'var(--series-6)', '정확도 · 한계 (정직 노출)', '백테스트 게이트 결과를 숨기지 않고 그대로 표기'));
    var type = schools[sid].type;
    if (SIM_NOBT_TYPE[type]) {
      card.appendChild(h('div', { class: 'sim-warn-badge', html: '⚠ ' + type + ' — 백테스트 불가(자금계산서 종단 부재). 대학 백테스트 결과의 <b>외삽</b>으로만 정확도 간주(설계 9장 · D2 §5).' }));
    }
    var tbl = h('table', { class: 'data sim-bt-tbl' });
    tbl.appendChild(h('thead', {}, [h('tr', {}, [h('th', { text: '검증 층' }), h('th', { text: '결과(2021~24 · 수입가중)' }), h('th', { text: '목표' }), h('th', { text: '판정' })])]));
    var tb = h('tbody');
    SIM_BT_AGG.forEach(function (r) {
      tb.appendChild(h('tr', {}, [
        h('td', { text: r.k }), h('td', { text: r.v }), h('td', { text: r.tgt }),
        h('td', {}, [h('span', { class: 'bt-verdict ' + (r.pass ? 'pass' : 'fail'), text: r.pass ? '통과' : '미달' })]),
      ]));
    });
    tbl.appendChild(tb);
    card.appendChild(h('div', { class: 'tbl-wrap' }, [tbl]));
    card.appendChild(h('p', { class: 'hint', text: 'L1(재학 전개)만 3% 엄격기준을 0.64%p 미달 — 데이터 한계(학년축 부재)에 기인한 재학층 산포. 계통편향은 제거(MPE 0.42%)됐고 정책 델타의 종착 지표(수입 5110/5100)는 전 기준 합격.' }));

    if (entry.bt) {
      var bt = entry.bt;
      card.appendChild(h('div', { class: 'sim-schoolbt' }, [
        h('div', { class: 'ssb-title', text: schools[sid].n + ' 개별 백테스트' }),
        h('div', { class: 'ssb-grid' }, [
          simBtStat('재학 MAPE', F.pct(bt.mape_enroll)),
          simBtStat('수입 MAPE', F.pct(bt.mape_rev)),
          simBtStat('편향 MPE', F.pctPoint(bt.mpe)),
          simBtStat('skill', bt.skill != null ? bt.skill.toFixed(3) : '—'),
        ]),
      ]));
    } else if (!SIM_NOBT_TYPE[type]) {
      card.appendChild(h('p', { class: 'hint', text: schools[sid].n + '은(는) 백테스트 코호트 밖(폴백·종단 결측) — 개별 정확도 미검증, 대학 집계로 갈음.' }));
    }

    card.appendChild(h('div', { class: 'sim-limit-head', text: '모델 한계 (설계 9장)' }));
    var ul = h('ul', { class: 'sim-limits' });
    SIM_LIMITS.forEach(function (t) { ul.appendChild(h('li', { text: t })); });
    card.appendChild(ul);
    return card;
  }

  // ── C5: 코호트 집계 모드 (반응 학교 시나리오 레벨 합) ──
  function buildSimAggregate(box, P) {
    buildClosureAggPanel(box, P);   // C6 — 폐교위험 판정 (전국 344교 · §6 정보위계, 필터 무관)
    box.appendChild(h('div', { class: 'sim-sep-h', html: '<span>코호트 수입·수지 집계 (현재 필터 모집단)</span>' }));
    var pop = filteredSchoolIds().filter(function (sid) { return simEntry(sid); });
    var years = null, n = 0, respN = 0;
    var sOpt, sBas, sPes, sBase, oOpt, oBas, oPes, oOrig;
    pop.forEach(function (sid) {
      var e = simEntry(sid);
      var sc = ENG.scenarios(e, P, simOpts(sid));
      var yy = sc.base.projection.years;
      if (!years) {
        years = yy;
        sOpt = []; sBas = []; sPes = []; sBase = []; oOpt = []; oBas = []; oPes = []; oOrig = [];
        yy.forEach(function () { sOpt.push(0); sBas.push(0); sPes.push(0); sBase.push(0); oOpt.push(0); oBas.push(0); oPes.push(0); oOrig.push(0); });
      }
      if (sc.base.projection.responsive) respN++;
      n++;
      yy.forEach(function (y, i) {
        sOpt[i] += sc.optimistic.projection.rows[i].lvl5100;
        sBas[i] += sc.base.projection.rows[i].lvl5100;
        sPes[i] += sc.pessimistic.projection.rows[i].lvl5100;
        sBase[i] += sc.base.projection.rows[i].base5100;
        oOpt[i] += sc.optimistic.kpis[i].primed['운영수지'] || 0;
        oBas[i] += sc.base.kpis[i].primed['운영수지'] || 0;
        oPes[i] += sc.pessimistic.kpis[i].primed['운영수지'] || 0;
        oOrig[i] += sc.base.kpis[i].original['운영수지'] || 0;
      });
    });
    if (!years) { box.appendChild(h('div', { class: 'card' }, [h('p', { class: 'hint', text: '집계 대상 학교가 없습니다.' })])); return; }
    var col = 'var(--kmu)';
    function fanCard(title, sub, ic, iccol, opt, bas, pes, base, zero) {
      var c = h('div', { class: 'card' }, [cardHead(ic, iccol, title, sub)]);
      var b = chartBox(300); c.appendChild(b); c.appendChild(simScenarioLegend(col));
      C.line(b, {
        height: 300, yZero: !!zero, xTicks: years, yFmt: F.krwAxis, tipFmt: F.krw,
        series: [
          { name: '무정책 기준', color: 'var(--muted)', points: years.map(function (y, i) { return [y, base[i]]; }), dashed: true, dim: true },
          { name: '낙관', color: 'var(--good)', points: years.map(function (y, i) { return [y, opt[i]]; }) },
          { name: '기준', color: col, points: years.map(function (y, i) { return [y, bas[i]]; }), emphasize: true, label: '기준' },
          { name: '비관', color: 'var(--critical)', points: years.map(function (y, i) { return [y, pes[i]]; }) },
        ],
      });
      return c;
    }
    box.appendChild(fanCard('코호트 등록금수입(5100) 합계 — ' + n + '개교(' + respN + '개 반응)', '현재 필터 모집단 · 3종 시나리오 레벨 합', 'data', col, sOpt, sBas, sPes, sBase, false));
    box.appendChild(fanCard('코호트 운영수지 합계', '3종 시나리오 · 0선 = 흑자/적자 경계', 'scale', 'var(--series-2)', oOpt, oBas, oPes, oOrig, true));
    box.appendChild(h('div', { class: 'card sim-acc' }, [
      cardHead('shield', 'var(--series-6)', '집계 모드 주의', '개별 KPI·세그먼트·백테스트는 대학 선택 모드에서 확인'),
      h('p', { class: 'hint', text: '집계는 반응 세그먼트 보유 학교의 시나리오 레벨 합입니다. 백테스트는 대학 145교 기준(전문대·사이버·대학원대 종단 부재로 검증 불가, 설계 9장·D2 §5).' }),
    ]));
  }

  // ═══════════════════════════════════════════════════════
  //  C6 — 폐교(존속) 위험 판정 레이어 (설계 §6 정보위계)
  //  SIM.closureGrade / closureAggregate 바인딩. 등급 색 = --good/--warning/
  //  --serious/--critical + neutral (KMU Blue 미사용). D6 합격 전 베타.
  // ═══════════════════════════════════════════════════════
  var CLOSURE_GRADES = {
    stable:   { label: '안정',   tone: 'stable',   color: 'var(--good)',     desc: '흑자 또는 완충 충분 · 충원율 견고' },
    caution:  { label: '주의',   tone: 'caution',  color: 'var(--warning)',  desc: '적자여도 완충 장기 / 완충 부재 흑자' },
    atrisk:   { label: '위험',   tone: 'atrisk',   color: 'var(--serious)',  desc: '존속위험 — 완충 2~5년 내 소진권' },
    critical: { label: '심각',   tone: 'critical', color: 'var(--critical)', desc: '존속위기 — 폐교 직전 재무지문' },
    unrated:  { label: '미분류', tone: 'unrated',  color: 'var(--muted)',    desc: '학부미보유·대학원대·데이터부재' },
  };
  var CLOSURE_STACK_ORDER = ['stable', 'caution', 'atrisk', 'critical', 'unrated'];
  var CLOSURE_DRIVERS = { severe: '심각적자', deficit: '운영적자', no_buffer: '완충소진', liquidity: '유동성부족', low_fill: '충원율저조' };
  var CLOSURE_REGION_ORDER = ['수도권', '광역권', '지방권'];
  var CLOSURE_SCALE_ORDER = ['대규모', '중규모', '소규모'];

  function gradeChip(grade, extra) {
    var g = CLOSURE_GRADES[grade] || CLOSURE_GRADES.unrated;
    return h('span', { class: 'grade-chip g-' + g.tone, text: g.label + (extra || '') });
  }
  function fmtRunway(y) {
    if (y == null) return '—';
    if (y === Infinity || !isFinite(y)) return '소진 없음(흑자)';
    return (y < 0 ? 0 : y).toFixed(1) + '년';
  }
  function verifiedPill() { return h('span', { class: 'pill ok sim-beta-inline', html: '<i></i>역검증 합격 · closure_validation_report' }); }
  function cloStat(l, v) { return h('div', { class: 'clo-stat' }, [h('div', { class: 'cs-v', text: v }), h('div', { class: 'cs-l', text: l })]); }
  function closureLegend() {
    return h('div', { class: 'legend clo-legend' }, CLOSURE_STACK_ORDER.map(function (k) {
      return h('span', { class: 'lg', html: '<i style="background:' + C.resolveColor(CLOSURE_GRADES[k].color) + '"></i>' + CLOSURE_GRADES[k].label });
    }));
  }

  // ── 개별 대학 등급 카드 (설계 §6 학교별 모드) ──
  function simClosureCard(sid, entry, proj, P) {
    var opts = { meta: SIMD.meta, sido: schools[sid].sido, type: schools[sid].type, useCorpSupport: !!P.useCorpSupport };
    var cg = ENG.closureGrade(entry, proj, opts);
    var g = CLOSURE_GRADES[cg.grade];
    var card = h('div', { class: 'card sim-closure' });
    card.appendChild(cardHead('crisis', g.color, '폐교(존속) 위험 판정', schools[sid].n + ' · 현재 시나리오 기준'));
    card.appendChild(verifiedPill());
    card.appendChild(h('div', { class: 'clo-banner g-' + g.tone }, [
      h('div', { class: 'clo-grade-big', text: g.label }),
      h('div', { class: 'clo-grade-desc', text: g.desc }),
      cg.boundaryFlag ? h('div', { class: 'clo-band', text: '경계 등급(근소): ' + CLOSURE_GRADES[cg.gradeRange[0]].label + ' ~ ' + CLOSURE_GRADES[cg.gradeRange[1]].label }) : null,
    ]));
    card.appendChild(h('div', { class: 'clo-stats' }, [
      cloStat('완충 소진 여력 (runway)', fmtRunway(cg.runwayYears)),
      cloStat('소진 예상연도', cg.depletionYear != null ? cg.depletionYear + '년' : '해당 없음'),
      cloStat('정착 운영수지율 M', cg.marginEnd != null ? F.pct(cg.marginEnd) : '—'),
      cloStat('신입생 충원율', cg.fill != null ? F.pct(cg.fill) : '—'),
      cloStat('적립금 소진월수', cg.reserveMonths != null ? cg.reserveMonths.toFixed(1) + '개월' : '—'),
      cloStat('가용 적립금', F.krw(cg.buffer0)),
    ]));
    if (cg.drivers && cg.drivers.length) {
      var dr = h('div', { class: 'clo-drivers' }, [h('span', { class: 'clo-dr-lab', text: '판정 근거 게이트' })]);
      cg.drivers.forEach(function (d) { dr.appendChild(h('span', { class: 'clo-dr-chip', text: CLOSURE_DRIVERS[d] || d })); });
      card.appendChild(dr);
    }
    card.appendChild(h('p', { class: 'hint', text: '존속성(운영수지 M)·완충(적립금 소진 runway) 두 축 게이트 매트릭스 판정(설계 §2). 재정 존속위험이며 폐교 확정이 아닙니다.' }));
    return card;
  }

  // ── 전 학교 등급 재계산(학교별 배지 테이블용, 현재 시나리오) ──
  function perSchoolClosure(P) {
    var out = [], bs = SIMD.bySchool;
    Object.keys(bs).forEach(function (idx) {
      var i = +idx, e = bs[idx], sm = schools[i] || {};
      var o = { meta: SIMD.meta, sido: sm.sido, type: sm.type, useCorpSupport: !!P.useCorpSupport };
      out.push({ idx: i, name: sm.n, cg: ENG.closureGrade(e, ENG.project(e, P, o), o) });
    });
    return out;
  }

  // ── 등급 분포 스택바(단일/그룹 공용) ──
  function closureStackCard(icon, iccol, title, sub, groupAgg, order) {
    var card = h('div', { class: 'card sim-closure' });
    card.appendChild(cardHead(icon, iccol, title, sub));
    var keys = order.filter(function (k) { return groupAgg[k] && groupAgg[k].total > 0; });
    var single = keys.length === 1 && keys[0] === 'all';
    var hgt = keys.length * 42 + 44;
    var b = chartBox(hgt); card.appendChild(b);
    C.bar(b, {
      height: hgt, stacked: true, labelW: single ? 12 : 92, rowH: 42, maxBar: 24,
      valFmt: function (v) { return Math.round(v) + '교'; },
      items: keys.map(function (kk) {
        var gr = groupAgg[kk];
        return { label: single ? '' : kk, emphasize: false, segs: CLOSURE_STACK_ORDER.map(function (g) { return { name: CLOSURE_GRADES[g].label, value: gr[g], color: CLOSURE_GRADES[g].color }; }) };
      }),
    });
    card.appendChild(closureLegend());
    return card;
  }

  // ── 학교별 배지 테이블 (등급순, 상위 N + 더보기) ──
  function closureSchoolTable(P) {
    var rows = perSchoolClosure(P).filter(function (r) { return r.cg.grade !== 'unrated'; });
    var RANK = ENG._util.GRADE_RANK;
    rows.sort(function (a, b) {
      var d = RANK[b.cg.grade] - RANK[a.cg.grade];
      if (d) return d;
      var ra = (a.cg.runwayYears == null || !isFinite(a.cg.runwayYears)) ? Infinity : a.cg.runwayYears;
      var rb = (b.cg.runwayYears == null || !isFinite(b.cg.runwayYears)) ? Infinity : b.cg.runwayYears;
      return ra - rb;
    });
    var LIMIT = 15, showAll = S.sim_closure_all;
    var shown = showAll ? rows : rows.slice(0, LIMIT);
    var card = h('div', { class: 'card sim-closure' });
    card.appendChild(cardHead('data', 'var(--series-1)', '학교별 판정 (위험도순)', rows.length + '개교 · 미분류 제외 · 위험도 높은 순'));
    var tbl = h('table', { class: 'data' });
    tbl.appendChild(h('thead', {}, [h('tr', {}, ['대학', '등급', '소진예상', 'M(운영수지율)', '충원율', '근거 게이트'].map(function (t) { return h('th', { text: t }); }))]));
    var tb = h('tbody');
    shown.forEach(function (r) {
      var cg = r.cg;
      tb.appendChild(h('tr', { class: r.idx === KMU_ID ? 'kmu-row' : null }, [
        h('td', { text: r.name + (r.idx === KMU_ID ? ' ★' : '') }),
        h('td', {}, [gradeChip(cg.grade)]),
        h('td', { text: cg.depletionYear != null ? cg.depletionYear + '년' : '—' }),
        h('td', { text: cg.marginEnd != null ? F.pct(cg.marginEnd) : '—' }),
        h('td', { text: cg.fill != null ? F.pct(cg.fill) : '—' }),
        h('td', { text: (cg.drivers || []).map(function (d) { return CLOSURE_DRIVERS[d] || d; }).join(', ') || '—' }),
      ]));
    });
    tbl.appendChild(tb);
    card.appendChild(h('div', { class: 'tbl-wrap' }, [tbl]));
    if (rows.length > LIMIT) {
      card.appendChild(h('button', { class: 'chip clo-table-more', text: showAll ? '접기' : '더보기 (+' + (rows.length - LIMIT) + '개교)', onClick: function () { S.sim_closure_all = !showAll; render(); } }));
    }
    return card;
  }

  // ── 검증 참조 + 정직성 푸터 (설계 §6-6·§6-7·§7) ──
  function closureHonestyCard() {
    var card = h('div', { class: 'card sim-closure sim-acc' });
    card.appendChild(cardHead('shield', 'var(--series-6)', '검증 참조 · 정직성 고지', '판정의 근거와 한계를 숨기지 않고 표기'));
    card.appendChild(h('div', { class: 'clo-vf-badge', html: '실제 폐교 <b>5/5 위험+ 판정</b> (역검증 합격 — closure_validation_report). 관측 스냅샷 · look-ahead 없음 · 민감도 5/5 · 건전교 오탐 0 · LOO 강건성 통과 · AUC 0.976. 국민대 안정(기존 위기스코어 55.8 "주의" 오분류 교정).' }));
    card.appendChild(h('p', { class: 'hint', text: '기준선: closure_traj 폐교 −1년 신입생 충원율 중앙값 0.28. D6 역검증(혼동행렬·특이도·lead-time·LOO) 합격 — 상세는 build/closure_validation_report.md.' }));
    card.appendChild(h('div', { class: 'sim-limit-head', text: '정직성 고지 (설계 §7)' }));
    var ul = h('ul', { class: 'sim-limits clo-honesty' });
    ['이 판정은 재정 존속위험이며 폐교 확정이 아닙니다 — 폐교는 비리·분규·법인구제 등 재정 외 요인이 개입합니다.',
     '비리·분규·법인 추가지원은 미반영(법인지원은 선택 토글 · 데이터 커버리지 60.5%, 폐교교 전부 결측).',
     '전문대·사이버·대학원대는 시나리오 투영 미검증 — 관측 스톡 기반 등급만 유효(투영은 베타).',
     '표본 폐교대학 N=4~6 — 통계적 증명이 아닌 임계값 보정·정합성 점검으로 해석해야 합니다.'].forEach(function (t) { ul.appendChild(h('li', { text: t })); });
    card.appendChild(ul);
    return card;
  }

  // ── 집계 판정 패널 (설계 §6 정보위계 7항목) ──
  function buildClosureAggPanel(box, P) {
    var agg = ENG.closureAggregate(SIMD, P, { meta: SIMD.meta, schools: schools, useCorpSupport: !!P.useCorpSupport });
    var total = 0; CLOSURE_STACK_ORDER.forEach(function (k) { total += agg.counts[k]; });
    var N = agg.atRiskOrWorse, rng = agg.atRiskRange, tr = agg.transitions;

    // 1) 헤드라인
    var head = h('div', { class: 'card sim-closure clo-headline' });
    head.appendChild(cardHead('crisis', 'var(--serious)', '폐교(존속) 위험 판정 — 전국 ' + total + '개교', '이 조건이 이어질 경우의 재정 존속위험 · 필터 무관 전국 기준'));
    head.appendChild(verifiedPill());
    head.appendChild(h('div', { class: 'clo-hero' }, [
      h('div', { class: 'clo-hero-num' }, [h('span', { class: 'chn-n', text: String(N) }), h('span', { class: 'chn-u', text: '개교' })]),
      h('div', { class: 'clo-hero-side' }, [
        h('div', { class: 'clo-hero-lab', text: '폐교위험 = 위험 + 심각' }),
        h('div', { class: 'clo-hero-badges' }, [
          h('span', { class: 'grade-chip g-critical', text: '심각 ' + agg.counts.critical }),
          h('span', { class: 'grade-chip g-atrisk', text: '위험 ' + agg.counts.atrisk }),
        ]),
        h('div', { class: 'clo-hero-range', text: '경계밴드 범위 ' + rng[0] + '~' + rng[1] + '개교' }),
        (P.r > 0)
          ? h('div', { class: 'clo-hero-delta' + (tr.newAtRisk > 0 ? ' up' : '') }, [h('span', { text: '기준(감축 0%) 대비 ' + (tr.newAtRisk > 0 ? '+' + tr.newAtRisk : '±0') + '개교 신규 진입 · 등급 하락 ' + tr.downgraded + '개교' })])
          : h('div', { class: 'clo-hero-delta', text: '현재 = 기준 시나리오(감축 0%)' }),
      ]),
    ]));
    box.appendChild(head);

    // 2) 등급 분포 스택바(344교)
    box.appendChild(closureStackCard('overview', 'var(--kmu)', '등급 분포', total + '개교 · 슬라이더 연동 실시간', { all: mkBucket(agg.counts) }, ['all']));

    // 3) 전이 표시
    if (P.r > 0) {
      var trCard = h('div', { class: 'card sim-closure clo-transition' });
      trCard.appendChild(cardHead('outlook', 'var(--series-4)', '기준(감축 0%) 대비 전이', '감축 시나리오가 등급을 얼마나 끌어내리는가'));
      trCard.appendChild(h('div', { class: 'clo-tr-row' }, [
        cloStat('등급 하락 개교', String(tr.downgraded)),
        cloStat('신규 폐교위험 진입', String(tr.newAtRisk)),
      ]));
      box.appendChild(trCard);
    }

    // 4) 권역×등급 · 규모×등급 분포
    box.appendChild(closureStackCard('compare', 'var(--series-2)', '권역 × 등급 분포', '지방권 집중도 가시화', agg.byRegion, CLOSURE_REGION_ORDER));
    box.appendChild(closureStackCard('scale', 'var(--series-3)', '규모 × 등급 분포', '소규모 집중도 가시화', agg.byScale, CLOSURE_SCALE_ORDER));

    // 5) 학교별 배지 테이블
    box.appendChild(closureSchoolTable(P));

    // 6·7) 검증 참조 + 정직성 푸터
    box.appendChild(closureHonestyCard());
  }
  // counts → bucket(스택바 공용 포맷)
  function mkBucket(counts) {
    var b = { stable: 0, caution: 0, atrisk: 0, critical: 0, unrated: 0, total: 0 };
    CLOSURE_STACK_ORDER.forEach(function (k) { b[k] = counts[k] || 0; b.total += b[k]; });
    return b;
  }

  // ═══════════════════════════════════════════════════════
  //  탭 5 — 데이터·검증
  // ═══════════════════════════════════════════════════════
  function renderData(v) {
    var val = DATA.validation, sum = val.summary;
    // 검증 카드
    var cards = h('div', { class: 'stat-cards' });
    [['I1', '자금수입총계 = 자금지출총계'], ['I2', '당기 전기이월 = 전기 차기이월'], ['I3', '관 합계 = 수입/지출 총계']].forEach(function (pair) {
      var key = pair[0], s = sum[key] || { pass: 0, fail: 0 };
      var na = s.na;
      var tot = s.pass + s.fail;
      var rate = tot ? s.pass / tot : 0;
      var pill = na
        ? h('span', { class: 'pill rank', text: 'N/A' })
        : h('span', { class: 'pill ' + (s.fail === 0 ? 'ok' : 'warn') }, [h('i'), h('span', { text: s.fail === 0 ? '전건 통과' : '위반 ' + s.fail + '건' })]);
      var mini = h('div', { class: 'stat-mini ' + (na ? '' : (s.fail === 0 ? 'ok' : 'warn')) }, [
        h('div', { class: 'stat-head' }, [h('span', { class: 'lab', text: key }), pill]),
        h('div', { class: 'card-sub', style: 'margin:0', text: pair[1] }),
        na ? h('div', { class: 'big na', text: '적용 불가' }) : h('div', { class: 'big', text: s.pass + '/' + tot }),
        na ? h('div', { class: 'na', text: '재무상태표 항목 부재' }) : h('div', { class: 'rate', text: '통과율 ' + F.pct(rate, 1) + (s.fail ? ' · 위반 ' + s.fail + '건' : '') }),
      ]);
      cards.appendChild(mini);
    });
    v.appendChild(h('div', { class: 'card' }, [h('h3', { text: '항등식 검증 (특례규칙 제15~20조)' }), h('div', { class: 'card-sub', text: '허용오차 1천원' }), cards]));
    v.appendChild(h('div', { class: 'spacer-v' }));

    // 위반 상위 테이블
    if (val.top && val.top.length) {
      var tbl = h('table', { class: 'data' });
      tbl.appendChild(h('thead', {}, [h('tr', {}, ['규칙', '연도', '대학', '좌변', '우변', '차이'].map(function (t) { return h('th', { text: t }); }))]));
      var tb = h('tbody');
      val.top.forEach(function (r) {
        tb.appendChild(h('tr', {}, [
          h('td', { text: r.rule }), h('td', { text: r.year }), h('td', { text: r.school }),
          h('td', { text: F.krw(r.lhs) }), h('td', { text: F.krw(r.rhs) }),
          h('td', { text: F.krw(r.diff), style: 'color:var(--critical)' }),
        ]));
      });
      tbl.appendChild(tb);
      v.appendChild(h('div', { class: 'card' }, [h('h3', { text: '위반 상위 (차이 절댓값 순)' }), h('div', { class: 'tbl-wrap' }, [tbl])]));
    } else {
      v.appendChild(h('div', { class: 'card' }, [h('h3', { text: '위반 상위' }), h('p', { class: 'hint', text: '검출된 위반이 없습니다.' })]));
    }
    v.appendChild(h('div', { class: 'spacer-v' }));

    // 산식·출처 노트
    var notes = h('dl', { class: 'note-list' });
    KPI_KEYS.forEach(function (k) { notes.appendChild(h('dt', { text: KPI_META[k].label })); notes.appendChild(h('dd', { html: '<code>' + KPI_META[k].desc + '</code>' })); });
    notes.appendChild(h('dt', { text: '출처' }));
    notes.appendChild(h('dd', { text: '사학기관 재무·회계 규칙에 대한 특례규칙 별표 1, 한국사학진흥재단 대학재정분석 지표. 단위: ' + DATA.meta.unit + '.' }));
    v.appendChild(h('div', { class: 'card' }, [h('h3', { text: '산식 · 법령 출처' }), notes]));
    v.appendChild(h('div', { class: 'spacer-v' }));

    // 원데이터 탐색
    var schoolSel = h('select', { class: 'sel', onChange: function () { S.t5_school = +this.value; render(); } },
      schools.map(function (s, i) { return h('option', { value: i, selected: i === S.t5_school ? 'selected' : null, text: s.n }); }));
    var yearSel = h('select', { class: 'sel', onChange: function () { S.t5_year = +this.value; render(); } },
      YEARS.map(function (y) { return h('option', { value: y, selected: y === S.t5_year ? 'selected' : null, text: y + '년' }); }));
    var sideSel = h('select', { class: 'sel', onChange: function () { S.t5_side = this.value; render(); } }, [
      h('option', { value: 'in', selected: S.t5_side === 'in' ? 'selected' : null, text: '수입' }),
      h('option', { value: 'ex', selected: S.t5_side === 'ex' ? 'selected' : null, text: '지출' }),
    ]);
    var dlBtn = h('button', { class: 'btn-primary', text: '현재 필터 CSV 다운로드', onClick: downloadCSV });
    var explCard = h('div', { class: 'card' }, [
      h('h3', { text: '원데이터 탐색' }),
      h('div', { class: 'card-sub', text: '대학 × 연도 × 계정' }),
      h('div', { class: 'row-controls' }, [ctrl('대학', schoolSel), ctrl('연도', yearSel), ctrl('구분', sideSel), h('div', { class: 'ctrl' }, [h('label', { text: ' ' }), dlBtn])]),
    ]);
    var etbl = h('table', { class: 'data' });
    etbl.appendChild(h('thead', {}, [h('tr', {}, ['코드', '계정', 'Lv', '금액'].map(function (t) { return h('th', { text: t }); }))]));
    var etb = h('tbody');
    DATA.accounts[S.t5_side].forEach(function (a) {
      if (LITE && a.lv === 3) return;
      var val2 = gv(S.t5_side, a.code, S.t5_school, S.t5_year);
      etb.appendChild(h('tr', { class: a.lv <= 1 ? '' : '' }, [
        h('td', { text: a.code, style: 'font-variant-numeric:tabular-nums;color:var(--muted)' }),
        h('td', { text: a.name, style: 'padding-left:' + (10 + a.lv * 12) + 'px' }),
        h('td', { text: a.lv }),
        h('td', { text: val2 == null ? '—' : F.krw(val2) }),
      ]));
    });
    etbl.appendChild(etb);
    explCard.appendChild(h('div', { class: 'tbl-wrap' }, [etbl]));
    v.appendChild(explCard);
  }

  function downloadCSV() {
    var pop = filteredSchoolIds();
    var lines = ['대학,연도,구분,코드,계정,Lv,금액(천원)'];
    pop.forEach(function (sid) {
      YEARS.filter(function (y) { return y >= S.y0 && y <= S.y1; }).forEach(function (y) {
        ['in', 'ex'].forEach(function (side) {
          DATA.accounts[side].forEach(function (a) {
            if (LITE && a.lv === 3) return;
            var val = gv(side, a.code, sid, y);
            if (val == null) return;
            lines.push([csvCell(schools[sid].n), y, side === 'in' ? '수입' : '지출', csvCell(a.code), csvCell(a.name), a.lv, val].join(','));
          });
        });
      });
    });
    var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = '교비회계_수지_' + S.y0 + '-' + S.y1 + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function csvCell(s) { s = String(s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  // ═══════════════════════════════════════════════════════
  //  테마 토글
  // ═══════════════════════════════════════════════════════
  function initTheme() {
    document.getElementById('themeToggle').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : (cur === 'light' ? 'dark' : (matchDark() ? 'light' : 'dark'));
      document.documentElement.setAttribute('data-theme', next);
      // CSS 변수 기반이라 재렌더 불필요하나 SVG resolveColor 툴팁 대비 강제 재계산
      if (C.redrawAll) C.redrawAll();
    });
  }
  function matchDark() { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }

  // ═══════════════════════════════════════════════════════
  //  셸(사이드바) — 드로어 · 접기 · 필터 초기화
  // ═══════════════════════════════════════════════════════
  function closeDrawer() { document.body.classList.remove('drawer-open'); }
  function initShell() {
    var drawerToggle = document.getElementById('drawerToggle');
    if (drawerToggle) drawerToggle.addEventListener('click', function () { document.body.classList.toggle('drawer-open'); });
    var scrim = document.getElementById('scrim');
    if (scrim) scrim.addEventListener('click', closeDrawer);
    var collapseBtn = document.getElementById('collapseBtn');
    if (collapseBtn) collapseBtn.addEventListener('click', function () {
      document.body.classList.toggle('collapsed');
      collapseBtn.textContent = document.body.classList.contains('collapsed') ? '»' : '«';
      if (C.redrawAll) setTimeout(C.redrawAll, 230);
    });
    var resetBtn = document.getElementById('resetBtn');
    if (resetBtn) resetBtn.addEventListener('click', function () {
      S.cohort = 'all';
      S.regions = new Set(regionsAll); S.scales = new Set(scalesAll); S.types = new Set(typesAll);
      S.y0 = Y_FIRST; S.y1 = Y_LAST;
      refresh();
    });
    var csvBtnTop = document.getElementById('csvBtnTop');
    if (csvBtnTop) csvBtnTop.addEventListener('click', downloadCSV);
    initGlobalSearch();
  }

  // 전역 대학 검색 (사이드바) → 선택 시 대학 비교 탭에 추가
  function initGlobalSearch() {
    var input = document.getElementById('globalSearch');
    if (!input) return;
    var wrap = input.closest('.sidebar-search');
    var drop = h('div', { class: 'global-drop' });
    drop.style.display = 'none';
    wrap.appendChild(drop);
    var hits = [], active = -1;
    function candidates(q) {
      var out = [];
      filteredSchoolIds().forEach(function (sid) {
        if (sid === KMU_ID) return;
        if (q && schools[sid].n.indexOf(q) < 0) return;
        out.push(sid);
      });
      return out.slice(0, 12);
    }
    function pick(sid) {
      if (S.t4_schools.indexOf(sid) < 0) {
        if (S.t4_schools.length >= 8) { alert('국민대 포함 최대 8개'); return; }
        S.t4_schools.push(sid);
      }
      input.value = ''; drop.style.display = 'none';
      S.tab = 'compare'; closeDrawer(); render();
    }
    function draw() {
      drop.innerHTML = '';
      drop.style.display = 'block';
      if (!hits.length) {
        drop.appendChild(h('div', { class: 'gd-empty', text: input.value.trim() ? '일치하는 대학이 없습니다' : '대학명을 입력하면 비교 목록에 추가됩니다' }));
        return;
      }
      hits.forEach(function (sid, i) {
        var opt = h('div', { class: 'gd-opt' + (i === active ? ' active' : ''), html:
          '<i style="background:' + C.resolveColor(schoolColor(sid)) + '"></i><span>' + schools[sid].n + '</span><span class="gd-region">' + schools[sid].region + '</span>' });
        opt.addEventListener('mousedown', function (e) { e.preventDefault(); pick(sid); });
        opt.addEventListener('mouseenter', function () { active = i; draw(); });
        drop.appendChild(opt);
      });
    }
    function refreshHits() { hits = candidates(input.value.trim()); active = hits.length ? 0 : -1; draw(); }
    input.addEventListener('input', refreshHits);
    input.addEventListener('focus', refreshHits);
    input.addEventListener('blur', function () { setTimeout(function () { drop.style.display = 'none'; }, 160); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (hits.length) { active = (active + 1) % hits.length; draw(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (hits.length) { active = (active - 1 + hits.length) % hits.length; draw(); } }
      else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0 && hits[active] != null) pick(hits[active]); }
      else if (e.key === 'Escape') { drop.style.display = 'none'; }
    });
  }

  // ═══════════════════════════════════════════════════════
  //  셀프테스트 (?selftest=1)
  // ═══════════════════════════════════════════════════════
  function runSelftest() {
    var results = [], ok = true;
    function check(name, cond) { results.push((cond ? '✓ ' : '✗ ') + name); if (!cond) ok = false; console.assert(cond, name); }

    // 1) 국민대 KPI 3종 == JSON 원값(재계산 근사 일치)
    var yr = Y_LAST;
    var dep = gv('in', '5100', KMU_ID, yr) / gv('in', 'T_IN', KMU_ID, yr);
    check('등록금의존율_총계 재계산 일치', Math.abs(dep - kv('등록금의존율_총계', KMU_ID, yr)) < 1e-3);
    var laborNum = gv('ex', '4100', KMU_ID, yr), reg = gv('in', '5100', KMU_ID, yr);
    check('인건비부담률 재계산 일치', Math.abs(laborNum / reg - kv('인건비부담률', KMU_ID, yr)) < 1e-3);
    var opBal = gv('in', 'OP_IN', KMU_ID, yr) - gv('ex', 'OP_EX', KMU_ID, yr);
    check('운영수지 재계산 일치', Math.abs(opBal - kv('운영수지', KMU_ID, yr)) < Math.abs(opBal) * 1e-3 + 1);

    // 2) ext 로드 · 배열 길이(rows 정렬)
    check('ext 로드 · series/kpi2 배열 길이 = rows 길이', HAS_EXT &&
      EXT.series['적립금총액'].length === rows.length && EXT.kpi2['위기스코어'].length === rows.length &&
      EXT.population && EXT.population.age18_21.length === EXT.population.sidos.length && EXT.region_outlook.length > 0);

    // 3) 각 탭 렌더 후 SVG 노드 > 0 (위기 진단·구조 전망 포함)
    ['overview', 'structure', 'timeseries', 'compare', 'crisis', 'outlook', 'simulation', 'data'].forEach(function (t) {
      S.tab = t; render();
      var n = document.querySelectorAll('#view svg').length;
      check('탭 ' + t + ' SVG 렌더(' + n + ')', t === 'data' ? true : n > 0);
    });

    // 4) 구조 탭 — 계정 선택 시 분석 패널 렌더 (래더에 운영지출 대비 표기)
    S.tab = 'structure'; S.t2_school = KMU_ID; S.t2_year = Y_LAST; S.t2_sel = { side: 'ex', code: '4100' }; render();
    var panel = document.getElementById('t2-panel');
    check('구조 탭 계정 선택 시 분석 패널 렌더',
      !!panel && panel.querySelectorAll('svg').length > 0 && panel.textContent.indexOf('운영지출 대비') >= 0);

    // 5) 연도 칩 전환 동작 (활성 칩 = 선택 연도)
    var altYear = YEARS[YEARS.length - 2];
    S.t2_year = altYear; render();
    var onChip = document.querySelector('.yearchip.on');
    check('연도 칩 전환 동작', !!onChip && onChip.textContent.indexOf(String(altYear)) >= 0);

    // 6) 홈 랜딩 — 히어로 + 메뉴 카드 7개 + 카드 클릭 시 해당 탭 이동
    S.tab = 'home'; render();
    var heroOk = !!document.querySelector('#view .home-hero');
    var homeCards = document.querySelectorAll('#view .home-card');
    var firstCard = homeCards[0];
    if (firstCard) firstCard.click();               // 첫 카드(개요) → overview 탭 전환
    check('홈 랜딩 렌더 + 메뉴 카드 내비게이션',
      heroOk && homeCards.length === 9 && !!firstCard && S.tab === 'overview' &&
      document.querySelectorAll('#view svg').length > 0);

    // 7) F.eok 억원 포맷 단위 테스트 (천원 → "1,234.5억원")
    check('F.eok 억원 포맷', F.eok(345670000) === '3,456.7억원' && F.eok(-12345) === '-0.1억원' && F.eok(null) === '—');

    // 8) 수지 구조 트리 — 관항목 숫자 코드 배지 존재 + 4자리 코드 표기
    S.tab = 'structure'; S.t2_school = KMU_ID; S.t2_year = Y_LAST; S.t2_open.add('ex:4100'); render();
    var badges = document.querySelectorAll('#view .tcode');
    check('트리 코드 배지 렌더 + 코드 표기', badges.length > 0 && /^\d{3,4}$/.test((badges[0].textContent || '').trim()));
    S.t2_open.delete('ex:4100');

    // 8-b) 수지 구조 대학 검색 선택 시 트리 데이터 갱신 (회귀 방지)
    //   - mouseenter가 옵션 DOM을 재생성하지 않아야(detach되면 실제 클릭에서 mousedown 유실)
    //   - 선택 후 S.t2_school 전환 + 트리 헤더가 새 대학명으로 갱신
    S.tab = 'structure'; S.t2_school = KMU_ID; S.t2_year = Y_LAST; render();
    var beforeSub = (document.querySelector('#view .t2-treehead .th-sub') || {}).textContent || '';
    var ssInput = document.querySelector('#view .school-search input');
    var otherIdx = -1; for (var _i = 0; _i < schools.length; _i++) { if (_i !== KMU_ID) { otherIdx = _i; break; } }
    var switchOk = false, stayConnected = false;
    if (ssInput && otherIdx >= 0) {
      ssInput.value = schools[otherIdx].n;
      ssInput.dispatchEvent(new Event('input', { bubbles: true }));
      var opt0 = document.querySelector('#view .school-search .ss-opt');
      if (opt0) {
        opt0.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        stayConnected = opt0.isConnected;              // fix 전: draw() 재생성으로 false
        opt0.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        var afterSub = (document.querySelector('#view .t2-treehead .th-sub') || {}).textContent || '';
        switchOk = S.t2_school !== KMU_ID && afterSub.indexOf(schools[S.t2_school].n) >= 0 && afterSub !== beforeSub;
      }
    }
    check('수지 구조 대학 검색 선택 시 트리 데이터 갱신', stayConnected && switchOk);
    S.t2_school = KMU_ID;

    // 9) 계정 분석 탭 — 매트릭스 렌더 + 행 존재
    S.tab = 'accounts'; S.t8_school = KMU_ID; S.t8_year = Y_LAST; S.t8_side = 'ex'; S.t8_depth = 'gwanhang'; S.t8_zero = false; S.t8_hl = null; render();
    var accRows = document.querySelectorAll('#view .acc-matrix tbody tr');
    check('계정 분석 매트릭스 렌더 + 행 존재', accRows.length > 0 && !!document.getElementById('acc-r-ex-4100'));

    // 10) 매트릭스 벤치마크 백분위 == 수지 구조 패널 백분위 (동일 로직 공유)
    function topPct(s) { var mm = (s || '').match(/(\d+)\s*%/); return mm ? +mm[1] : null; }
    var matRow = document.getElementById('acc-r-ex-4100');
    var matTops = matRow ? [].map.call(matRow.querySelectorAll('.acc-bench .meter-val'), function (e) { return topPct(e.textContent); }) : [];
    S.tab = 'structure'; S.t2_school = KMU_ID; S.t2_year = Y_LAST; S.t2_sel = { side: 'ex', code: '4100' }; render();
    var panelTops = [].map.call(document.querySelectorAll('#t2-panel .bench-row .meter-val'), function (e) { return topPct(e.textContent); });
    check('매트릭스 벤치마크 백분위 == 수지구조 패널 백분위',
      matTops.length === 3 && panelTops.length === 3 && matTops.every(function (t, i) { return t != null && t === panelTops[i]; }));

    // 11) 시뮬레이션 — r=0 델타 0 · r=10% 인건비부담률 상승 · 탭 렌더
    if (HAS_SIM) {
      var se = simEntry(KMU_ID), so = simOpts(KMU_ID);
      var sp0 = ENG.project(se, { r: 0, t0: 2025 }, so);
      var maxD0 = Math.max.apply(null, sp0.rows.map(function (r) { return Math.abs(r.d5100); }));
      check('시뮬 r=0 델타 0', maxD0 === 0);
      var ssc = ENG.scenarios(se, { r: 0.1, t0: 2025 }, so);
      var lastK = ssc.base.kpis[ssc.base.kpis.length - 1];
      check('시뮬 r=10% 인건비부담률 상승', lastK.delta['인건비부담률'] > 0);
      S.tab = 'simulation'; S.sim_school = KMU_ID; S.sim_mode = 'single';
      S.sim_params = defaultSimParams(); S.sim_params.r = 0.1; S.sim_focus = null; render();
      check('시뮬 탭 SVG 렌더 + 정확도 표', document.querySelectorAll('#view svg').length > 0 &&
        document.querySelectorAll('#view .sim-bt-tbl tbody tr').length > 0);
      S.sim_params = defaultSimParams();

      // 12) 폐교위험 판정 (C6) — 집계 합·경계밴드·단조성·패널 렌더
      var cOpt = { meta: SIMD.meta, schools: schools };
      var cagg0 = ENG.closureAggregate(SIMD, defaultSimParams(), cOpt);
      var cSum0 = cagg0.counts.stable + cagg0.counts.caution + cagg0.counts.atrisk + cagg0.counts.critical + cagg0.counts.unrated;
      check('폐교판정 집계 합=' + schools.length + ' · 위험+ 범위내',
        cSum0 === schools.length && cagg0.atRiskOrWorse >= cagg0.atRiskRange[0] && cagg0.atRiskOrWorse <= cagg0.atRiskRange[1]);
      var cp10 = defaultSimParams(); cp10.r = 0.1;
      var cagg10 = ENG.closureAggregate(SIMD, cp10, cOpt);
      check('폐교판정 r=10% 위험+ 단조 증가', cagg10.atRiskOrWorse >= cagg0.atRiskOrWorse);
      S.tab = 'simulation'; S.sim_mode = 'cohort'; S.sim_params = defaultSimParams(); S.sim_params.r = 0.1; render();
      check('폐교판정 패널 렌더(헤드라인 수치 + 등급칩)',
        document.querySelectorAll('#view .clo-headline .chn-n').length > 0 &&
        document.querySelectorAll('#view .grade-chip').length > 0);
      S.sim_mode = 'single'; S.sim_params = defaultSimParams();
    }

    S.t2_year = Y_LAST; S.tab = 'overview'; render();

    var badge = document.getElementById('selftestBadge');
    badge.className = 'selftest-badge ' + (ok ? 'pass' : 'fail');
    badge.textContent = (ok ? '셀프테스트 통과' : '셀프테스트 실패') + ' (' + results.filter(function (r) { return r[0] === '✓'; }).length + '/' + results.length + ')';
    console.log('%c[SELFTEST] ' + (ok ? 'PASS' : 'FAIL'), 'font-weight:bold', '\n' + results.join('\n'));
    return ok;
  }

  // ═══════════════════════════════════════════════════════
  //  초기화
  // ═══════════════════════════════════════════════════════
  function init() {
    document.getElementById('metaSub').textContent =
      DATA.meta.years[0] + '~' + DATA.meta.years[DATA.meta.years.length - 1] + ' · ' + schools.length + '개교 · 단위 ' + DATA.meta.unit + (DATA.meta.generated ? ' · ' + DATA.meta.generated.slice(0, 10) : '');
    if (LITE) document.getElementById('liteBadge').style.display = 'inline-block';
    setMainVisual();                 // data-main 속성·--main 토큰 확정(부트 시 DOM 준비 후 재확인)
    initTheme();
    initShell();
    renderFilterbar();
    render();
    if (/[?&]selftest=1/.test(location.search)) runSelftest();
  }
  init();
})();
