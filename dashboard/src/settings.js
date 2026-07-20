/* settings.js — 기본설정 스키마 · 지속성(localStorage) · 검증 · 이관(JSON).
 * 순수 라이브러리(window.SETTINGS). 학교 데이터에 의존하지 않으며, 존재하는
 * 학교명 정리는 호출측이 validNames(이름 집합)을 넘겨 수행한다.
 *
 * 지속성 계약(설계 §2.2):
 *   - 단일 고정 키 kmu-dash:settings (파일명/번들 무관 · file:// 공유 의도).
 *   - 전 경로 try/catch → 접근 자체가 throw 가능(Safari file://, 프라이빗) → 인메모리 폴백.
 *   - 스키마 버전(payload.v) 내장, JSON 내보내기/가져오기(범용 우회로).
 */
(function (global) {
  'use strict';

  var KEY = 'kmu-dash:settings';
  var VERSION = 1;
  var ALL_TYPES = ['대학', '전문대학', '대학원대학', '사이버대학'];
  var DEFAULTS = {
    v: VERSION,
    mainSchoolName: '국민대학교',
    competitorNames: ['경희대학교', '세종대학교', '숙명여자대학교', '숭실대학교', '중앙대학교', '한양대학교'],
    typeFilter: ['대학'],
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function defaults() { return clone(DEFAULTS); }

  function toSet(x) {
    if (!x) return null;
    if (x.has && typeof x.has === 'function') return x;
    return new Set(x);
  }

  // 가나다(한국어) 정렬 사본
  function sortKo(arr) {
    return arr.slice().sort(function (a, b) { return String(a).localeCompare(String(b), 'ko'); });
  }

  // localStorage 접근 프로브 — 접근 자체가 예외를 던질 수 있어 전부 try/catch.
  function storageAvailable() {
    try {
      var ls = global.localStorage;
      if (!ls) return false;
      var k = '__kmu_probe__';
      ls.setItem(k, '1');
      ls.removeItem(k);
      return true;
    } catch (e) { return false; }
  }

  /* 정규화·검증(설계 §7):
   *  - competitorNames: 문자열만 · 트림 · 메인 제외(서로소) · 중복 제거 · 1~7 클램프 · 가나다 정렬.
   *  - typeFilter: 알려진 형태만 · 비면 ['대학'].
   *  - opts.validNames(Set|Array): 주면 존재하지 않는 학교명 정리(경쟁에서 드롭). 메인 폴백은 호출측 담당.
   *  - 경쟁이 0개가 되면 기본 6교 복원(가능하면 validNames·메인 기준으로 필터).
   */
  function normalize(raw, opts) {
    opts = opts || {};
    var out = defaults();
    if (raw && typeof raw === 'object') {
      if (typeof raw.mainSchoolName === 'string' && raw.mainSchoolName.trim()) out.mainSchoolName = raw.mainSchoolName.trim();
      if (Array.isArray(raw.competitorNames)) {
        out.competitorNames = raw.competitorNames
          .filter(function (x) { return typeof x === 'string' && x.trim(); })
          .map(function (x) { return x.trim(); });
      }
      if (Array.isArray(raw.typeFilter)) {
        out.typeFilter = raw.typeFilter.filter(function (t) { return ALL_TYPES.indexOf(t) >= 0; });
      }
    }
    var valid = toSet(opts.validNames);
    if (valid) out.competitorNames = out.competitorNames.filter(function (n) { return valid.has(n); });

    // 서로소(메인 제외) + 중복 제거
    var seen = {}, dedup = [];
    out.competitorNames.forEach(function (n) {
      if (n !== out.mainSchoolName && !seen[n]) { seen[n] = 1; dedup.push(n); }
    });
    out.competitorNames = dedup;

    // 공집합 → 기본 6교 복원
    if (out.competitorNames.length === 0) {
      var d = defaults().competitorNames.filter(function (n) { return n !== out.mainSchoolName; });
      if (valid) d = d.filter(function (n) { return valid.has(n); });
      out.competitorNames = d;
    }
    if (out.competitorNames.length > 7) out.competitorNames = out.competitorNames.slice(0, 7);
    out.competitorNames = sortKo(out.competitorNames);

    if (!out.typeFilter.length) out.typeFilter = ['대학'];
    out.v = VERSION;
    return out;
  }

  // 스키마 버전 마이그레이션(설계 §7-4). 불가 시 null.
  function migrate(payload) {
    if (!payload || typeof payload !== 'object') return null;
    var v = payload.v;
    if (v == null) { payload.v = VERSION; return payload; }   // 프리버전 → v1로 best-effort
    if (v > VERSION) return payload;                          // 미래 버전: 알려진 필드만 읽고 다운그레이드 쓰기 금지(호출측 판단)
    return payload;                                           // v===1 현재
  }

  /* 로드 → { settings, source, persistable, warning? }
   *  source: 'stored'(저장값) | 'default'(첫 실행/비어있음) | 'fallback'(예외 → 세션전용)
   *  persistable: 이후 save가 실제로 지속될 수 있는지(스토리지 가용) */
  function load() {
    if (!storageAvailable()) return { settings: defaults(), source: 'default', persistable: false };
    try {
      var raw = global.localStorage.getItem(KEY);
      if (raw == null) return { settings: defaults(), source: 'default', persistable: true };
      var parsed = JSON.parse(raw);
      var mig = migrate(parsed);
      if (!mig) return { settings: defaults(), source: 'default', persistable: true, warning: '설정 형식 오류 — 기본값으로 시작합니다.' };
      return { settings: mig, source: 'stored', persistable: true };
    } catch (e) {
      return { settings: defaults(), source: 'fallback', persistable: false, warning: '이 브라우저에서는 설정을 불러올 수 없습니다 — 기본값으로 시작합니다.' };
    }
  }

  // 저장 → { ok, persisted, error? }
  function save(settings) {
    try {
      if (!storageAvailable()) return { ok: false, persisted: false, error: '이 브라우저에서는 설정이 저장되지 않습니다 — 내보내기로 백업하세요.' };
      global.localStorage.setItem(KEY, JSON.stringify(settings));
      return { ok: true, persisted: true };
    } catch (e) {
      return { ok: false, persisted: false, error: '설정 저장 실패 — 세션에만 적용됩니다.' };
    }
  }

  function exportJSON(settings) { return JSON.stringify(settings, null, 2); }
  function importJSON(text) {
    try {
      var p = JSON.parse(text);
      var mig = migrate(p);
      if (!mig) return { ok: false, error: '설정 형식을 인식할 수 없습니다.' };
      return { ok: true, settings: mig };
    } catch (e) { return { ok: false, error: 'JSON 파싱 실패 — 텍스트를 확인하세요.' }; }
  }

  global.SETTINGS = {
    KEY: KEY,
    VERSION: VERSION,
    ALL_TYPES: ALL_TYPES,
    defaults: defaults,
    storageAvailable: storageAvailable,
    normalize: normalize,
    migrate: migrate,
    load: load,
    save: save,
    exportJSON: exportJSON,
    importJSON: importJSON,
    sortKo: sortKo,
  };
})(typeof window !== 'undefined' ? window : globalThis);
