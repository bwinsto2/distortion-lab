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

  // All participant-facing text (menus, alignment instructions, tutorial) is drawn at 1.5x the original size.
  var TEXT_SCALE = 1.5;
  function menuFont(ppdCss) { return TEXT_SCALE * Math.max(9, Math.min(30, 0.17 * ppdCss)); }
  /** Split `text` into lines no wider than maxW with the current ctx.font (words are never broken). */
  function wrap(ctx, text, maxW) {
    if (!maxW || ctx.measureText(text).width <= maxW) return [text];
    var words = String(text).split(' '), out = [], line = '';
    words.forEach(function (w) {
      var t = line ? line + ' ' + w : w;
      if (line && ctx.measureText(t).width > maxW) { out.push(line); line = w; } else line = t;
    });
    if (line) out.push(line);
    return out;
  }

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
   * state: {reference, recon, layout}; W,H in CSS px; scale maps the stimulus window's CSS px to drawn CSS px (1 in the stimulus window).
   * layout.ppd is in physical screen pixels per degree (as PsychoPy's deg2pix with the monitor profile). It is turned into
   * CSS px per degree here by dividing by the stimulus window's devicePixelRatio (opts.pixelRatio; defaults to dpr, which
   * is the stimulus window's own ratio when drawing there). Without this, desktop scaling (e.g. 150%) enlarges everything.
   */
  function cssLayout(state, pixelRatio) {
    var pr = pixelRatio > 0 ? pixelRatio : 1, L = {};
    Object.keys(state.layout).forEach(function (k) { L[k] = state.layout[k]; });
    L.ppd = state.layout.ppd / pr;
    var out = {}; Object.keys(state).forEach(function (k) { out[k] = state[k]; });
    out.layout = L;
    return out;
  }
  function drawDisplay(ctx, W, H, dpr, state, opts) {
    opts = opts || {};
    state = cssLayout(state, opts.pixelRatio || dpr);
    var L = state.layout, scale = opts.scale || 1, now = opts.now || 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = 'rgb(128,128,128)';
    ctx.fillRect(0, 0, W, H);
    if (state.tutorial) return drawTutorial(ctx, W, H, dpr, state, opts);
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
    if (task) {
      var adjSide = task.adjEye === 'AE' ? aeSide : feSide, other = adjSide === 'left' ? 'right' : 'left';
      if (task.check) roles[other] = 'reconstruction';
      else { roles[adjSide] = 'reconstruction'; if (task.standard === 'other') roles[other] = 'reference'; }
      ['left', 'right'].forEach(function (sd) { if (!shown(sd)) delete roles[sd]; });
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
    // Text always goes to the fellow eye's half, whichever eye is being shown or adjusted (at the fellow eye's
    // position, which fuses with the amblyopic eye's picture).
    var fs = menuFont(L.ppd * scale), fc = centers[feSide];
    var maxW = 2 * Math.min(fc[0] - (feSide === 'left' ? 0 : W / 2), (feSide === 'left' ? W / 2 : W) - fc[0]) - 2 * fs;
    if (!task && view && view.ring) {
      var half = dCss / 2;
      if (feOn) { var ext = drawRing(ctx, fc[0], fc[1], dCss, dpr, geom, view.ring, feSide, W, H, fs); info.ringScale = ext.k; half = ext.half; }
      if (view.overlay) drawOverlay(ctx, fc[0], fc[1], half, fs, view.overlay, maxW);
    } else if (view && view.overlay) drawOverlay(ctx, fc[0], fc[1], dCss / 2, fs, view.overlay, maxW);
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
    '0: reset position, contrast and both rotations.', 'Enter: accept.',
    'Mouse: scroll = apart / together · click = accept.', 'Shift + scroll = up / down.'];
  /**
   * Alignment instructions in box coordinates (origin = box centre). The text is wrapped to the inside of the box and
   * fills the space above the nonius first, then below it; if it still does not fit, the font shrinks (not below 2/3).
   */
  function alignText(ctx, deg, L, align, size) {
    var lines = ALIGN_TEXT.concat(['Rotating: ' + (align.selected ? align.selected.toUpperCase() : 'select L or R'),
      'Left: ' + (L.rotLeft >= 0 ? '+' : '') + L.rotLeft + '°   Right: ' + (L.rotRight >= 0 ? '+' : '') + L.rotRight + '° (CW +)']);
    var inner = deg(L.boxSize / 2 - 0.6), clear = deg(BORDER.crossLen / 2 + 0.5), minSize = size * 2 / 3, rows, lh, cap;
    for (;;) {
      ctx.font = Math.round(size) + 'px sans-serif';
      rows = [];
      lines.forEach(function (t) { wrap(ctx, t, 2 * inner).forEach(function (r) { rows.push(r); }); });
      lh = size * 1.3;
      cap = 2 * Math.floor((inner - clear) / lh);
      if (rows.length <= cap || size <= minSize) break;
      size = Math.max(minSize, size * 0.92);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var above = Math.min(rows.length, Math.floor(cap / 2)), below = rows.length - above;
    if (below > cap / 2) { above = rows.length - Math.floor(cap / 2); below = rows.length - above; }
    rows.slice(0, above).forEach(function (r, i) { ctx.fillText(r, 0, -clear - (above - i - 0.5) * lh); });
    rows.slice(above).forEach(function (r, i) { ctx.fillText(r, 0, clear + (i + 0.5) * lh); });
    ctx.textBaseline = 'alphabetic';
  }
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
        // Menu in the fellow eye's half, at the adjustable picture's place (so it surrounds it after fusion).
        if (view && view.overlay) menu = { side: feSide, x: xOf(adjSide) };
        info.task = { adjSide: adjSide, roles: { left: roles.left || null, right: roles.right || null } };
      } else if (view && view.ring) {
        // Choose: test grating at the fixation point for the amblyopic eye, the ring around it for the fellow eye.
        if (shown(aeSide)) { roles[aeSide] = 'reference'; items[aeSide].push({ role: 'reference', x: 0, slot: true }); }
        if (shown(feSide)) ring = view.ring;
        if (view.overlay) menu = { side: feSide, ring: true };
        fixation = false;
      } else if (view || L.comparison === 'simultaneous') {
        if (shown(aeSide)) { roles[aeSide] = 'reference'; items[aeSide].push({ role: 'reference', x: aeX }); }
        if (shown(feSide)) { roles[feSide] = 'reconstruction'; items[feSide].push({ role: 'reconstruction', x: feX }); }
        if (view && view.overlay) menu = { side: feSide, x: feX };
      } else {
        info.showing = showingAt(L, opts.timing, opts.now || 0);
        var cs = L.comparisonSide;
        if (shown(cs)) { roles[cs] = info.showing; items[cs].push({ role: info.showing, x: xOf(cs) }); }
      }
      if (!off) fixation = fixation && false;     // nothing to fixate between when stimuli sit on the fixation point
    }
    var fs = menuFont(L.ppd * scale);
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
        // In Choose, the test grating sits in the ring's empty centre slot: draw it at the ring's picture size.
        var di = it.slot ? dCss * ringScale(dCss, deg(L.boxSize) * 0.98, deg(L.boxSize) - 6 * fs) : dCss;
        var ni = it.slot ? Math.max(8, Math.ceil(di * dpr)) : n;
        var img = it.role === 'reference' ? referenceCanvas(state.reference, ni, geom) : rasterCanvas(state.recon, ni, geom);
        ctx.drawImage(img, deg(it.x) - di / 2, -di / 2, di, di);
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
        ctx.fillStyle = black;
        alignText(ctx, deg, L, align, TEXT_SCALE * Math.max(9, deg(0.4)));
      }
      if (menu && menu.side === side) {
        var inner = deg(L.boxSize / 2 - 0.6);
        if (menu.ring) drawOverlay(ctx, 0, 0, menu.half || deg(L.boxSize) / 3, fs, view.overlay, 2 * inner);
        else drawOverlay(ctx, deg(menu.x), 0, dCss / 2, fs, view.overlay, 2 * Math.max(inner / 2, inner - Math.abs(deg(menu.x))));
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

  /**
   * Participant controls tutorial (state.tutorial, built by DLTutorial in the console). Both eyes get the same fusion
   * box and the same text at the same place in their box, so the text is always seen (and fuses) whichever eye is
   * used; practice pictures go to both eyes except in the "switch eye" step. Box positions and rotations are the
   * calibrated ones (fusion-box layout) or the plain-layout centres.
   * tutorial: {title, section, progress, text: [..], how, feedback: {text, ok}|null, scene: {...}}
   */
  var TUT_RING_GAP = 1.35;     // the tutorial's ring is smaller (text takes room), so keep its pictures clearly apart
  function drawTutorial(ctx, W, H, dpr, state, opts) {
    var L = state.layout, T = state.tutorial, sc = T.scene || {}, scale = opts.scale || 1, ppd = L.ppd * scale;
    var deg = function (v) { return v * ppd; }, geom = geomOf(L);
    var box = L.fusionBox ? L.boxSize : Math.min(15, (W / 2) / ppd * 0.9, H / ppd * 0.9);
    var aeSide = L.referenceSide, feSide = aeSide === 'left' ? 'right' : 'left';
    var dx = sc.kind === 'align' ? sc.dx || 0 : 0, dy = sc.kind === 'align' ? sc.dy || 0 : 0;
    var centers = L.fusionBox ?
      { left: [W / 2 - deg(L.boxSepX + dx), H / 2 + deg(L.boxSepY + dy)], right: [W / 2 + deg(L.boxSepX + dx), H / 2 - deg(L.boxSepY + dy)] } :
      { left: [W * (0.5 - L.separation / 200) - deg(dx), H / 2 + deg(dy)], right: [W * (0.5 + L.separation / 200) + deg(dx), H / 2 + L.vertical * scale - deg(dy)] };
    // Tutorial text is twice the in-task menu size (about 0.5 deg at 100 cm); the practice setting list is 0.9x that.
    var fs = 2 * menuFont(ppd), mfs = 0.9 * fs, inner = deg(box / 2 - 0.6), maxW = 2 * inner;
    var dCss = Math.min(L.diameter, 4.5) * ppd, n = Math.max(8, Math.min(2048, Math.ceil(dCss * dpr)));
    var info = { n: n, diameterCss: dCss, roles: {}, tutorial: true, warnings: [] };
    ['left', 'right'].forEach(function (side) {
      var c = centers[side], x0 = side === 'left' ? 0 : W / 2, eye = side === aeSide ? 'AE' : 'FE';
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, 0, W / 2, H); ctx.clip();
      ctx.translate(c[0], c[1]);
      if (L.fusionBox) ctx.rotate((side === 'left' ? L.rotLeft : L.rotRight) * Math.PI / 180);
      borderPieces(box).forEach(function (p, i) {
        ctx.fillStyle = i % 2 === 0 ? '#000' : '#fff';
        ctx.fillRect(deg(p[0] - p[2] / 2), -deg(p[1] + p[3] / 2), deg(p[2]), deg(p[3]));
      });
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      // ---- top: progress, title, instructions
      var y = -inner + fs * 0.9;
      ctx.fillStyle = 'rgb(60,60,60)'; ctx.font = Math.round(fs * 0.8) + 'px sans-serif';
      if (T.progress) { ctx.fillText(T.progress + (T.section ? ' · ' + T.section : ''), 0, y); y += fs * 1.3; }
      ctx.fillStyle = 'rgb(20,20,20)'; ctx.font = '700 ' + Math.round(fs * 1.15) + 'px sans-serif';
      wrap(ctx, T.title || '', maxW).forEach(function (t) { ctx.fillText(t, 0, y + fs * 0.3); y += fs * 1.4; });
      y += fs * 0.2;
      ctx.fillStyle = 'rgb(30,30,30)'; ctx.font = Math.round(fs) + 'px sans-serif';
      (T.text || []).forEach(function (para) { wrap(ctx, para, maxW).forEach(function (t) { ctx.fillText(t, 0, y + fs * 0.3); y += fs * 1.25; }); y += fs * 0.3; });
      var top = y;
      // ---- bottom: what to do, and feedback
      var yb = inner - fs * 0.4, bottom, reserve = 2 * fs * 1.35 + fs * 0.7 + fs * 0.5;
      if (T.feedback && T.feedback.text) {
        ctx.font = '700 ' + Math.round(fs * 1.1) + 'px sans-serif';
        var fl = wrap(ctx, T.feedback.text, maxW - 2 * fs), bh = fl.length * fs * 1.35 + fs * 0.7;
        var bw = Math.min(maxW, Math.max.apply(null, fl.map(function (t) { return ctx.measureText(t).width; })) + 2 * fs);
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(-bw / 2, yb - bh, bw, bh);
        ctx.strokeStyle = T.feedback.ok ? 'rgb(0,110,0)' : 'rgb(170,0,0)'; ctx.lineWidth = Math.max(2, fs * 0.15); ctx.strokeRect(-bw / 2, yb - bh, bw, bh);
        ctx.fillStyle = T.feedback.ok ? 'rgb(0,105,0)' : 'rgb(165,0,0)';
        fl.forEach(function (t, i) { ctx.fillText(t, 0, yb - bh + fs * 0.35 + (i + 0.85) * fs * 1.35); });
        yb -= Math.max(bh + fs * 0.5, reserve);
      } else yb -= reserve;
      if (T.how) {
        ctx.font = '700 ' + Math.round(fs) + 'px sans-serif'; ctx.fillStyle = 'rgb(10,10,10)';
        var hl = wrap(ctx, T.how, maxW);
        hl.forEach(function (t, i) { ctx.fillText(t, 0, yb - (hl.length - 1 - i) * fs * 1.3); });
        yb -= hl.length * fs * 1.3 + fs * 0.3;
      }
      bottom = yb;
      // ---- middle: the practice scene, centred in what is left
      var mid = (top + bottom) / 2, room = Math.max(fs * 4, bottom - top);
      var showPic = sc.kind !== 'eye' || sc.eye === 'both' || sc.eye === eye;
      if (sc.kind === 'align') {
        var len = deg(BORDER.crossLen), th = Math.max(1, deg(BORDER.crossThick));
        ctx.fillStyle = '#000';
        if (side === 'left') ctx.fillRect(-len / 2, mid - th / 2, len, th); else ctx.fillRect(-th / 2, mid - len / 2, th, len);
        ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1.5, deg(0.05));
        ctx.beginPath(); ctx.arc(0, mid, len / 2, 0, 2 * Math.PI); ctx.stroke();
      } else if (sc.kind === 'ring' && side === feSide) {
        var ext = drawRing(ctx, 0, mid, dCss, dpr, geom, sc.ring, side, W, H, fs, { w: maxW, h: room, minGap: TUT_RING_GAP });
        info.ringScale = ext.k;
      } else if (sc.kind === 'ring' && side === aeSide) {
        // Same size as the ring's pictures, so it sits in the empty centre slot as in the real Choose screen.
        var dr = dCss * ringScale(dCss, maxW, room, TUT_RING_GAP), nr = Math.max(8, Math.ceil(dr * dpr));
        ctx.drawImage(referenceCanvas(state.reference, nr, geom), -dr / 2, mid - dr / 2, dr, dr);
      } else if ((sc.kind === 'picture' || sc.kind === 'eye') && showPic) {
        var dd = Math.min(dCss, room - (sc.lines ? sc.lines.length * mfs * 2.2 : 0) - (sc.button ? fs * 3.6 : 0) - (sc.caption ? fs * 1.4 : 0) - fs * 0.5);
        var py = sc.lines ? top + dd / 2 + fs * 0.5 : (sc.button ? mid - fs * 1.6 + (sc.caption ? fs * 0.7 : 0) : mid + (sc.caption ? fs * 0.7 : 0));
        ctx.drawImage(rasterCanvas(state.recon, Math.max(8, Math.ceil(dd * dpr)), geom), -dd / 2, py - dd / 2, dd, dd);
        if (sc.caption) { ctx.font = '600 ' + Math.round(fs) + 'px sans-serif'; ctx.fillStyle = 'rgb(20,20,20)'; ctx.fillText(sc.caption, 0, py - dd / 2 - fs * 0.5); }
        if (sc.lines && side === feSide) drawOverlay(ctx, 0, py, dd / 2, mfs, { lines: sc.lines }, maxW);
        if (sc.button) {           // on-screen button (tutorial only), in both eyes so it fuses; reported in degrees for hit-testing
          var bw = fs * 5, bh = fs * 1.9, by = py + dd / 2 + fs * 0.7 + bh / 2, cur = opts.cursor;
          var hover = cur && Math.abs(deg(cur.x)) <= bw / 2 && Math.abs(deg(cur.y) - by) <= bh / 2;
          ctx.fillStyle = hover ? 'rgb(255,255,255)' : 'rgb(225,225,225)'; ctx.fillRect(-bw / 2, by - bh / 2, bw, bh);
          ctx.strokeStyle = 'rgb(20,20,20)'; ctx.lineWidth = Math.max(2, fs * (hover ? 0.22 : 0.12)); ctx.strokeRect(-bw / 2, by - bh / 2, bw, bh);
          ctx.fillStyle = 'rgb(10,10,10)'; ctx.font = '700 ' + Math.round(fs * 1.1) + 'px sans-serif'; ctx.textBaseline = 'middle';
          ctx.fillText(sc.button, 0, by); ctx.textBaseline = 'alphabetic';
          info.tutorialButton = { x: 0, y: by / ppd, w: bw / ppd, h: bh / ppd, hover: !!hover };
        }
      } else if (sc.kind === 'eye' && !showPic) {
        ctx.strokeStyle = 'rgb(100,100,100)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.arc(0, mid, dCss / 2, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
      }
      if (sc.button && opts.cursor) {      // the tutorial's own arrow (the system pointer is locked and hidden)
        var ax = deg(opts.cursor.x), ay = deg(opts.cursor.y), a = fs * 1.1;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax, ay + a); ctx.lineTo(ax + a * 0.28, ay + a * 0.74); ctx.lineTo(ax + a * 0.48, ay + a * 1.12);
        ctx.lineTo(ax + a * 0.62, ay + a * 1.05); ctx.lineTo(ax + a * 0.43, ay + a * 0.68); ctx.lineTo(ax + a * 0.72, ay + a * 0.68); ctx.closePath();
        ctx.fillStyle = '#000'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1.5, fs * 0.1); ctx.stroke();
      }
      if (sc.kind === 'eye' && side === feSide) {
        ctx.font = '700 ' + Math.round(fs * 1.1) + 'px sans-serif'; ctx.fillStyle = 'rgb(20,20,20)';
        ctx.fillText(sc.label || '', 0, mid + dCss / 2 + fs * 1.6);
      }
      if (sc.kind === 'mode' && side === feSide) {
        var modes = ['CHOOSE', 'ADJUST', 'COMPARE'], gap = Math.min(maxW / 3, fs * 7);
        modes.forEach(function (m, i) {
          var mx = (i - 1) * gap, on = m === sc.mode;
          ctx.font = (on ? '700 ' : '') + Math.round(on ? fs * 1.2 : fs) + 'px sans-serif';
          ctx.fillStyle = on ? 'rgb(10,10,10)' : 'rgb(85,85,85)'; ctx.fillText(m, mx, mid);
          if (on) { ctx.strokeStyle = 'rgb(10,10,10)'; ctx.lineWidth = Math.max(2, fs * 0.12); ctx.strokeRect(mx - gap * 0.46, mid - fs * 1.2, gap * 0.92, fs * 1.8); }
          if (i < 2) { ctx.fillStyle = 'rgb(85,85,85)'; ctx.font = Math.round(fs) + 'px sans-serif'; ctx.fillText('→', mx + gap / 2, mid); }
        });
      }
      ctx.restore();
    });
    return info;
  }

  // Ring of 8 options around the (empty) fellow-eye centre, clockwise from top-left, so that with both eyes
  // the amblyopic-eye test grating fuses into the middle (as in Maruya et al.'s dichoptic choice display).
  // Pictures are spaced RING_GAP..RING_GAP_MAX diameters apart (centre to centre): as far apart as the space allows, so
  // that after fusion the amblyopic eye's centre picture and the ring's pictures do not run into each other.
  var RING = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]], RING_GAP = 1.15, RING_GAP_MAX = 1.5;
  /** Size factor of the ring's pictures (and of the empty centre slot) when the ring must fit in availW x availH. */
  function ringScale(dCss, availW, availH, minGap) {
    var g = minGap || RING_GAP;
    return Math.max(0.25, Math.min(1, availW / (3 * g * dCss), availH / (3 * g * dCss)));
  }
  function ringGap(d, availW, availH, minGap) { return Math.max(minGap || RING_GAP, Math.min(RING_GAP_MAX, availW / (3 * d), availH / (3 * d))); }
  function drawRing(ctx, x, y, dCss, dpr, geom, ring, side, W, H, fs, avail) {
    var x0 = side === 'left' ? 0 : W / 2, x1 = side === 'left' ? W / 2 : W;
    var availW = avail ? avail.w : 2 * Math.min(x - x0, x1 - x), availH = avail ? avail.h : 2 * Math.min(y, H - y) - 6 * fs;
    var mg = avail && avail.minGap, k = ringScale(dCss, availW, availH, mg), gap = ringGap(dCss * k, availW, availH, mg);
    var d = dCss * k, step = d * gap, n = Math.max(8, Math.min(1024, Math.ceil(d * dpr)));
    RING.forEach(function (o, i) {
      var cx = x + o[0] * step, cy = y + o[1] * step, it = ring.items[i];
      if (it && it.recon) ctx.drawImage(rasterCanvas(it.recon, n, geom), cx - d / 2, cy - d / 2, d, d);
      else if (it && it.none) {
        ctx.strokeStyle = 'rgb(72,72,72)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, d / 2 - 2, 0, 2 * Math.PI); ctx.stroke();
        ctx.fillStyle = 'rgb(40,40,40)'; ctx.font = '600 ' + Math.round(fs) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('None of', cx, cy - fs * 0.6); ctx.fillText('these', cx, cy + fs * 0.6); ctx.textBaseline = 'alphabetic';
      }
      if (i === ring.target) {                 // tutorial: the picture to move the highlight to
        ctx.save(); ctx.strokeStyle = 'rgb(0,0,0)'; ctx.lineWidth = Math.max(2, fs * 0.18); ctx.setLineDash([fs * 0.5, fs * 0.4]);
        ctx.beginPath(); ctx.arc(cx, cy, d / 2 + Math.max(8, fs * 0.9), 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
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
  function drawOverlay(ctx, x, y, r, fs, ov, maxW) {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    var dim = 'rgb(56,56,56)', faint = 'rgb(80,80,80)', strong = 'rgb(28,28,28)';
    if (ov.title) {
      ctx.font = '600 ' + Math.round(fs * 0.9) + 'px sans-serif'; ctx.fillStyle = dim;
      var tl = wrap(ctx, ov.title, maxW);
      tl.forEach(function (t, i) { ctx.fillText(t, x, y - r - fs * 0.9 - (tl.length - 1 - i) * fs * 1.15); });
    }
    var ty = y + r + fs * 1.6;
    (ov.lines || []).forEach(function (l) {
      ctx.font = (l.strong ? '600 ' : '') + Math.round(l.faint ? fs * 0.85 : fs) + 'px sans-serif';
      ctx.fillStyle = l.faint ? faint : (l.strong ? strong : dim);
      wrap(ctx, l.text, maxW).forEach(function (t, i) { if (i) ty += fs * 1.15; ctx.fillText(t, x, ty); });
      if (typeof l.bar === 'number') {
        var w = Math.min(maxW || Infinity, Math.max(r * 1.6, 60)), h = Math.max(4, fs * 0.35), bx = x - w / 2, by = ty + fs * 0.45;
        ctx.strokeStyle = dim; ctx.lineWidth = Math.max(1, fs * 0.06); ctx.strokeRect(bx, by, w, h);
        ctx.fillStyle = dim; ctx.fillRect(bx, by, w * Math.max(0, Math.min(1, l.bar)), h);
        if (typeof l.target === 'number') {      // tutorial: where the bar should end
          var tx = bx + w * Math.max(0, Math.min(1, l.target));
          ctx.fillStyle = 'rgb(0,0,0)'; ctx.fillRect(tx - Math.max(1.5, fs * 0.08), by - h * 0.9, Math.max(3, fs * 0.16), h * 2.8);
        }
        ty += h + fs * 0.6;
      }
      ty += fs * 1.35;
    });
    if (ov.status) {
      ctx.font = '600 ' + Math.round(fs) + 'px sans-serif'; ctx.fillStyle = strong;
      wrap(ctx, ov.status, maxW).forEach(function (t, i) { ctx.fillText(t, x, ty + fs * 0.3 + i * fs * 1.15); });
    }
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

  root.DLDraw = { wrap: wrap, menuFont: menuFont, TEXT_SCALE: TEXT_SCALE, rasterCanvas: rasterCanvas, referenceCanvas: referenceCanvas, drawSingle: drawSingle, drawDisplay: drawDisplay, singlePNG: singlePNG, geomOf: geomOf, showingAt: showingAt };
})(typeof self !== 'undefined' ? self : this);
