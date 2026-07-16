/* format.js — 한국식 금액·비율 포맷 유틸 (외부 의존 없음).
 * 금액 입력값 단위는 항상 "천원"(1,000원). 특례규칙 자금계산서 원본 단위와 일치.
 */
(function (global) {
  'use strict';

  function comma(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // 소수 자릿수 정리: 불필요한 0 제거
  function trimNum(x, digits) {
    var s = x.toFixed(digits);
    if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
    return s;
  }

  /* 금액 포맷 (입력 = 천원 단위).
   * 1조 = 1e9 천원, 1억 = 1e5 천원, 1만원 = 10 천원.
   * 반환: "1.23조", "1,234억", "5,600만원", "820천원" */
  function krw(v, opt) {
    opt = opt || {};
    if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return '—';
    var sign = v < 0 ? '-' : '';
    var a = Math.abs(v);
    if (a >= 1e9) return sign + trimNum(a / 1e9, 2) + '조';
    if (a >= 1e5) return sign + comma(Math.round(a / 1e5)) + '억';
    if (a >= 10)  return sign + comma(Math.round(a / 10)) + '만원';
    return sign + comma(Math.round(a)) + '천원';
  }

  /* 억원 고정 포맷 (입력 = 천원 단위). 수지 구조 탭 전용 단위 통일.
   * 1억 = 1e5 천원. 항상 "1,234.5억원"(천단위 콤마 + 소수점 1자리 + 억원).
   * opt.noUnit=true → 단위(억원) 생략, 숫자만. */
  function eok(v, opt) {
    opt = opt || {};
    if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return '—';
    var sign = v < 0 ? '-' : '';
    var s = (Math.abs(v) / 1e5).toFixed(1);   // 천원 → 억원, 소수 1자리
    var parts = s.split('.');
    parts[0] = comma(parts[0]);
    return sign + parts.join('.') + (opt.noUnit ? '' : '억원');
  }

  // 억원 델타(전년 대비 등): 양수 '+' 부호 포함
  function eokDelta(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v >= 0 ? '+' : '') + eok(v);
  }

  // 축 눈금용 짧은 금액 (억/조 단위, 소수 최대 1자리)
  function krwAxis(v) {
    if (v === null || v === undefined || isNaN(v)) return '';
    var sign = v < 0 ? '-' : '';
    var a = Math.abs(v);
    if (a >= 1e9) return sign + trimNum(a / 1e9, 1) + '조';
    if (a >= 1e5) return sign + trimNum(a / 1e5, 0) + '억';
    if (a >= 10)  return sign + trimNum(a / 10, 0) + '만';
    return sign + comma(Math.round(a));
  }

  // 비율 (0.531 → "53.1%"). digits 기본 1.
  function pct(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    digits = (digits === undefined) ? 1 : digits;
    return (v * 100).toFixed(digits) + '%';
  }

  // 퍼센트포인트 델타 (부호 포함)
  function pctPoint(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    digits = (digits === undefined) ? 1 : digits;
    var s = v >= 0 ? '+' : '';
    return s + (v * 100).toFixed(digits) + '%p';
  }

  // 값 유형(fmt)에 따라 자동 포맷: pct → 비율, krw → 금액
  function byFmt(v, fmt, digits) {
    if (fmt === 'pct') return pct(v, digits);
    return krw(v);
  }

  // 델타(전년 대비): 값 유형별 부호 포함
  function delta(v, fmt, digits) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (fmt === 'pct') return pctPoint(v, digits);
    var s = v >= 0 ? '+' : '';
    return s + krw(v);
  }

  // 정수(재학생 수 등) 컴마
  function intComma(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return comma(Math.round(v));
  }

  // 백분위 서수 (0.87 → "상위 13%")
  function percentileLabel(p) {
    if (p === null || p === undefined || isNaN(p)) return '—';
    var top = Math.round((1 - p) * 100);
    return '상위 ' + top + '%';
  }

  global.FMT = {
    comma: comma,
    krw: krw,
    eok: eok,
    eokDelta: eokDelta,
    krwAxis: krwAxis,
    pct: pct,
    pctPoint: pctPoint,
    byFmt: byFmt,
    delta: delta,
    intComma: intComma,
    percentileLabel: percentileLabel
  };
})(typeof window !== 'undefined' ? window : globalThis);
