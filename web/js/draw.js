/*
 * Canvas helpers shared by the console (index.html) and the stimulus window
 * (stimulus.html). All pixel values come from DLCore renderers; this file only
 * caches rasters and places them according to the optical layout.
 */
(function (root) {
  'use strict';
  var C = root.DLCore;
  var cache = new Map();
  var MAX_CACHE = 300;

  function geomOf(layout) { return { diameter: layout.diameter, sigma: layout.sigma, aperture: layout.aperture }; }

  function rasterCanvas(recon, n, geom) {
    var key = JSON.stringify([recon, n, geom.diameter, geom.sigma, geom.aperture]);
    var hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
    var c = document.createElement('canvas');
    c.width = c.height = n;
    c.getContext('2d').putImageData(new ImageData(C.renderRecon(recon, n, geom), n, n), 0, 0);
    cache.set(key, c);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return c;
  }
  function referenceCanvas(reference, n, geom) { return rasterCanvas(C.referenceRecon(reference), n, geom); }

  /** Draw a single stimulus filling `canvas` (device pixels = canvas.width). */
  function drawSingle(canvas, recon, geom) {
    var n = canvas.width, ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = 'rgb(128,128,128)';
    ctx.fillRect(0, 0, n, canvas.height);
    ctx.drawImage(rasterCanvas(recon, n, geom), 0, 0);
  }

  function showingAt(layout, timing, now) {
    if (layout.comparison === 'toggle') return layout.toggleShowing;
    var t0 = (timing && timing.seqStart) || 0;
    return Math.floor((now - t0) / layout.sequenceMs) % 2 === 0 ? 'reference' : 'reconstruction';
  }

  /**
   * Compose the stimulus display.
   * state: {reference, recon, layout}; W,H in CSS px; scale maps nominal CSS px to drawn CSS px (1 in the stimulus window).
   */
  function drawDisplay(ctx, W, H, dpr, state, opts) {
    opts = opts || {};
    var L = state.layout, scale = opts.scale || 1, now = opts.now || 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = 'rgb(128,128,128)';
    ctx.fillRect(0, 0, W, H);
    if (L.fusionBox) return drawBoxed(ctx, W, H, dpr, state, opts);
    var dCss = L.diameter * L.ppd * scale;
    var n = Math.max(8, Math.min(2048, Math.ceil(dCss * dpr)));
    var geom = geomOf(L);
    var centers = { left: [W * (0.5 - L.separation / 200), H / 2], right: [W * (0.5 + L.separation / 200), H / 2 + L.vertical * scale] };
    var roles = {}, info = { n: n, diameterCss: dCss, showing: null, roles: roles };
    var view = state.view || null;          // participant controls: {eye: 'AE'|'FE'|'both', overlay}
    var aeSide = L.referenceSide, feSide = aeSide === 'left' ? 'right' : 'left';
    var feOn = view && (view.eye === 'FE' || view.eye === 'both');
    // Nulling task: the adjustable picture goes to the adjusted eye; the other eye sees the straight standard,
    // nothing (monocular "looks straight" criterion), or - during the other-eye check - the null stimulus itself.
    var task = state.task && state.task.kind === 'null' ? state.task : null;
    var eyeOf = function (side) { return side === aeSide ? 'AE' : 'FE'; };
    var shown = function (side) { return !view || view.eye === 'both' || view.eye === eyeOf(side); };
    var menuSide = feSide;
    if (task) {
      var adjSide = task.adjEye === 'AE' ? aeSide : feSide, other = adjSide === 'left' ? 'right' : 'left';
      if (task.check) roles[other] = 'reconstruction';
      else { roles[adjSide] = 'reconstruction'; if (task.standard === 'other') roles[other] = 'reference'; }
      ['left', 'right'].forEach(function (sd) { if (!shown(sd)) delete roles[sd]; });
      menuSide = roles[adjSide] ? adjSide : (roles[other] ? other : feSide);
      info.task = { adjSide: adjSide, roles: { left: roles.left || null, right: roles.right || null } };
    } else if (view) {
      if (view.eye === 'AE' || view.eye === 'both') roles[aeSide] = 'reference';
      if (feOn && !view.ring) roles[feSide] = 'reconstruction';
    } else if (L.comparison === 'simultaneous') {
      roles[L.referenceSide] = 'reference';
      roles[L.referenceSide === 'left' ? 'right' : 'left'] = 'reconstruction';
    } else {
      info.showing = showingAt(L, opts.timing, now);
      roles[L.comparisonSide] = info.showing;
    }
    ['left', 'right'].forEach(function (side) {
      var role = roles[side];
      var visible = role && (view ? true : (L.visibility === 'both' || L.visibility === side));
      var x = centers[side][0], y = centers[side][1];
      if (visible) {
        var img = role === 'reference' ? referenceCanvas(state.reference, n, geom) : rasterCanvas(state.recon, n, geom);
        ctx.drawImage(img, x - dCss / 2, y - dCss / 2, dCss, dCss);
        if (L.fixation) {
          ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.beginPath();
          ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); ctx.stroke();
        }
      }
      if (opts.labels) {
        var eye = L[side + 'Eye'];
        ctx.fillStyle = '#202020'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(side + (role ? ' · ' + role : ' · empty') + (eye !== 'unassigned' ? ' · ' + eye : '') + (visible ? '' : ' (hidden)'), x, Math.min(H - 4, y + dCss / 2 + 13));
      }
    });
    var fs = Math.max(9, Math.min(30, 0.17 * L.ppd * scale));
    if (task) {
      // Menu under the adjustable picture; larger when it is read by the amblyopic eye.
      if (view && view.overlay && shown(menuSide))
        drawOverlay(ctx, centers[menuSide][0], centers[menuSide][1], dCss / 2, menuSide === aeSide ? Math.min(40, fs * 1.4) : fs, view.overlay);
    } else if (feOn && view.ring) {
      var ext = drawRing(ctx, centers[feSide][0], centers[feSide][1], dCss, dpr, geom, view.ring, feSide, W, H, fs);
      info.ringScale = ext.k;
      if (view.overlay) drawOverlay(ctx, centers[feSide][0], centers[feSide][1], ext.half, fs, view.overlay);
    } else if (feOn && view.overlay) drawOverlay(ctx, centers[feSide][0], centers[feSide][1], dCss / 2, fs, view.overlay);
    info.warnings = warnings(state, W / scale, H / scale, n, centers, dCss / scale);
    return info;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Fusion-box layout (layout.fusionBox): copies FixBorders() from the lab's PsychoPy binocular battery.
  // Each eye's half shows the same 15 x 15 deg viewing area framed by alternating black/white border pieces,
  // centred +/- boxSepX deg from the screen centre (right box up / left box down by boxSepY), rotated per eye about
  // its own centre (clockwise positive) and clipped to its own half of the screen. Nonius fixation: vertical bar
  // to the right eye, horizontal bar to the left eye, and a circle touching the bar ends in both eyes.
  // Inside the box, stimuli sit side by side (sideOffset deg either side of fixation), so after fusion the test
  // and the match appear next to each other instead of on top of each other.
  var BORDER = { thick: 0.5, nX: 4, nY: 5, crossLen: 2, crossThick: 0.2 };
  function borderPieces(A) {
    var t = BORDER.thick, ex = A / BORDER.nX, ey = A / BORDER.nY, out = [], i;
    var lin = function (a, b, n) { var r = []; for (var k = 0; k < n; k++) r.push(n === 1 ? a : a + (b - a) * k / (n - 1)); return r; };
    var hx = lin(-A / 2 + ex / 2, A / 2 - ex / 2, BORDER.nX), vy = lin(-A / 2 + ey / 2, A / 2 - ey / 2, BORDER.nY);
    for (i = 0; i < hx.length; i++) out.push([hx[i], A / 2 + t / 2, ex, t]);                         // top, left to right
    for (i = vy.length - 1; i >= 0; i--) out.push([A / 2 + t / 2, vy[i], t, ey]);                     // right, top to bottom
    for (i = hx.length - 1; i >= 0; i--) out.push([hx[i], -A / 2 - t / 2, ex, t]);                    // bottom, right to left
    for (i = 0; i < vy.length; i++) out.push([-A / 2 - t / 2, vy[i], t, ey]);                         // left, bottom to top
    return out;   // [x, y, w, h] in deg, y up; colours alternate black, white, ... in this order
  }
  function grey(v) { var g = Math.round(127.5 * (1 + v)); return 'rgb(' + g + ',' + g + ',' + g + ')'; }
  var ALIGN_TEXT = ['Use arrow keys (← → ↑ ↓) to move borders.', 'Use 4 and 6 to reduce left or right eye contrast.',
    'L / R: select left / right image.', '7: rotate counterclockwise 1°; 9: clockwise 1°.',
    '0: reset position, contrast and both rotations.', 'Enter: accept.'];
  function drawBoxed(ctx, W, H, dpr, state, opts) {
    var L = state.layout, scale = opts.scale || 1, ppd = L.ppd * scale, deg = function (v) { return v * ppd; };
    var dCss = L.diameter * ppd, n = Math.max(8, Math.min(2048, Math.ceil(dCss * dpr))), geom = geomOf(L);
    var view = state.view || null, task = state.task && state.task.kind === 'null' ? state.task : null, align = state.align || null;
    var aeSide = L.referenceSide, feSide = aeSide === 'left' ? 'right' : 'left';
    var eyeOf = function (side) { return side === aeSide ? 'AE' : 'FE'; };
    var shown = function (side) { return view ? (view.eye === 'both' || view.eye === eyeOf(side)) : (L.visibility === 'both' || L.visibility === side); };
    var centers = { left: [W / 2 - deg(L.boxSepX), H / 2 + deg(L.boxSepY)], right: [W / 2 + deg(L.boxSepX), H / 2 - deg(L.boxSepY)] };
    var off = L.sideBySide ? L.sideOffset : 0, aeX = L.testSide === 'left' ? -off : off, feX = -aeX;
    var xOf = function (side) { return side === aeSide ? aeX : feX; };
    var items = { left: [], right: [] }, roles = {}, info = { n: n, diameterCss: dCss, showing: null, roles: roles, boxed: true, items: items };
    var ring = null, menu = null, fixation = !align && L.fixationStyle !== 'none';
    if (!align) {
      if (task) {
        var adjSide = task.adjEye === 'AE' ? aeSide : feSide, other = adjSide === 'left' ? 'right' : 'left';
        if (task.check) roles[other] = 'reconstruction';
        else { roles[adjSide] = 'reconstruction'; if (task.standard === 'other') roles[other] = 'reference'; }
        ['left', 'right'].forEach(function (sd) { if (!shown(sd)) delete roles[sd]; });
        // Positions: the adjustable picture at its own eye's place; the other picture at the other place.
        if (roles.left) items.left.push({ role: roles.left, x: roles.left === 'reconstruction' && task.check ? xOf(adjSide) : xOf('left') });
        if (roles.right) items.right.push({ role: roles.right, x: roles.right === 'reconstruction' && task.check ? xOf(adjSide) : xOf('right') });
        var ms = roles[adjSide] ? adjSide : (roles[other] ? other : feSide);
        if (view && view.overlay && shown(ms)) menu = { side: ms, x: items[ms].length ? items[ms][0].x : 0, big: ms === aeSide };
        info.task = { adjSide: adjSide, roles: { left: roles.left || null, right: roles.right || null } };
      } else if (view && view.ring) {
        // Choose: test grating at the fixation point for the amblyopic eye, the ring around it for the fellow eye.
        if (shown(aeSide)) { roles[aeSide] = 'reference'; items[aeSide].push({ role: 'reference', x: 0 }); }
        if (shown(feSide)) { ring = view.ring; menu = view.overlay ? { side: feSide, ring: true } : null; }
        fixation = false;
      } else if (view || L.comparison === 'simultaneous') {
        if (shown(aeSide)) { roles[aeSide] = 'reference'; items[aeSide].push({ role: 'reference', x: aeX }); }
        if (shown(feSide)) { roles[feSide] = 'reconstruction'; items[feSide].push({ role: 'reconstruction', x: feX }); }
        if (view && view.overlay && shown(feSide)) menu = { side: feSide, x: feX };
      } else {
        info.showing = showingAt(L, opts.timing, opts.now || 0);
        var cs = L.comparisonSide;
        if (shown(cs)) { roles[cs] = info.showing; items[cs].push({ role: info.showing, x: xOf(cs) }); }
      }
      if (!off) fixation = fixation && false;     // nothing to fixate between when stimuli sit on the fixation point
    }
    var fs = Math.max(9, Math.min(30, 0.17 * L.ppd * scale));
    ['left', 'right'].forEach(function (side) {
      var c = centers[side], x0 = side === 'left' ? 0 : W / 2;
      var con = align ? (side === 'left' ? L.calContrastLeft : L.calContrastRight) : 1;
      var black = grey(-con), white = grey(con);
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, 0, W / 2, H); ctx.clip();          // the midline is a hard boundary
      ctx.translate(c[0], c[1]);
      ctx.rotate((side === 'left' ? L.rotLeft : L.rotRight) * Math.PI / 180);
      // checkered border
      borderPieces(L.boxSize).forEach(function (p, i) {
        ctx.fillStyle = i % 2 === 0 ? black : white;
        ctx.fillRect(deg(p[0] - p[2] / 2), -deg(p[1] + p[3] / 2), deg(p[2]), deg(p[3]));
      });
      // stimuli
      items[side].forEach(function (it) {
        var img = it.role === 'reference' ? referenceCanvas(state.reference, n, geom) : rasterCanvas(state.recon, n, geom);
        ctx.drawImage(img, deg(it.x) - dCss / 2, -dCss / 2, dCss, dCss);
      });
      if (ring && side === feSide) {
        var ext = drawRing(ctx, 0, 0, dCss, dpr, geom, ring, side, W, H, fs, { w: deg(L.boxSize) * 0.98, h: deg(L.boxSize) - 6 * fs });
        info.ringScale = ext.k; menu && (menu.half = ext.half);
      }
      // fixation: nonius during alignment (and by default); full cross optionally
      if (align || fixation) {
        var len = deg(BORDER.crossLen), th = Math.max(1, deg(BORDER.crossThick));
        ctx.fillStyle = black;
        var horiz = align || L.fixationStyle === 'cross' || side === 'left';
        var vert = align ? side === 'right' : (L.fixationStyle === 'cross' || side === 'right');
        if (align) horiz = side === 'left';
        if (horiz) ctx.fillRect(-len / 2, -th / 2, len, th);
        if (vert) ctx.fillRect(-th / 2, -len / 2, th, len);
        ctx.strokeStyle = black; ctx.lineWidth = Math.max(1.5, deg(0.05));
        ctx.beginPath(); ctx.arc(0, 0, len / 2, 0, 2 * Math.PI); ctx.stroke();
      }
      if (align) {
        ctx.fillStyle = black; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        var th2 = Math.max(9, deg(0.4)); ctx.font = Math.round(th2) + 'px sans-serif';
        var lines = ALIGN_TEXT.concat(['Rotating: ' + (align.selected ? align.selected.toUpperCase() : 'select L or R'),
          'Left: ' + (L.rotLeft >= 0 ? '+' : '') + L.rotLeft + '°   Right: ' + (L.rotRight >= 0 ? '+' : '') + L.rotRight + '° (CW +)']);
        lines.forEach(function (t, i) { ctx.fillText(t, 0, deg(2.2) + i * th2 * 1.35); });
      }
      if (menu && menu.side === side) {
        if (menu.ring) drawOverlay(ctx, 0, 0, menu.half || deg(L.boxSize) / 3, fs, view.overlay);
        else drawOverlay(ctx, deg(menu.x), 0, dCss / 2, menu.big ? Math.min(40, fs * 1.4) : fs, view.overlay);
      }
      ctx.restore();
      if (opts.labels) {
        var eye = L[side + 'Eye'];
        ctx.fillStyle = '#202020'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(side + (roles[side] ? ' · ' + roles[side] : (ring && side === feSide ? ' · options' : ' · empty')) + (eye !== 'unassigned' ? ' · ' + eye : ''),
          c[0], Math.min(H - 4, c[1] + deg(L.boxSize / 2 + BORDER.thick) + 13));
      }
    });
    info.align = !!align;
    var w = [], f = Math.max(state.reference.frequency, C.maxFrequency(state.recon));
    if (f * L.diameter > n / 2) w.push('Highest carrier frequency exceeds the raster Nyquist limit at this size; increase pixel density or reduce frequency.');
    else if (f * L.diameter > n / 4) w.push('Fewer than four raster samples per carrier cycle; fine detail is poorly sampled.');
    var halfBox = L.boxSize / 2 + BORDER.thick;
    if ((L.boxSepX - halfBox) * ppd < 0 || (L.boxSepX + halfBox) * ppd > W / 2) w.push('The fusion box does not fit in its half of the screen: adjust box separation or size, or the pixels per degree.');
    if ((halfBox + Math.abs(L.boxSepY)) * ppd > H / 2) w.push('The fusion box is taller than the screen.');
    if (L.sideBySide && L.sideOffset + L.diameter / 2 > L.boxSize / 2) w.push('Side-by-side stimuli extend outside the fusion box: reduce the offset or the diameter.');
    if (L.sideBySide && L.fixationStyle !== 'none' && L.sideOffset - L.diameter / 2 < BORDER.crossLen / 2) w.push('Side-by-side stimuli overlap the fixation circle: increase the offset.');
    info.warnings = w;
    return info;
  }

  // Ring of 8 options around the (empty) fellow-eye centre, clockwise from top-left, so that with both eyes
  // the amblyopic-eye test grating fuses into the middle (as in Maruya et al.'s dichoptic choice display).
  var RING = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  function drawRing(ctx, x, y, dCss, dpr, geom, ring, side, W, H, fs, avail) {
    var gap = 1.15, x0 = side === 'left' ? 0 : W / 2, x1 = side === 'left' ? W / 2 : W;
    var availW = avail ? avail.w : 2 * Math.min(x - x0, x1 - x), availH = avail ? avail.h : 2 * Math.min(y, H - y) - 6 * fs;
    var k = Math.max(0.25, Math.min(1, availW / (3 * gap * dCss), availH / (3 * gap * dCss)));
    var d = dCss * k, step = d * gap, n = Math.max(8, Math.min(1024, Math.ceil(d * dpr)));
    RING.forEach(function (o, i) {
      var cx = x + o[0] * step, cy = y + o[1] * step, it = ring.items[i];
      if (it && it.recon) ctx.drawImage(rasterCanvas(it.recon, n, geom), cx - d / 2, cy - d / 2, d, d);
      else if (it && it.none) {
        ctx.strokeStyle = 'rgb(72,72,72)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, d / 2 - 2, 0, 2 * Math.PI); ctx.stroke();
        ctx.fillStyle = 'rgb(40,40,40)'; ctx.font = '600 ' + Math.round(fs) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('None of', cx, cy - fs * 0.6); ctx.fillText('these', cx, cy + fs * 0.6); ctx.textBaseline = 'alphabetic';
      }
      if (i === ring.highlight) {
        ctx.strokeStyle = 'rgb(20,20,20)'; ctx.lineWidth = Math.max(2, fs * 0.25);
        ctx.beginPath(); ctx.arc(cx, cy, d / 2 + Math.max(3, fs * 0.35), 0, 2 * Math.PI); ctx.stroke();
      }
    });
    return { k: k, half: step + d / 2 };
  }

  /**
   * In-stereoscope menu, drawn around (never over) the fellow-eye stimulus in dim grey.
   * overlay: {title, lines: [{text, faint, strong, bar: 0..1}], status}
   */
  function drawOverlay(ctx, x, y, r, fs, ov) {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    var dim = 'rgb(72,72,72)', faint = 'rgb(88,88,88)', strong = 'rgb(40,40,40)';
    if (ov.title) { ctx.font = '600 ' + Math.round(fs * 0.85) + 'px sans-serif'; ctx.fillStyle = dim; ctx.fillText(ov.title, x, y - r - fs * 0.9); }
    var ty = y + r + fs * 1.6;
    (ov.lines || []).forEach(function (l) {
      ctx.font = (l.strong ? '600 ' : '') + Math.round(l.faint ? fs * 0.85 : fs) + 'px sans-serif';
      ctx.fillStyle = l.faint ? faint : (l.strong ? strong : dim);
      ctx.fillText(l.text, x, ty);
      if (typeof l.bar === 'number') {
        var w = Math.max(r * 1.6, 60), h = Math.max(4, fs * 0.35), bx = x - w / 2, by = ty + fs * 0.45;
        ctx.strokeStyle = dim; ctx.lineWidth = 1; ctx.strokeRect(bx, by, w, h);
        ctx.fillStyle = dim; ctx.fillRect(bx, by, w * Math.max(0, Math.min(1, l.bar)), h);
        ty += h + fs * 0.6;
      }
      ty += fs * 1.35;
    });
    if (ov.status) { ctx.font = '600 ' + Math.round(fs) + 'px sans-serif'; ctx.fillStyle = strong; ctx.fillText(ov.status, x, ty + fs * 0.3); }
    ctx.restore();
  }

  function warnings(state, W, H, n, centers, d) {
    var w = [], L = state.layout;
    var f = Math.max(state.reference.frequency, C.maxFrequency(state.recon));
    if (f * L.diameter > n / 2) w.push('Highest carrier frequency exceeds the raster Nyquist limit at this size; increase pixel density or reduce frequency.');
    else if (f * L.diameter > n / 4) w.push('Fewer than four raster samples per carrier cycle; fine detail is poorly sampled.');
    if (state.recon.renderer === 'legacy-rectified' && state.recon.params.components.some(function (c) { return c.enabled && c.threshold < 0.5; }))
      w.push('Strong clipping creates harmonics that may alias even when the carrier is sampled.');
    if (L.comparison === 'simultaneous' && Math.abs((L.separation / 100) * W) < d) w.push('Stimulus panels overlap: increase separation or reduce diameter.');
    if (d > H) w.push('The stimulus is taller than the display area.');
    return w;
  }

  function canvasToPNG(canvas) { return canvas.toDataURL('image/png'); }
  function singlePNG(recon, n, geom) { var c = rasterCanvas(recon, n, geom); return canvasToPNG(c); }

  root.DLDraw = { rasterCanvas: rasterCanvas, referenceCanvas: referenceCanvas, drawSingle: drawSingle, drawDisplay: drawDisplay, singlePNG: singlePNG, geomOf: geomOf, showingAt: showingAt };
})(typeof self !== 'undefined' ? self : this);
