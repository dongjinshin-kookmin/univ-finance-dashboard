/* charts.js — 자체 SVG 차트 모듈 (외부 의존 전무).
 * lineChart(밴드·이벤트음영·주석) / barChart(가로·스택) / scatter / histogram / sparkline.
 * 공용 scale·axis·legend·tooltip 1개, resize 대응.
 * 색상은 CSS 커스텀 프로퍼티(var(--series-n), var(--kmu) 등)를 style로 주입해
 * 라이트/다크 테마 전환 시 재렌더 없이 자동 반영된다. dataviz 스킬 규칙 준수:
 * 2px 라인·round cap, ≥8px 마커+2px surface ring, 스택 2px surface gap,
 * hairline 그리드, 국민대 상시 강조.
 */
(function (global) {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';

  // ── 공용 유틸 ───────────────────────────────────────────
  function el(tag, attrs, style) {
    var n = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (style) for (var s in style) n.style[s] = style[s];
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function niceTicks(min, max, count) {
    count = count || 5;
    if (min === max) { min -= 1; max += 1; }
    var span = max - min;
    var step = Math.pow(10, Math.floor(Math.log10(span / count)));
    var err = (span / count) / step;
    if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
    var t0 = Math.ceil(min / step) * step;
    var out = [];
    for (var v = t0; v <= max + step * 0.001; v += step) out.push(Math.round(v / step) * step);
    return out;
  }

  function linScale(dmin, dmax, rmin, rmax) {
    if (dmin === dmax) dmax = dmin + 1;
    var m = (rmax - rmin) / (dmax - dmin);
    var f = function (x) { return rmin + (x - dmin) * m; };
    f.invert = function (px) { return dmin + (px - rmin) / m; };
    f.domain = [dmin, dmax];
    return f;
  }

  // ── 단일 툴팁 ───────────────────────────────────────────
  var tip = null;
  function getTip() {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tip';
      tip.style.display = 'none';
      document.body.appendChild(tip);
    }
    return tip;
  }
  function showTip(html, ev) {
    var t = getTip();
    t.innerHTML = html;
    t.style.display = 'block';
    var pad = 14, w = t.offsetWidth, h = t.offsetHeight;
    var x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }

  // ── resize 레지스트리 ───────────────────────────────────
  var registry = [];
  var ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(function (ents) {
    ents.forEach(function (e) {
      registry.forEach(function (r) { if (r.el === e.target) r.draw(); });
    });
  }) : null;
  function register(container, draw) {
    // 기존 등록 제거
    for (var i = registry.length - 1; i >= 0; i--) {
      if (registry[i].el === container) {
        if (ro) ro.unobserve(container);
        registry.splice(i, 1);
      }
    }
    registry.push({ el: container, draw: draw });
    if (ro) ro.observe(container);
    draw();
  }
  // 테마 전환 등 강제 전체 재렌더
  function redrawAll() { registry.forEach(function (r) { r.draw(); }); }

  function baseSvg(container, h) {
    clear(container);
    var w = Math.max(container.clientWidth || 320, 120);
    var svg = el('svg', {
      width: w, height: h, viewBox: '0 0 ' + w + ' ' + h,
      role: 'img', preserveAspectRatio: 'xMidYMid meet'
    });
    svg.classList.add('viz-svg');
    container.appendChild(svg);
    return { svg: svg, w: w, h: h };
  }

  function gridLine(x1, y1, x2, y2) {
    return el('line', { x1: x1, y1: y1, x2: x2, y2: y2 }, { stroke: 'var(--grid)', strokeWidth: '1' });
  }
  function axisText(x, y, txt, anchor, cls) {
    var t = el('text', { x: x, y: y, 'text-anchor': anchor || 'middle' });
    t.setAttribute('class', 'viz-tick' + (cls ? ' ' + cls : ''));
    t.textContent = txt;
    return t;
  }

  // ═══════════════════════════════════════════════════════
  //  LINE CHART
  //  spec: { series:[{name,color,points:[[x,y]],emphasize,dashed,label,width}],
  //          band:{lo:[[x,y]],hi:[[x,y]],color}, events:[{x0,x1,label}],
  //          xTicks:[..], yFmt(fn), tipFmt(fn), height, yZero:bool }
  // ═══════════════════════════════════════════════════════
  function line(container, spec) {
    function draw() {
      var H = spec.height || 300;
      var b = baseSvg(container, H), svg = b.svg, W = b.w;
      var m = { l: 60, r: 64, t: 14, b: 28 };
      var iw = W - m.l - m.r, ih = H - m.t - m.b;

      var allX = [], allY = [];
      (spec.series || []).forEach(function (s) {
        s.points.forEach(function (p) { if (p[1] != null) { allX.push(p[0]); allY.push(p[1]); } });
      });
      if (spec.band) {
        spec.band.lo.forEach(function (p) { if (p[1] != null) { allX.push(p[0]); allY.push(p[1]); } });
        spec.band.hi.forEach(function (p) { if (p[1] != null) { allY.push(p[1]); } });
      }
      if (!allX.length) return;
      var xmin = Math.min.apply(null, allX), xmax = Math.max.apply(null, allX);
      var ymin = Math.min.apply(null, allY), ymax = Math.max.apply(null, allY);
      if (spec.yZero) ymin = Math.min(0, ymin);
      var pad = (ymax - ymin) * 0.08 || 1;
      ymax += pad; if (ymin < 0) ymin -= pad;
      var x = linScale(xmin, xmax, m.l, m.l + iw);
      var y = linScale(ymin, ymax, m.t + ih, m.t);

      // 이벤트 음영
      (spec.events || []).forEach(function (evt) {
        var x0 = x(Math.max(evt.x0, xmin)), x1 = x(Math.min(evt.x1, xmax));
        svg.appendChild(el('rect', { x: x0, y: m.t, width: Math.max(1, x1 - x0), height: ih },
          { fill: 'var(--event-shade)' }));
        var tx = el('text', { x: (x0 + x1) / 2, y: m.t + 12, 'text-anchor': 'middle' });
        tx.setAttribute('class', 'viz-event-label');
        tx.textContent = evt.label;
        svg.appendChild(tx);
      });

      // y 그리드 + 눈금
      var yt = niceTicks(ymin, ymax, 5);
      yt.forEach(function (v) {
        var py = y(v);
        svg.appendChild(gridLine(m.l, py, m.l + iw, py));
        svg.appendChild(axisText(m.l - 8, py + 4, spec.yFmt ? spec.yFmt(v) : v, 'end'));
      });
      // 0선 강조
      if (ymin < 0 && ymax > 0) {
        svg.appendChild(el('line', { x1: m.l, y1: y(0), x2: m.l + iw, y2: y(0) },
          { stroke: 'var(--axis)', strokeWidth: '1' }));
      }

      // x 눈금
      var xticks = spec.xTicks || niceTicks(xmin, xmax, Math.min(9, xmax - xmin + 1));
      xticks.forEach(function (v) {
        svg.appendChild(axisText(x(v), m.t + ih + 20, v, 'middle'));
      });

      // 밴드 (p25~p75)
      if (spec.band) {
        var lo = spec.band.lo, hi = spec.band.hi;
        var d = '';
        var pts = [];
        for (var i = 0; i < hi.length; i++) if (hi[i][1] != null) pts.push([x(hi[i][0]), y(hi[i][1])]);
        for (var j = lo.length - 1; j >= 0; j--) if (lo[j][1] != null) pts.push([x(lo[j][0]), y(lo[j][1])]);
        if (pts.length) {
          d = 'M' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join('L') + 'Z';
          var band = el('path', { d: d }, { fill: spec.band.color || 'var(--series-1)', opacity: '0.13' });
          svg.appendChild(band);
        }
        // p50 점선
        if (spec.band.mid) {
          var md = pathD(spec.band.mid, x, y);
          if (md) svg.appendChild(el('path', { d: md, fill: 'none' },
            { stroke: spec.band.color || 'var(--series-1)', strokeWidth: '1.5', strokeDasharray: '4 4', opacity: '0.85' }));
        }
      }

      // 시리즈 라인 (강조 시리즈는 맨 위)
      var ordered = (spec.series || []).slice().sort(function (a, bb) { return (a.emphasize ? 1 : 0) - (bb.emphasize ? 1 : 0); });
      ordered.forEach(function (s) {
        var d = pathD(s.points, x, y);
        if (!d) return;
        var lw = s.width || (s.emphasize ? 3 : 2);
        svg.appendChild(el('path', { d: d, fill: 'none' },
          { stroke: s.color, strokeWidth: String(lw), strokeLinejoin: 'round', strokeLinecap: 'round',
            strokeDasharray: s.dashed ? '5 4' : '', opacity: s.dim ? '0.5' : '1' }));
        // 끝점 마커 + surface ring (강조 시리즈)
        var last = s.points.filter(function (p) { return p[1] != null; }).pop();
        if (last && s.emphasize) {
          svg.appendChild(el('circle', { cx: x(last[0]), cy: y(last[1]), r: 5 },
            { fill: s.color, stroke: 'var(--surface-1)', strokeWidth: '2' }));
          if (s.label) {
            var lbl = el('text', { x: x(last[0]) + 9, y: y(last[1]) + 4, 'text-anchor': 'start' });
            lbl.setAttribute('class', 'viz-endlabel');
            lbl.textContent = s.label;
            svg.appendChild(lbl);
          }
        }
      });

      // 크로스헤어 + 툴팁 (x=연도 단위 스냅)
      var overlay = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
      overlay.style.cursor = 'crosshair';
      svg.appendChild(overlay);
      var cross = el('line', { x1: 0, y1: m.t, x2: 0, y2: m.t + ih }, { stroke: 'var(--axis)', strokeWidth: '1' });
      cross.style.display = 'none';
      svg.appendChild(cross);
      overlay.addEventListener('mousemove', function (ev) {
        var rect = svg.getBoundingClientRect();
        var scaleX = W / rect.width;
        var px = (ev.clientX - rect.left) * scaleX;
        var xv = Math.round(x.invert(px));
        xv = Math.max(xmin, Math.min(xmax, xv));
        cross.style.display = '';
        cross.setAttribute('x1', x(xv)); cross.setAttribute('x2', x(xv));
        var rows = [];
        (spec.series || []).forEach(function (s) {
          var p = s.points.find(function (q) { return q[0] === xv; });
          if (p && p[1] != null) rows.push('<span class="tip-key"><i style="background:' + resolveColor(s.color) + '"></i>' + s.name + '</span><b>' + (spec.tipFmt ? spec.tipFmt(p[1]) : p[1]) + '</b>');
        });
        if (spec.band) {
          var pm = spec.band.mid && spec.band.mid.find(function (q) { return q[0] === xv; });
          if (pm && pm[1] != null) rows.push('<span class="tip-key tip-muted">코호트 중앙값</span><b>' + (spec.tipFmt ? spec.tipFmt(pm[1]) : pm[1]) + '</b>');
        }
        if (rows.length) showTip('<div class="tip-title">' + xv + '</div>' + rows.map(function (r) { return '<div class="tip-row">' + r + '</div>'; }).join(''), ev);
      });
      overlay.addEventListener('mouseleave', function () { cross.style.display = 'none'; hideTip(); });
    }
    register(container, draw);
  }

  function pathD(points, x, y) {
    var seg = [], d = '';
    points.forEach(function (p) {
      if (p[1] == null) { if (seg.length) { d += segToPath(seg); seg = []; } return; }
      seg.push([x(p[0]), y(p[1])]);
    });
    if (seg.length) d += segToPath(seg);
    return d;
  }
  function segToPath(seg) {
    return 'M' + seg.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join('L');
  }

  // CSS 변수 → 실제 색 (툴팁 스와치용)
  function resolveColor(c) {
    if (typeof c === 'string' && c.indexOf('var(') === 0) {
      var name = c.slice(4, -1).trim();
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return v.trim() || '#888';
    }
    return c;
  }

  // ═══════════════════════════════════════════════════════
  //  BAR CHART (가로 / 스택 겸용)
  //  spec: { items:[{label, segs:[{name,value,color}], emphasize}],
  //          valFmt(fn), stacked:bool, height, maxBar:24 }
  // ═══════════════════════════════════════════════════════
  function bar(container, spec) {
    function draw() {
      var items = spec.items || [];
      var rowH = spec.rowH || 34;
      var H = spec.height || (items.length * rowH + 40);
      var b = baseSvg(container, H), svg = b.svg, W = b.w;
      var m = { l: spec.labelW || 120, r: 70, t: 10, b: 24 };
      var iw = W - m.l - m.r;
      var maxTotal = 0;
      items.forEach(function (it) {
        var t = it.segs.reduce(function (a, s) { return a + Math.max(0, s.value || 0); }, 0);
        if (t > maxTotal) maxTotal = t;
      });
      if (maxTotal <= 0) maxTotal = 1;
      var x = linScale(0, maxTotal, 0, iw);

      // x 그리드
      niceTicks(0, maxTotal, 4).forEach(function (v) {
        var px = m.l + x(v);
        svg.appendChild(gridLine(px, m.t, px, m.t + items.length * rowH));
        svg.appendChild(axisText(px, m.t + items.length * rowH + 18, spec.valFmt ? spec.valFmt(v) : v, 'middle'));
      });

      items.forEach(function (it, i) {
        var cy = m.t + i * rowH;
        var barH = Math.min(spec.maxBar || 24, rowH - 12);
        var by = cy + (rowH - barH) / 2;
        // 라벨
        var lt = el('text', { x: m.l - 10, y: by + barH / 2 + 4, 'text-anchor': 'end' });
        lt.setAttribute('class', 'viz-tick' + (it.emphasize ? ' viz-kmu-label' : ''));
        lt.textContent = it.label;
        svg.appendChild(lt);
        // 세그먼트
        var cx = m.l, gap = 2;
        var total = it.segs.reduce(function (a, s) { return a + Math.max(0, s.value || 0); }, 0);
        it.segs.forEach(function (s, si) {
          var v = Math.max(0, s.value || 0);
          if (v <= 0) return;
          var wpx = x(v);
          var isFirst = si === 0, isLast = si === it.segs.length - 1;
          var eff = Math.max(0, wpx - (isLast ? 0 : gap));
          var r = (spec.stacked ? (isLast ? 4 : 0) : 4);
          var rect = el('rect', { x: cx, y: by, width: eff, height: barH, rx: r, ry: r },
            { fill: s.color });
          if (it.emphasize) rect.style.stroke = 'var(--kmu)';
          svg.appendChild(rect);
          // hover
          (function (seg, itlabel) {
            rect.addEventListener('mousemove', function (ev) {
              showTip('<div class="tip-title">' + itlabel + '</div><div class="tip-row"><span class="tip-key"><i style="background:' + resolveColor(seg.color) + '"></i>' + seg.name + '</span><b>' + (spec.valFmt ? spec.valFmt(seg.value) : seg.value) + '</b></div>', ev);
            });
            rect.addEventListener('mouseleave', hideTip);
          })(s, it.label);
          cx += wpx;
        });
        // 총계 라벨 (스택) 또는 값 라벨 (단일)
        if (total > 0) {
          var tl = el('text', { x: m.l + x(total) + 8, y: by + barH / 2 + 4, 'text-anchor': 'start' });
          tl.setAttribute('class', 'viz-endlabel');
          tl.textContent = spec.valFmt ? spec.valFmt(total) : total;
          svg.appendChild(tl);
        }
      });
    }
    register(container, draw);
  }

  // ═══════════════════════════════════════════════════════
  //  SCATTER
  //  spec: { points:[{x,y,label,color,emphasize,r}], xFmt,yFmt,xLabel,yLabel,height }
  // ═══════════════════════════════════════════════════════
  function scatter(container, spec) {
    function draw() {
      var H = spec.height || 340;
      var b = baseSvg(container, H), svg = b.svg, W = b.w;
      var m = { l: 62, r: 20, t: 16, b: 44 };
      var iw = W - m.l - m.r, ih = H - m.t - m.b;
      var pts = (spec.points || []).filter(function (p) { return p.x != null && p.y != null; });
      if (!pts.length) return;
      var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
      var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
      var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
      var xpad = (xmax - xmin) * 0.08 || 1, ypad = (ymax - ymin) * 0.08 || 1;
      xmin -= xpad; xmax += xpad; ymin -= ypad; ymax += ypad;
      if (spec.yZero && ymin > 0) ymin = 0;
      var x = linScale(xmin, xmax, m.l, m.l + iw);
      var y = linScale(ymin, ymax, m.t + ih, m.t);

      niceTicks(ymin, ymax, 5).forEach(function (v) {
        var py = y(v);
        svg.appendChild(gridLine(m.l, py, m.l + iw, py));
        svg.appendChild(axisText(m.l - 8, py + 4, spec.yFmt ? spec.yFmt(v) : v, 'end'));
      });
      niceTicks(xmin, xmax, 5).forEach(function (v) {
        var px = x(v);
        svg.appendChild(gridLine(px, m.t, px, m.t + ih));
        svg.appendChild(axisText(px, m.t + ih + 18, spec.xFmt ? spec.xFmt(v) : v, 'middle'));
      });
      // 축 라벨
      if (spec.xLabel) { var xl = axisText(m.l + iw / 2, H - 6, spec.xLabel, 'middle', 'viz-axislabel'); svg.appendChild(xl); }
      if (spec.yLabel) {
        var yl = el('text', { x: 14, y: m.t + ih / 2, 'text-anchor': 'middle', transform: 'rotate(-90 14 ' + (m.t + ih / 2) + ')' });
        yl.setAttribute('class', 'viz-tick viz-axislabel'); yl.textContent = spec.yLabel; svg.appendChild(yl);
      }

      // 강조점 맨 위
      pts.slice().sort(function (a, bb) { return (a.emphasize ? 1 : 0) - (bb.emphasize ? 1 : 0); }).forEach(function (p) {
        var r = p.r || (p.emphasize ? 8 : 6);
        var c = el('circle', { cx: x(p.x), cy: y(p.y), r: r },
          { fill: p.color, stroke: 'var(--surface-1)', strokeWidth: '2', opacity: p.emphasize ? '1' : (p.dim ? '0.55' : '0.85') });
        svg.appendChild(c);
        if (p.emphasize && p.label) {
          var t = el('text', { x: x(p.x) + r + 5, y: y(p.y) + 4, 'text-anchor': 'start' });
          t.setAttribute('class', 'viz-endlabel'); t.textContent = p.label; svg.appendChild(t);
        }
        (function (pt) {
          c.addEventListener('mousemove', function (ev) {
            showTip('<div class="tip-title">' + (pt.label || '') + '</div><div class="tip-row"><span class="tip-key tip-muted">' + (spec.xLabel || 'x') + '</span><b>' + (spec.xFmt ? spec.xFmt(pt.x) : pt.x) + '</b></div><div class="tip-row"><span class="tip-key tip-muted">' + (spec.yLabel || 'y') + '</span><b>' + (spec.yFmt ? spec.yFmt(pt.y) : pt.y) + '</b></div>', ev);
          });
          c.addEventListener('mouseleave', hideTip);
        })(p);
      });
    }
    register(container, draw);
  }

  // ═══════════════════════════════════════════════════════
  //  HISTOGRAM
  //  spec: { values:[..], marker:{x,label,color}, xFmt, bins, height, color }
  // ═══════════════════════════════════════════════════════
  function histogram(container, spec) {
    function draw() {
      var H = spec.height || 260;
      var b = baseSvg(container, H), svg = b.svg, W = b.w;
      var m = { l: 40, r: 20, t: 16, b: 44 };
      var iw = W - m.l - m.r, ih = H - m.t - m.b;
      var vals = (spec.values || []).filter(function (v) { return v != null; });
      if (!vals.length) return;
      var vmin = Math.min.apply(null, vals), vmax = Math.max.apply(null, vals);
      if (spec.marker && spec.marker.x != null) { vmin = Math.min(vmin, spec.marker.x); vmax = Math.max(vmax, spec.marker.x); }
      if (vmin === vmax) { vmin -= 0.5; vmax += 0.5; }
      var nb = spec.bins || Math.max(5, Math.min(12, Math.round(Math.sqrt(vals.length) * 2)));
      var bw = (vmax - vmin) / nb;
      var counts = new Array(nb).fill(0);
      vals.forEach(function (v) {
        var idx = Math.min(nb - 1, Math.floor((v - vmin) / bw));
        counts[idx]++;
      });
      var cmax = Math.max.apply(null, counts) || 1;
      var x = linScale(vmin, vmax, m.l, m.l + iw);
      var y = linScale(0, cmax, m.t + ih, m.t);

      niceTicks(0, cmax, 3).forEach(function (v) {
        var py = y(v);
        svg.appendChild(gridLine(m.l, py, m.l + iw, py));
        svg.appendChild(axisText(m.l - 6, py + 4, v, 'end'));
      });
      niceTicks(vmin, vmax, 5).forEach(function (v) {
        svg.appendChild(axisText(x(v), m.t + ih + 18, spec.xFmt ? spec.xFmt(v) : v, 'middle'));
      });

      var gap = 2;
      counts.forEach(function (cnt, i) {
        if (cnt <= 0) return;
        var x0 = x(vmin + i * bw), x1 = x(vmin + (i + 1) * bw);
        var py = y(cnt);
        var rect = el('rect', { x: x0 + gap / 2, y: py, width: Math.max(1, x1 - x0 - gap), height: (m.t + ih) - py, rx: 3, ry: 3 },
          { fill: spec.color || 'var(--series-1)', opacity: '0.85' });
        svg.appendChild(rect);
        (function (lo, hi, c) {
          rect.addEventListener('mousemove', function (ev) {
            showTip('<div class="tip-row"><span class="tip-key tip-muted">' + (spec.xFmt ? spec.xFmt(lo) : lo) + '~' + (spec.xFmt ? spec.xFmt(hi) : hi) + '</span><b>' + c + '개교</b></div>', ev);
          });
          rect.addEventListener('mouseleave', hideTip);
        })(vmin + i * bw, vmin + (i + 1) * bw, cnt);
      });

      // 국민대 마커 (수직선 + 라벨)
      if (spec.marker && spec.marker.x != null) {
        var mx = x(spec.marker.x);
        svg.appendChild(el('line', { x1: mx, y1: m.t, x2: mx, y2: m.t + ih },
          { stroke: spec.marker.color || 'var(--kmu)', strokeWidth: '2.5' }));
        var lt = el('text', { x: mx, y: m.t - 4, 'text-anchor': 'middle' });
        lt.setAttribute('class', 'viz-kmu-label');
        lt.textContent = spec.marker.label || '국민대';
        svg.appendChild(lt);
      }
    }
    register(container, draw);
  }

  // ═══════════════════════════════════════════════════════
  //  SPARKLINE (인라인, 축 없음)
  //  spec: { points:[y,...] or [[x,y]], color, height, last:bool }
  // ═══════════════════════════════════════════════════════
  function sparkline(container, spec) {
    function draw() {
      var H = spec.height || 34;
      var b = baseSvg(container, H), svg = b.svg, W = b.w;
      var raw = spec.points || [];
      var pts = raw.map(function (p, i) { return Array.isArray(p) ? p : [i, p]; })
        .filter(function (p) { return p[1] != null; });
      if (pts.length < 2) return;
      var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
      var x = linScale(Math.min.apply(null, xs), Math.max.apply(null, xs), 3, W - 3);
      var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
      var y = linScale(ymin, ymax, H - 4, 4);
      var d = 'M' + pts.map(function (p) { return x(p[0]).toFixed(1) + ',' + y(p[1]).toFixed(1); }).join('L');
      svg.appendChild(el('path', { d: d, fill: 'none' },
        { stroke: spec.color || 'var(--series-1)', strokeWidth: '2', strokeLinejoin: 'round', strokeLinecap: 'round' }));
      if (spec.last !== false) {
        var lp = pts[pts.length - 1];
        svg.appendChild(el('circle', { cx: x(lp[0]), cy: y(lp[1]), r: 3 },
          { fill: spec.color || 'var(--series-1)', stroke: 'var(--surface-1)', strokeWidth: '1.5' }));
      }
    }
    register(container, draw);
  }

  global.CHARTS = {
    line: line, bar: bar, scatter: scatter, histogram: histogram, sparkline: sparkline,
    redrawAll: redrawAll, resolveColor: resolveColor, niceTicks: niceTicks
  };
})(typeof window !== 'undefined' ? window : globalThis);
