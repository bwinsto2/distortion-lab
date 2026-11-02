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
    var dCss = L.diameter * L.ppd * scale;
    var n = Math.max(8, Math.min(2048, Math.ceil(dCss * dpr)));
    var geom = geomOf(L);
    var centers = { left: [W * (0.5 - L.separation / 200), H / 2], right: [W * (0.5 + L.separation / 200), H / 2 + L.vertical * scale] };
    var roles = {}, info = { n: n, diameterCss: dCss, showing: null, roles: roles };
    if (L.comparison === 'simultaneous') {
      roles[L.referenceSide] = 'reference';
      roles[L.referenceSide === 'left' ? 'right' : 'left'] = 'reconstruction';
    } else {
      info.showing = showingAt(L, opts.timing, now);
      roles[L.comparisonSide] = info.showing;
    }
    ['left', 'right'].forEach(function (side) {
      var role = roles[side];
      var visible = role && (L.visibility === 'both' || L.visibility === side);
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
    info.warnings = warnings(state, W / scale, H / scale, n, centers, dCss / scale);
    return info;
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
