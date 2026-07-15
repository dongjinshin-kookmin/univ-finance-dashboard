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

  // KMU
  var KMU_ID = schools.findIndex(function (s) { return s.kmu; });
  if (KMU_ID < 0) KMU_ID = 0;

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
    tab: 'overview',
    cohort: 'all',
    regions: new Set(regionsAll),
    scales: new Set(scalesAll),
    types: new Set(typesAll),
    y0: Y_FIRST, y1: Y_LAST,
    t2_school: KMU_ID, t2_year: Y_LAST, t2_side: 'in',
    t2_open: new Set(rootsOf('in').slice(0, 1).map(function (a) { return a.code; })),
    t2_sel: '5100',
    t3_metric: { type: 'kpi', name: '등록금의존율_총계' },
    t4_schools: [KMU_ID].concat(nonKmu.slice(0, 2)),
    t4_metric: '등록금의존율_총계',
    t4_x: 'enroll', t4_y: '등록금의존율_총계',
    t4_sort: { key: '등록금의존율_총계', asc: false },
    t5_school: KMU_ID, t5_year: Y_LAST, t5_side: 'in',
  };

  function uniq(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

  // 필터 통과 학교(코호트 모집단). 국민대 강제 포함.
  function filteredSchoolIds() {
    var out = [];
    schools.forEach(function (s, i) {
      if (i === KMU_ID) { out.push(i); return; }
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
    overview:  '<path d="M4 4h7v7H4z"/><path d="M13 4h7v4h-7z"/><path d="M13 11h7v9h-7z"/><path d="M4 14h7v6H4z"/>',
    structure: '<path d="M3 5h18"/><path d="M6 5v14"/><path d="M6 10h9"/><path d="M6 15h6"/>',
    timeseries:'<path d="M3 3v18h18"/><path d="M7 14l3-4 3 3 4-6"/>',
    compare:   '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M4 20h16"/>',
    data:      '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    cap:       '<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1 2.7 2 6 2s6-1 6-2v-5"/>',
    scale:     '<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-2.5 6h5z"/><path d="M19 7l-2.5 6h5z"/><path d="M8 21h8"/>',
    bank:      '<path d="M3 10l9-6 9 6"/><path d="M5 10v8"/><path d="M9 10v8"/><path d="M15 10v8"/><path d="M19 10v8"/><path d="M3 21h18"/>',
    award:     '<circle cx="12" cy="9" r="5"/><path d="M9 13.5L8 21l4-2 4 2-1-7.5"/>',
    users:     '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5a3.5 3.5 0 0 1 0 7"/><path d="M21 20a6 6 0 0 0-4-5.6"/>',
    book:      '<path d="M4 4h9a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H4z"/><path d="M20 4h-4a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2.5H20z"/>'
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
    { id: 'overview', label: '개요', title: '개요', eyebrow: 'Overview · 국민대학교 핵심 진단' },
    { id: 'structure', label: '수지 구조', title: '수지 구조', eyebrow: 'Structure · 관·항·목 드릴다운' },
    { id: 'timeseries', label: '시계열', title: '시계열 추이', eyebrow: 'Time Series · KPI 시계열' },
    { id: 'compare', label: '대학 비교', title: '대학 비교', eyebrow: 'Comparison · 코호트 벤치마크' },
    { id: 'data', label: '데이터·검증', title: '데이터 · 검증', eyebrow: 'Data · 항등식 검증과 원장' },
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
    var eb = document.getElementById('stageEyebrow'); if (eb) eb.textContent = t ? t.eyebrow : '';
    var st = document.getElementById('stageTitle'); if (st) st.textContent = t ? t.title : '';
    var cr = document.getElementById('crumbTab'); if (cr) cr.textContent = t ? t.title : '';
    var v = document.getElementById('view');
    v.innerHTML = '';
    ({ overview: renderOverview, structure: renderStructure, timeseries: renderTimeseries, compare: renderCompare, data: renderData })[S.tab](v);
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
  //  탭 2 — 수지 구조 (드릴다운 트리)
  // ═══════════════════════════════════════════════════════
  function renderStructure(v) {
    var side = S.t2_side, sid = S.t2_school, yr = S.t2_year;
    // 컨트롤
    var schoolSel = h('select', { class: 'sel', onChange: function () { S.t2_school = +this.value; render(); } },
      schools.map(function (s, i) { return h('option', { value: i, selected: i === sid ? 'selected' : null, text: s.n + (s.kmu ? ' ★' : '') }); }));
    var yearSel = h('select', { class: 'sel', onChange: function () { S.t2_year = +this.value; render(); } },
      YEARS.map(function (y) { return h('option', { value: y, selected: y === yr ? 'selected' : null, text: y + '년' }); }));
    var sideToggle = h('div', { class: 'chip-row' }, [
      h('button', { class: 'chip' + (side === 'in' ? ' on' : ''), text: '수입', onClick: function () { S.t2_side = 'in'; S.t2_sel = 'T_IN'; render(); } }),
      h('button', { class: 'chip' + (side === 'ex' ? ' on' : ''), text: '지출', onClick: function () { S.t2_side = 'ex'; S.t2_sel = 'T_EX'; render(); } }),
    ]);
    v.appendChild(h('div', { class: 'row-controls' }, [
      ctrl('대학', schoolSel), ctrl('연도', yearSel), ctrl('구분', sideToggle),
      LITE ? h('span', { class: 'pill warn', html: '<i></i>LITE: 목(目) 미표시 → 관·항까지' }) : null,
    ]));

    var total = gv(side, side === 'in' ? 'T_IN' : 'T_EX', sid, yr) || 1;
    // 브레드크럼
    var selNode = ACC[side][S.t2_sel];
    v.appendChild(breadcrumb(side, S.t2_sel));

    var grid = h('div', { class: 'grid c2' });
    // 트리
    var treeCard = h('div', { class: 'card' }, [
      h('h3', { text: (side === 'in' ? '수입' : '지출') + ' 계층 — ' + schools[sid].n + ' ' + yr + '년' }),
      h('div', { class: 'card-sub', text: '총계 ' + F.krw(total) + ' · 관→항' + (LITE ? '' : '→목') + ' 드릴다운(행 클릭)' }),
    ]);
    var tree = h('div', { class: 'tree' });
    tree.appendChild(treeHeader());
    rootsOf(side).forEach(function (root, ri) { appendTreeNode(tree, side, root, sid, yr, total, 0, treeColor(ri)); });
    treeCard.appendChild(tree);
    grid.appendChild(treeCard);

    // 선택 노드 시계열
    var selCode = S.t2_sel;
    var selAcc = ACC[side][selCode] || ACC[side][side === 'in' ? 'T_IN' : 'T_EX'];
    var tsCard = h('div', { class: 'card' }, [
      h('h3', { text: '선택 계정 추이 — ' + (selAcc ? selAcc.name : '') }),
      h('div', { class: 'card-sub', text: schools[sid].n + ' 실선 · 코호트 중앙값 점선(동일 계정)' }),
    ]);
    var tsBox = chartBox(280); tsCard.appendChild(tsBox);
    tsCard.appendChild(h('div', { class: 'legend' }, [
      h('span', { class: 'lg', html: '<i style="background:' + (sid === KMU_ID ? 'var(--kmu)' : 'var(--series-1)') + '"></i>' + schools[sid].n }),
      h('span', { class: 'lg', html: '<i class="dash" style="color:var(--muted)"></i>코호트 중앙값' }),
    ]));
    grid.appendChild(tsCard);
    v.appendChild(grid);

    drawNodeTrend(tsBox, side, selCode, sid);
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
  function appendTreeNode(container, side, acc, sid, yr, total, depth, rootColor) {
    if (LITE && acc.lv === 3) return;
    var val = gv(side, acc.code, sid, yr) || 0;
    var prev = gv(side, acc.code, sid, yr - 1);
    var yoy = (prev != null && prev !== 0) ? (val - prev) / prev : null;
    var kids = childrenOf(side, acc.code).filter(function (a) { return !(LITE && a.lv === 3); });
    var hasKids = kids.length > 0;
    var open = S.t2_open.has(acc.code);
    var share = total ? val / total : 0;
    var node = h('div', {
      class: 'tnode' + (depth === 0 ? ' lv1' : '') + (hasKids ? ' clickable' : '') + (S.t2_sel === acc.code ? ' selected' : ''),
      onClick: function (e) {
        S.t2_sel = acc.code;
        if (hasKids) { if (open) S.t2_open.delete(acc.code); else S.t2_open.add(acc.code); }
        render();
      }
    }, [
      h('div', { class: 'tname' + (depth ? ' indent-' + depth : '') }, [
        h('span', { class: 'caret', text: hasKids ? (open ? '▾' : '▸') : '' }),
        depth === 0 ? h('span', { class: 'tsq', style: 'background:' + rootColor }) : null,
        h('span', { class: 'nm', text: acc.name }),
      ]),
      h('div', { class: 'tbar-wrap' }, [h('div', { class: 'tbar', style: 'width:' + (Math.max(1, share * 100)).toFixed(1) + '%;background:' + rootColor + ';opacity:' + (depth === 0 ? '1' : depth === 1 ? '0.72' : '0.5') })]),
      h('div', { class: 'tval', text: F.krw(val) }),
      h('div', { class: 'tshare', text: F.pct(share, 1) }),
    ]);
    // yoy 별도 열 대신 tshare 옆에 붙이기 위해 grid 4열
    node.appendChild(h('div', { class: 'tyoy ' + (yoy == null ? '' : (yoy >= 0 ? 'up' : 'down')), text: yoy == null ? '—' : F.pctPoint(yoy, 1) }));
    container.appendChild(node);
    if (hasKids && open) kids.forEach(function (k) { appendTreeNode(container, side, k, sid, yr, total, depth + 1, rootColor); });
  }
  function treeColor(ri) { return 'var(--series-' + ((ri % 8) + 1) + ')'; }
  function breadcrumb(side, code) {
    var chain = [], c = code;
    while (c) { var a = ACC[side][c]; if (!a) break; chain.unshift(a); c = a.p; }
    var totName = side === 'in' ? '자금수입총계' : '자금지출총계';
    return h('div', { class: 'breadcrumb', html: totName + (chain.length ? ' › ' + chain.map(function (a) { return '<b>' + a.name + '</b>'; }).join(' › ') : '') });
  }
  function drawNodeTrend(box, side, code, sid) {
    var yrs = YEARS.filter(function (y) { return y >= S.y0 && y <= S.y1; });
    var self = yrs.map(function (y) { return [y, gv(side, code, sid, y)]; });
    var pop = filteredSchoolIds();
    var mid = yrs.map(function (y) {
      var st = stats(pop.map(function (p) { return gv(side, code, p, y); }));
      return [y, st ? st.p50 : null];
    });
    C.line(box, {
      height: 280, yZero: true,
      series: [
        { name: schools[sid].n, color: sid === KMU_ID ? 'var(--kmu)' : 'var(--series-1)', points: self, emphasize: true },
        { name: '코호트 중앙값', color: 'var(--muted)', points: mid, dashed: true, dim: true },
      ],
      xTicks: yrs, yFmt: F.krwAxis, tipFmt: F.krw,
    });
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

    // 2) 각 탭 렌더 후 SVG 노드 > 0
    ['overview', 'structure', 'timeseries', 'compare', 'data'].forEach(function (t) {
      S.tab = t; render();
      var n = document.querySelectorAll('#view svg').length;
      check('탭 ' + t + ' SVG 렌더(' + n + ')', t === 'data' ? true : n > 0);
    });
    S.tab = 'overview'; render();

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
    initTheme();
    initShell();
    renderFilterbar();
    render();
    if (/[?&]selftest=1/.test(location.search)) runSelftest();
  }
  init();
})();
