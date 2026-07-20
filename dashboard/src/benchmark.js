/* benchmark.js — 전역 기준군(전국 / 수도권 / 경쟁) 집계 엔진.
 * 순수 라이브러리(window.BENCH). app.js가 데이터 컨텍스트로 1회 인스턴스화한다.
 *
 * 설계 계약(§3):
 *  - 세 코호트 모집단(설계 §3.1):
 *      national  = 전체 학교 ∩ typeFilter          (typeFilter 적용)
 *      metro     = national ∩ region==='수도권'      (typeFilter 적용)
 *      competitor= COMP_IDS (1~7 명시)               (typeFilter 미적용)
 *    → 사이드바 필터(S.regions/S.scales/S.cohort)와 독립된 별개 축.
 *  - 집계 의미론(§3.2)은 "값 함수"로 호출측이 결정:
 *      · 비율지표: valueFn = (sid,y)=>kv(kpiName,sid,y)  → 중앙값(p50) 주선 + p25~p75 밴드
 *      · 금액지표: valueFn = 구성비(share-of-total) 또는 1인당(per-student)  → 중앙값 기반 백분위
 *    엔진은 stats(app.js)와 동일 사분위를 재사용(§3.3)하므로 의미론은 valueFn 선택에 위임.
 *  - 백분위 규약: 기존 benchmarkGroups과 동일 → below/(n-1). F.percentileLabel과 정합.
 *  - 캐시: 설정 시그니처(typeFilter·COMP_IDS·MAIN) 변경 시 자동 무효화 + invalidate().
 *
 * ctx = {
 *   schools, YEARS,
 *   kv(name,sid,year)->num|null,          // KPI getter
 *   stats(vals)->{p25,p50,p75,mean,n,...}|null,
 *   getMainId()->id, getCompIds()->[id], getTypeSet()->Set<type>
 * }
 */
(function (global) {
  'use strict';

  function create(ctx) {
    var schools = ctx.schools, YEARS = ctx.YEARS, kv = ctx.kv, stats = ctx.stats;
    var getMainId = ctx.getMainId, getCompIds = ctx.getCompIds, getTypeSet = ctx.getTypeSet;

    var popCache = null, popSig = null, statCache = {};

    function sig() {
      var tset = getTypeSet ? getTypeSet() : null;
      var types = tset ? Array.from(tset).sort().join(',') : '';
      var comp = (getCompIds ? getCompIds() : []) || [];
      return types + '§' + comp.slice().sort(function (a, b) { return a - b; }).join(',') + '§' + (getMainId ? getMainId() : '');
    }
    function ensureFresh() {
      var s = sig();
      if (s !== popSig) { popCache = null; statCache = {}; popSig = s; }
    }

    // 세 코호트 모집단 id 집합
    function pops() {
      ensureFresh();
      if (popCache) return popCache;
      var tset = getTypeSet ? getTypeSet() : null;
      var national = [], metro = [];
      schools.forEach(function (s, i) {
        if (tset && tset.size && !tset.has(s.type)) return;
        national.push(i);
        if (s.region === '수도권') metro.push(i);
      });
      var comp = ((getCompIds ? getCompIds() : []) || []).slice();
      popCache = { national: national, metro: metro, competitor: comp };
      return popCache;
    }

    // popKey: 'national'|'metro'|'competitor' | id 배열 직접
    function idsFor(popKey) {
      if (Array.isArray(popKey)) return popKey;
      var p = pops();
      return p[popKey] || [];
    }

    function counts() {
      var p = pops();
      return { national: p.national.length, metro: p.metro.length, competitor: p.competitor.length };
    }

    // 일반 코호트 통계: valueFn(sid,year)->num|null → stats(app.js와 동일 사분위)
    function cohortStats(popKey, valueFn, year) {
      var ids = idsFor(popKey);
      var vals = ids.map(function (sid) { return valueFn(sid, year); });
      return stats(vals);
    }

    // KPI(kv) 통계 — 명명 popKey에 한해 캐시
    function kpiStats(popKey, kpiName, year) {
      ensureFresh();
      var canCache = (typeof popKey === 'string');
      var key = canCache ? (popKey + '§' + kpiName + '§' + year) : null;
      if (key && statCache[key] !== undefined) return statCache[key];
      var r = cohortStats(popKey, function (sid, y) { return kv(kpiName, sid, y); }, year);
      if (key) statCache[key] = r;
      return r;
    }

    // 연도별 시계열 집계: [{year, stats}]
    function series(popKey, valueFn) {
      return YEARS.map(function (y) { return { year: y, stats: cohortStats(popKey, valueFn, y) }; });
    }
    function kpiSeries(popKey, kpiName) {
      return YEARS.map(function (y) { return { year: y, stats: kpiStats(popKey, kpiName, y) }; });
    }

    // 백분위(0~1): 값 v가 모집단에서 차지하는 위치. 기존 규약(below/(n-1)) 준수.
    function percentileOf(popKey, valueFn, year, v) {
      if (v == null || isNaN(v)) return null;
      var ids = idsFor(popKey);
      var vals = ids.map(function (sid) { return valueFn(sid, year); })
        .filter(function (x) { return x != null && !isNaN(x); })
        .sort(function (a, b) { return a - b; });
      var n = vals.length;
      if (n < 2) return null;
      var below = vals.filter(function (x) { return x < v; }).length;
      return below / (n - 1);
    }
    function kpiPercentile(popKey, kpiName, year, sid) {
      return percentileOf(popKey, function (s, y) { return kv(kpiName, s, y); }, year, kv(kpiName, sid, year));
    }

    function invalidate() { popCache = null; popSig = null; statCache = {}; }

    return {
      pops: pops,
      idsFor: idsFor,
      counts: counts,
      cohortStats: cohortStats,
      kpiStats: kpiStats,
      series: series,
      kpiSeries: kpiSeries,
      percentileOf: percentileOf,
      kpiPercentile: kpiPercentile,
      invalidate: invalidate,
    };
  }

  global.BENCH = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
