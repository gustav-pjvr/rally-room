/* Rally Room v2 | direction A | the one shared court stand-in.
   Every host page has <div class="scene" data-court="preset">; this file draws the
   scene as flat SVG from real court measurements (metres) through a shifted-lens
   projection, so verticals stay vertical like a poster. The 3D scene replaces it. */
(function () {
  'use strict';

  var C = {
    ink: '#1B1B1E', cream: '#F3E9D2', teal: '#0F4C5C', ball: '#D8EF3A',
    plumDeep: '#3A2147', plum: '#6A2F5E', rose: '#B94A68', coral: '#E77C59', peach: '#F6B56C',
    sun: '#FCE0A2', ground: '#9A4527', stand: '#2B1B3A',
    apricot: '#F2A65A', roseP: '#E2788A', mint: '#7CC6B8', plumP: '#9A6BB0'
  };
  var SKY = {
    sun: [[0, C.plumDeep], [0.2, C.plum], [0.45, C.rose], [0.68, C.coral], [0.84, C.peach]],
    title: [[0, C.plum], [0.1, C.rose], [0.42, C.coral], [0.7, C.peach]],
    away: [[0, '#2B1B3A'], [0.3, C.plumDeep], [0.58, '#56295A'], [0.82, '#7D3766']]
  };
  var WIDE = { w: 1920, h: 1080, horizon: 300, f: 1054, camH: 4.1, camD: 7.23 };
  var HALF = { w: 960, h: 1080, horizon: 330, f: 580, camH: 7.1, camD: 7.23 };

  var PRESETS = {
    title: Object.assign({}, WIDE, { horizon: 600, camH: 2.7, sky: 'title', sunX: 0.7, sunR: 0.165, masts: [[11, 16], [12.5, 2]],
      near: { x: 3.1, z: -12.7, color: C.apricot }, far: { x: -2.6, z: 11.3, color: C.mint, hoop: true },
      ball: { x: 0.9, y: 2.3, z: -2.5 } }),
    lobby: Object.assign({}, WIDE, { horizon: 250, sunX: 0.5, sunR: 0.1,
      masts: [[9.6, 16], [-12.5, 2], [12.5, 2]],
      near: null, far: { x: -0.6, z: 11.3, color: C.roseP, hoop: true }, ball: null }),
    match: Object.assign({}, WIDE, { horizon: 350, sunX: 0.3, sunR: 0.12,
      near: { x: 1.1, z: -12.7, color: C.apricot }, far: { x: -1.8, z: 10.6, color: C.mint, hoop: true },
      ball: { x: 3.3, y: 0.55, z: 13.6 }, mark: { x: 3.1, z: 12.5 } }),
    end: Object.assign({}, WIDE, { sunX: 0.74, sunR: 0.12, masts: [[11, 16], [12.5, 5]],
      near: { x: 4.6, z: -12.4, color: C.apricot, cheer: true }, far: { x: 1.5, z: 11.3, color: C.mint, hoop: true }, ball: null }),
    splitL: Object.assign({}, HALF, { sunX: 0.5, sunR: 0.2,
      near: { x: 1.9, z: -12.7, color: C.apricot }, far: { x: -1.6, z: 10.8, color: C.roseP, hoop: true },
      ball: { x: -0.9, y: 1.5, z: 1.8 } }),
    splitR: Object.assign({}, HALF, { facing: 'away', sky: 'away',
      near: { x: -1.9, z: -12.7, color: C.roseP, hoop: true, side: -1 }, far: { x: -0.9, z: 11.3, color: C.apricot },
      ball: { x: 0.9, y: 1.5, z: -1.8 } })
  };

  var uid = 0;

  function draw(o) {
    var W = o.w, H = o.h, camZ = -(11.885 + o.camD), dir = o.facing === 'away' ? 1 : -1;
    function S(z) { return o.f / Math.max(1.3, z - camZ); }
    function P(x, y, z) { var s = S(z); return [W / 2 + s * x, o.horizon + s * (o.camH - y)]; }
    function n(v) { return v.toFixed(1); }
    function poly(pts, fill, extra) {
      return '<polygon points="' + pts.map(function (p) { return n(p[0]) + ',' + n(p[1]); }).join(' ') + '" fill="' + fill + '"' + (extra || '') + '/>';
    }
    function ground(x1, z1, x2, z2, fill, extra) { return poly([P(x1, 0, z1), P(x2, 0, z1), P(x2, 0, z2), P(x1, 0, z2)], fill, extra); }
    var out = [];

    // sky: flat bands, the way a print steps a sunset through a few inks
    var sky = SKY[o.sky || 'sun'];
    sky.forEach(function (b, i) {
      var y0 = b[0] * o.horizon, y1 = (i + 1 < sky.length ? sky[i + 1][0] : 1.05) * o.horizon;
      out.push('<rect x="0" y="' + n(y0) + '" width="' + W + '" height="' + n(y1 - y0 + 1) + '" fill="' + b[1] + '"/>');
    });
    // sun disc, low, half behind the stand
    if (dir === -1) out.push('<circle cx="' + n(o.sunX * W) + '" cy="' + n(o.horizon - o.sunR * W * 0.18) + '" r="' + n(o.sunR * W) + '" fill="' + C.sun + '"/>');

    // stand with a crowd set as rows of dots (a halftone, not faces)
    var sz = 21, st = P(0, 5.4, sz)[1], sb = P(0, 0, sz)[1], ss = S(sz);
    out.push('<rect x="0" y="' + n(st) + '" width="' + W + '" height="' + n(sb - st + 1) + '" fill="' + C.stand + '"/>');
    var crowd = [C.coral, C.peach, C.rose, C.cream, C.plum, C.coral, C.rose];
    for (var r = 0; r < 6; r++) {
      for (var cx = -40; cx <= 40; cx += 0.82) {
        var k = Math.abs(Math.round(cx * 97 + r * 131)) % 11;
        if (k === 3) continue; // an empty seat now and then
        var p = P(cx + (r % 2) * 0.41, 0.95 + r * 0.74, sz);
        if (p[0] < -10 || p[0] > W + 10) continue;
        out.push('<circle cx="' + n(p[0]) + '" cy="' + n(p[1]) + '" r="' + n(0.27 * ss) + '" fill="' + crowd[k % crowd.length] + '"/>');
      }
    }
    out.push('<rect x="0" y="' + n(st - 0.25 * ss) + '" width="' + W + '" height="' + n(0.5 * ss) + '" fill="' + C.ink + '"/>');

    // ground and court
    out.push('<rect x="0" y="' + n(sb) + '" width="' + W + '" height="' + n(H - sb + 2) + '" fill="' + C.ground + '"/>');
    out.push(ground(-5.485, -11.885, 5.485, 11.885, C.teal));

    // lines, drawn at true width so they thin with distance
    var lw = 0.11, L = C.cream;
    function lz(x, z1, z2) { out.push(ground(x - lw / 2, z1, x + lw / 2, z2, L)); }
    function lx(z, x1, x2, w) { out.push(ground(x1, z - (w || lw) / 2, x2, z + (w || lw) / 2, L)); }
    lz(-5.485, -11.885, 11.885); lz(5.485, -11.885, 11.885);
    lz(-4.115, -11.885, 11.885); lz(4.115, -11.885, 11.885);
    lz(0, -6.4, 6.4);
    lx(-11.885, -5.54, 5.54, 0.2); lx(11.885, -5.54, 5.54, 0.2);
    lx(-6.4, -4.115, 4.115); lx(6.4, -4.115, 4.115);
    lz(0, -11.885, -11.55); lz(0, 11.55, 11.885);

    // floodlights: four masts, lamps part lit (warming up)
    var masts = o.masts || [[-11, 16], [11, 16], [-12.5, 5], [12.5, 5]], mh = 9.5;
    var shade = ' fill-opacity="0.3"';
    masts.forEach(function (m) {
      out.push(ground(m[0] - 0.22, m[1], m[0] + 0.22, m[1] + dir * 15, C.ink, shade));
    });

    function shadowOf(pl, len) {
      var a = P(pl.x - 0.36, 0, pl.z), b = P(pl.x + 0.36, 0, pl.z), c = P(pl.x + 0.5, 0, pl.z + dir * len), d = P(pl.x - 0.3, 0, pl.z + dir * len);
      return poly([a, b, c, d], C.ink, shade);
    }
    function player(pl) {
      var b = P(pl.x, 0, pl.z), s = S(pl.z), h = 1.75 * s, w = 0.72 * s, id = 'rrc' + (++uid), side = pl.side || 1;
      var x0 = b[0] - w / 2, y0 = b[1] - h, g = [];
      // oversized racket: handle then head
      var hx = b[0] + side * 0.3 * s, hy = b[1] - 0.98 * s, ex = b[0] + side * 0.78 * s, ey = b[1] - (pl.cheer ? 1.75 : 1.4) * s;
      var cx = b[0] + side * (pl.cheer ? 0.98 : 1.08) * s, cy = b[1] - (pl.cheer ? 2.25 : 1.8) * s, sw = Math.max(3, 0.075 * s);
      g.push('<line x1="' + n(hx) + '" y1="' + n(hy) + '" x2="' + n(ex) + '" y2="' + n(ey) + '" stroke="' + C.ink + '" stroke-width="' + n(sw * 1.5) + '" stroke-linecap="round"/>');
      g.push('<ellipse cx="' + n(cx) + '" cy="' + n(cy) + '" rx="' + n(0.33 * s) + '" ry="' + n(0.43 * s) + '" transform="rotate(' + (side * (pl.cheer ? 14 : 30)) + ' ' + n(cx) + ' ' + n(cy) + ')" fill="' + C.ink + '" fill-opacity="0.28" stroke="' + C.cream + '" stroke-width="' + n(sw) + '"/>');
      g.push('<clipPath id="' + id + '"><rect x="' + n(x0) + '" y="' + n(y0) + '" width="' + n(w) + '" height="' + n(h) + '" rx="' + n(w / 2) + '"/></clipPath>');
      g.push('<g clip-path="url(#' + id + ')"><rect x="' + n(x0) + '" y="' + n(y0) + '" width="' + n(w) + '" height="' + n(h) + '" fill="' + pl.color + '"/>');
      if (pl.hoop) [0.44, 0.58, 0.72].forEach(function (t) { g.push('<rect x="' + n(x0) + '" y="' + n(y0 + t * h) + '" width="' + n(w) + '" height="' + n(0.07 * h) + '" fill="' + C.ink + '"/>'); });
      g.push('<rect x="' + n(x0) + '" y="' + n(y0 + 0.13 * h) + '" width="' + n(w) + '" height="' + n(0.08 * h) + '" fill="' + C.cream + '"/></g>');
      return g.join('');
    }

    // shadows first (they lie on the court), then far player, net, ball, near player
    if (o.far) out.push(shadowOf(o.far, 4.2));
    if (o.near) out.push(shadowOf(o.near, dir === -1 ? 3.2 : 4.2));
    out.push(ground(-6.4, 0, 6.4, dir * 1.5, C.ink, shade));
    if (o.mark) { var mk = P(o.mark.x, 0, o.mark.z), ms = S(o.mark.z); out.push('<ellipse cx="' + n(mk[0]) + '" cy="' + n(mk[1]) + '" rx="' + n(0.55 * ms) + '" ry="' + n(0.2 * ms) + '" fill="none" stroke="' + C.cream + '" stroke-width="3"/>'); }

    function ball() {
      var bl = o.ball; if (!bl) return '';
      var p = P(bl.x, bl.y, bl.z), g = P(bl.x, 0, bl.z + dir * bl.y * 0.9), r = Math.max(8, 0.17 * S(bl.z));
      return '<ellipse cx="' + n(g[0]) + '" cy="' + n(g[1]) + '" rx="' + n(r * 1.15) + '" ry="' + n(r * 0.42) + '" fill="' + C.ink + '"' + shade + '/>' +
        '<circle cx="' + n(p[0]) + '" cy="' + n(p[1]) + '" r="' + n(r) + '" fill="' + C.ball + '"/>';
    }

    if (o.far) out.push(player(o.far));
    if (o.ball && o.ball.z > 0) out.push(ball());

    // net
    var nl = P(-6.4, 1.07, 0), nc = P(0, 0.914, 0), nr = P(6.4, 1.07, 0), nbl = P(-6.4, 0, 0), nbr = P(6.4, 0, 0), ns = S(0);
    out.push(poly([nl, nc, nr, nbr, nbl], C.ink, ' fill-opacity="0.5"'));
    for (var mx = -6; mx <= 6; mx += 0.6) {
      var t = P(mx, 0.92 + 0.15 * Math.abs(mx) / 6.4, 0), bb = P(mx, 0, 0);
      out.push('<line x1="' + n(t[0]) + '" y1="' + n(t[1]) + '" x2="' + n(bb[0]) + '" y2="' + n(bb[1]) + '" stroke="' + C.cream + '" stroke-opacity="0.16" stroke-width="1.5"/>');
    }
    out.push('<polyline points="' + [nl, nc, nr].map(function (q) { return n(q[0]) + ',' + n(q[1]); }).join(' ') + '" fill="none" stroke="' + C.cream + '" stroke-width="' + n(Math.max(4, 0.11 * ns)) + '"/>');
    [[nl, nbl], [nr, nbr]].forEach(function (q) { out.push('<line x1="' + n(q[0][0]) + '" y1="' + n(q[0][1] - 0.05 * ns) + '" x2="' + n(q[1][0]) + '" y2="' + n(q[1][1]) + '" stroke="' + C.ink + '" stroke-width="' + n(Math.max(4, 0.13 * ns)) + '"/>'); });

    // masts stand in front of the far court, behind the near player
    masts.forEach(function (m, i) {
      var s = S(m[1]), base = P(m[0], 0, m[1]), top = P(m[0], mh, m[1]), pw = Math.max(4, 0.3 * s), hw = 2.7 * s, hh = 1.35 * s;
      out.push('<rect x="' + n(base[0] - pw / 2) + '" y="' + n(top[1]) + '" width="' + n(pw) + '" height="' + n(base[1] - top[1]) + '" fill="' + C.ink + '"/>');
      out.push('<rect x="' + n(top[0] - hw / 2) + '" y="' + n(top[1] - hh) + '" width="' + n(hw) + '" height="' + n(hh) + '" fill="' + C.ink + '"/>');
      for (var a = 0; a < 4; a++) for (var b2 = 0; b2 < 2; b2++) {
        var lit = (a + b2 * 3 + i) % 4 !== 0, cw = hw / 4, ch = hh / 2, pad = Math.max(1.5, cw * 0.14);
        out.push('<rect x="' + n(top[0] - hw / 2 + a * cw + pad) + '" y="' + n(top[1] - hh + b2 * ch + pad) + '" width="' + n(cw - 2 * pad) + '" height="' + n(ch - 2 * pad) + '" fill="' + (lit ? C.cream : C.coral) + '"/>');
      }
    });

    if (o.ball && o.ball.z <= 0) out.push(ball());
    if (o.near) out.push(player(o.near));

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">' + out.join('') + '</svg>';
  }

  function init() {
    document.querySelectorAll('[data-court]').forEach(function (el) {
      var o = PRESETS[el.getAttribute('data-court')] || PRESETS.match;
      el.innerHTML = draw(o);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
