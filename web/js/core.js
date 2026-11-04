/*
 * Distortion Lab core: pure, DOM-free logic shared by the browser console, the
 * stimulus window, and the Node test-suite.
 *
 *  - two deterministic renderers (legacy-rectified, semantic-grating)
 *  - parameter schema access, quantisation, strict validation
 *  - undoable "work" state (reconstruction + pins) with slider coalescing
 *  - pin-respecting seeded proposals, gallery templates and combinations
 *  - legacy distortion-lab/session/1 import
 *  - validation of structured (AI-proposed) operations
 *
 * Classic script (no ES modules) so that web/index.html also works from file://.
 */
(function (root, factory) {
  var data = (typeof module === 'object' && module.exports) ? require('./data.js') : root.DL_DATA;
  var api = factory(data);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DLCore = api;
})(typeof self !== 'undefined' ? self : this, function (DATA) {
  'use strict';

  var VERSION = DATA.version;
  var SESSION_SCHEMA = DATA.sessionSchema;
  var P = DATA.parameters;
  var SEM = P.renderers['semantic-grating'];
  var LEG = P.renderers['legacy-rectified'];
  var SEM_DEFS = {};
  SEM.params.forEach(function (d) { SEM_DEFS[d.key] = d; });
  var LEG_DEFS = {};
  LEG.componentParams.forEach(function (d) { LEG_DEFS[d.key] = d; });
  var REF_DEFS = {};
  P.reference.forEach(function (d) { REF_DEFS[d.key] = d; });
  var OUTCOMES = ['matched', 'approximate', 'unmatchable', 'unstable', 'cannot-tell', 'not-visible'];
  var COALESCE_MS = 1500;
  var MAX_UNDO = 500;

  // ---------------------------------------------------------------- utilities
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function nowISO() { return new Date().toISOString(); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fail(msg) { var e = new Error(msg); e.name = 'ValidationError'; throw e; }
  function cannotApply(msg, paths) {
    var e = new Error(msg); e.name = 'CannotApply'; e.paths = paths || []; return e;
  }
  /** Snap to the def's step grid (relative to min) and clamp, like the original GUI. */
  function quantize(def, v) {
    if (def.type !== 'number') return v;
    var x = clamp(v, def.min, def.max);
    var q = def.min + Math.round((x - def.min) / def.step) * def.step;
    q = Number(clamp(q, def.min, def.max).toFixed(6));
    if (def.integer) q = Math.round(q);
    return q;
  }
  function wrapPeriodic(def, v) {
    if (!def.periodic) return v;
    var p = def.periodic;
    var w = ((v % p) + p) % p;
    return w > def.max ? w - p : w;
  }
  /** mulberry32: tiny deterministic PRNG; same sequence for a given 32-bit seed. */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashString(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  /** Integer hash -> [0,1). Mirrored exactly in distortion_lab/model.py (hash01). */
  function hash01(n, seed) {
    var h = (Math.imul(n | 0, 374761393) + Math.imul(seed | 0, 668265263)) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
  }
  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    var r = mulberry32((Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0);
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var v = Math.floor(r() * 16); return (c === 'x' ? v : (v & 3) | 8).toString(16);
    });
  }

  // ---------------------------------------------------------------- renderers
  var TAU = 2 * Math.PI, DEG = Math.PI / 180;

  // Original synthesis (identical arithmetic to existing-prototype ModelMath).
  function carrier(x, y, p) {
    var a = p.orientation * Math.PI / 180;
    return Math.cos(2 * Math.PI * p.frequency * (-x * Math.sin(a) + y * Math.cos(a)) + p.phase * Math.PI / 180);
  }
  function legacyComponent(x, y, p) { return clamp(carrier(x, y, p) + p.duty, -p.threshold, p.threshold); }
  function legacySignal(x, y, components) {
    var s = 0;
    for (var i = 0; i < components.length; i++) {
      var p = components[i];
      if (p.enabled) s += p.weight * legacyComponent(x, y, p);
    }
    return clamp(s, -1, 1);
  }
  function envelope(x, y, g) {
    if (x * x + y * y > g.diameter * g.diameter / 4) return 0;
    return g.aperture === 'gaussian' ? Math.exp(-(x * x + y * y) / (2 * g.sigma * g.sigma)) : 1;
  }

  // Semantic appearance generator (renderer id 'semantic-grating', see docs/MODEL.md).
  function profile(g, sharp) {
    if (sharp <= 0) return g;
    var k = 20 * sharp;
    return Math.tanh(k * g) / Math.tanh(k);
  }
  function triWave(t) { return (2 / Math.PI) * Math.asin(clamp(Math.sin(TAU * t), -1, 1)); }
  var STEP_K = 12, STEP_NORM = Math.tanh(12);
  function stepWave(t) { return Math.tanh(STEP_K * Math.sin(TAU * t)) / STEP_NORM; }
  function semanticPrepare(p) {
    var a = p.orientation * Math.PI / 180;
    var b = (p.orientation + p.crossAngle) * DEG;
    var oa = p.offsetAngle * DEG;
    var ha = p.holeAngle * DEG;
    var q = {};
    for (var k in p) q[k] = p[k];
    q.sa = Math.sin(a); q.ca = Math.cos(a);
    q.phr = p.phase * Math.PI / 180;
    q.sb = Math.sin(b); q.cb = Math.cos(b);
    q.soa = Math.sin(oa); q.coa = Math.cos(oa);
    q.sh = Math.sin(ha); q.ch = Math.cos(ha);
    q.usesSides = ['bendSide', 'zigSide', 'fragSide', 'crossSide'].some(function (k) { return p[k] === 'upper' || p[k] === 'lower'; });
    q.br = [0, 1, 2].map(function (i) { var t = ha + i * 2 * Math.PI / 3; return [Math.cos(t), Math.sin(t)]; });
    return q;
  }
  function holeDistance(x, y, q) {
    var dx = x - q.holeX, dy = y - q.holeY;
    if (q.holeShape === 'disc') return Math.sqrt(dx * dx + dy * dy) - q.holeSize;
    if (q.holeShape === 'band') return Math.abs(-dx * q.sh + dy * q.ch) - q.holeSize;
    var best = Infinity;
    for (var i = 0; i < 3; i++) {
      var c = q.br[i][0], s = q.br[i][1];
      var along = dx * c + dy * s;
      var d = along >= 0 ? Math.abs(-dx * s + dy * c) : Math.sqrt(dx * dx + dy * dy);
      if (d < best) best = d;
    }
    return best - q.holeSize;
  }
  /** Weight of a feature limited to one side of the boundary line: 1 (whole), H (upper) or 1 - H (lower). */
  function sideWeight(side, H) { return side === 'upper' ? H : (side === 'lower' ? 1 - H : 1); }
  function semanticSignal(x, y, q) {
    var u = -x * q.sa + y * q.ca;      // across-stripe coordinate (deg)
    var v = x * q.ca + y * q.sa;       // along-stripe coordinate (deg)
    var d = 0, H = 1;
    if (q.offsetAmount !== 0 || q.usesSides) {
      var w = v * q.coa + u * q.soa - q.offsetPosition;
      H = q.offsetSoftness > 0 ? 0.5 * (1 + Math.tanh(w / q.offsetSoftness)) : (w >= 0 ? 1 : 0);
    }
    if (q.bendAmount !== 0) d += sideWeight(q.bendSide, H) * q.bendAmount * Math.sin(TAU * v / q.bendSpacing + q.bendPhase * DEG);
    if (q.zigAmount !== 0) {
      var t = v / q.zigSpacing + q.zigPhase / 360;
      d += sideWeight(q.zigSide, H) * q.zigAmount * ((1 - q.zigShape) * triWave(t) + q.zigShape * stepWave(t));
    }
    if (q.offsetAmount !== 0) d += q.offsetAmount * (H - 0.5);
    var s = u + d;
    var P = profile(Math.cos(2 * Math.PI * q.frequency * s + q.phr), q.sharpness);
    if (q.fragExtent > 0) {
      var n = Math.floor(q.frequency * s + q.phase / 360);
      var tt = v / q.fragLength + q.fragJitter * hash01(n, q.fragSeed);
      if (tt - Math.floor(tt) < q.fragExtent) {
        var wf = sideWeight(q.fragSide, H);
        if (wf === 1) P = q.gapFill; else if (wf > 0) P = P + wf * (q.gapFill - P);
      }
    }
    if (q.crossStrength > 0) {
      var wc = sideWeight(q.crossSide, H);
      if (wc > 0) {
        var gc = Math.cos(TAU * (-x * q.sb + y * q.cb) / q.crossSpacing + q.crossPhase * DEG);
        P = clamp(P + wc * q.crossStrength * profile(gc, q.sharpness), -1, 1);
      }
    }
    if (q.holeSize > 0) {
      var dist = holeDistance(x, y, q);
      var m = q.holeSoftness > 0 ? clamp(0.5 - dist / q.holeSoftness, 0, 1) : (dist <= 0 ? 1 : 0);
      if (m > 0) P = P + m * (1 - q.holeResidual) * (q.gapFill - P);
    }
    return P;
  }

  /** Signal function f(x,y) in [-1,1] for a reconstruction, and its output contrast. */
  function signalFor(recon) {
    if (recon.renderer === 'legacy-rectified') {
      var comps = recon.params.components;
      return { contrast: recon.params.contrast, f: function (x, y) { return legacySignal(x, y, comps); } };
    }
    if (recon.renderer === 'semantic-grating') {
      var q = semanticPrepare(recon.params);
      return { contrast: recon.params.contrast, f: function (x, y) { return semanticSignal(x, y, q); } };
    }
    fail('Unknown renderer ' + recon.renderer);
  }
  /** Rasterise n x n RGBA over the aperture diameter. Pixel centres, y up. */
  function rasterize(n, geometry, sig) {
    var px = new Uint8ClampedArray(n * n * 4);
    for (var j = 0; j < n; j++) {
      var y = (0.5 - (j + 0.5) / n) * geometry.diameter;
      for (var i = 0; i < n; i++) {
        var x = ((i + 0.5) / n - 0.5) * geometry.diameter;
        var e = envelope(x, y, geometry);
        var v = e === 0 ? 128 : Math.round(127.5 * (1 + sig.contrast * e * sig.f(x, y)));
        var k = 4 * (j * n + i);
        px[k] = px[k + 1] = px[k + 2] = v; px[k + 3] = 255;
      }
    }
    return px;
  }
  function renderRecon(recon, n, geometry) { return rasterize(n, geometry, signalFor(recon)); }
  function referenceRecon(reference) {
    return { renderer: 'legacy-rectified', rendererVersion: LEG.version, params: { contrast: reference.contrast,
      components: [{ id: 1, enabled: true, orientation: reference.orientation, frequency: reference.frequency,
        phase: reference.phase, duty: 0, threshold: 1, weight: 1 }] } };
  }
  function renderReference(reference, n, geometry) { return renderRecon(referenceRecon(reference), n, geometry); }
  /** Highest carrier frequency present (for sampling warnings). */
  function maxFrequency(recon) {
    if (recon.renderer === 'legacy-rectified')
      return Math.max.apply(null, recon.params.components.filter(function (c) { return c.enabled && c.weight > 0; })
        .map(function (c) { return c.frequency; }).concat([0]));
    var p = recon.params, f = p.frequency;
    if (p.crossStrength > 0) f = Math.max(f, 1 / p.crossSpacing);
    return f;
  }

  // ---------------------------------------------------------------- constructors
  function semanticDefaults() {
    var o = {};
    SEM.params.forEach(function (d) { o[d.key] = d.default; });
    return o;
  }
  function identityRecon(reference) {
    var p = semanticDefaults();
    p.orientation = reference.orientation; p.frequency = reference.frequency;
    p.phase = reference.phase; p.contrast = reference.contrast;
    return { renderer: 'semantic-grating', rendererVersion: SEM.version, params: p };
  }
  function legacyRecon(model) {
    return { renderer: 'legacy-rectified', rendererVersion: LEG.version, params: clone({ contrast: model.contrast, components: model.components }) };
  }
  function legacyPreset(id) {
    var p = DATA.legacyPresets.presets.filter(function (x) { return x.id === id; })[0];
    if (!p) fail('Unknown legacy preset ' + id);
    return p;
  }
  function defaultReference() { var r = {}; P.reference.forEach(function (d) { r[d.key] = d.default; }); return r; }
  function defaultLayout() {
    var L = P.layout, o = {};
    Object.keys(L.defaults).forEach(function (k) { o[k] = L.defaults[k]; });
    Object.keys(L.numbers).forEach(function (k) { o[k] = L.numbers[k].default; });
    Object.keys(L.booleans).forEach(function (k) { o[k] = L.booleans[k]; });
    return o;
  }

  // ---------------------------------------------------------------- parameter paths
  /** Ordered list of {path, def, family, component} for every editable field. */
  function paramList(recon) {
    if (recon.renderer === 'semantic-grating')
      return SEM.params.map(function (d) { return { path: d.key, def: d, family: d.family }; });
    var out = [{ path: 'contrast', def: LEG.contrast, family: 'output' }];
    recon.params.components.forEach(function (c) {
      out.push({ path: 'c' + c.id + '.enabled', def: { key: 'enabled', label: 'Enabled', type: 'boolean' }, family: 'c' + c.id, component: c.id });
      LEG.componentParams.forEach(function (d) { out.push({ path: 'c' + c.id + '.' + d.key, def: d, family: 'c' + c.id, component: c.id }); });
    });
    return out;
  }
  function parsePath(recon, path) {
    if (typeof path !== 'string') fail('Parameter path must be a string');
    if (recon.renderer === 'semantic-grating') {
      if (!SEM_DEFS[path]) fail('Unknown parameter ' + path + ' for semantic-grating');
      return { obj: recon.params, key: path, def: SEM_DEFS[path] };
    }
    if (path === 'contrast') return { obj: recon.params, key: 'contrast', def: LEG.contrast };
    var m = /^c(\d+)\.(\w+)$/.exec(path);
    if (!m) fail('Unknown parameter ' + path + ' for legacy-rectified');
    var id = Number(m[1]);
    var comp = recon.params.components.filter(function (c) { return c.id === id; })[0];
    if (!comp) fail('Component ' + id + ' does not exist');
    if (m[2] === 'enabled') return { obj: comp, key: 'enabled', def: { key: 'enabled', type: 'boolean', label: 'Enabled' } };
    if (!LEG_DEFS[m[2]]) fail('Unknown component field ' + m[2]);
    return { obj: comp, key: m[2], def: LEG_DEFS[m[2]] };
  }
  function hasPath(recon, path) { try { parsePath(recon, path); return true; } catch (e) { return false; } }
  function getValue(recon, path) { var r = parsePath(recon, path); return r.obj[r.key]; }
  function defFor(recon, path) { return parsePath(recon, path).def; }
  /** Validated, quantised value for a field (throws on malformed input). */
  function coerce(def, value) {
    if (def.type === 'boolean') { if (typeof value !== 'boolean') fail(def.label + ' must be true or false'); return value; }
    if (def.type === 'enum') { if (def.choices.indexOf(value) < 0) fail(def.label + ' must be one of ' + def.choices.join(', ')); return value; }
    if (typeof value === 'boolean' || value === null || value === '' || value === undefined) fail(def.label + ' requires a finite number');
    var n = Number(value);
    if (!isFinite(n)) fail(def.label + ' requires a finite number');
    return quantize(def, n);
  }
  function withValue(recon, path, value) {
    var next = clone(recon);
    var r = parsePath(next, path);
    r.obj[r.key] = coerce(r.def, value);
    return next;
  }
  function familyLabel(recon, family) {
    if (recon.renderer === 'semantic-grating') return (SEM.families[family] || {}).label || family;
    if (family === 'output') return 'Output';
    var id = Number(family.slice(1));
    var idx = recon.params.components.map(function (c) { return c.id; }).indexOf(id);
    return 'Component C' + (idx + 1);
  }
  function labelFor(recon, path) {
    var r = parsePath(recon, path);
    if (recon.renderer === 'legacy-rectified' && path !== 'contrast') {
      var id = Number(/^c(\d+)/.exec(path)[1]);
      return familyLabel(recon, 'c' + id) + ' ' + r.def.label;
    }
    return r.def.label;
  }

  // ---------------------------------------------------------------- relevance
  function activeFamilies(recon) {
    if (recon.renderer !== 'semantic-grating') return [];
    var out = [];
    Object.keys(SEM.families).forEach(function (f) {
      var a = SEM.families[f].activator;
      if (a && recon.params[a] !== 0) out.push(f);
    });
    return out;
  }
  /** Families whose controls should be shown initially (global + active + revealed). */
  function relevantFamilies(recon, revealed) {
    if (recon.renderer !== 'semantic-grating') return ['output'].concat(recon.params.components.map(function (c) { return 'c' + c.id; }));
    var set = ['global'].concat(activeFamilies(recon));
    if (['bendSide', 'zigSide', 'fragSide', 'crossSide'].some(function (k) { return recon.params[k] === 'upper' || recon.params[k] === 'lower'; }) && set.indexOf('offset') < 0) set.push('offset');
    (revealed || []).forEach(function (f) { if (SEM.families[f] && set.indexOf(f) < 0) set.push(f); });
    return Object.keys(SEM.families).filter(function (f) { return set.indexOf(f) >= 0; });
  }

  // ---------------------------------------------------------------- validation
  function checkNumber(def, v, where) {
    if (!isNum(v)) fail(where + ': ' + def.label + ' must be a finite number');
    if (v < def.min || v > def.max) fail(where + ': ' + def.label + ' out of range [' + def.min + ', ' + def.max + ']');
    if (def.integer && Math.round(v) !== v) fail(where + ': ' + def.label + ' must be an integer');
    return v;
  }
  function plainObject(o, where) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) fail(where + ' must be an object');
    return o;
  }
  function noExtraKeys(o, allowed, where) {
    Object.keys(o).forEach(function (k) { if (allowed.indexOf(k) < 0) fail(where + ': unexpected field ' + k); });
  }
  function validateReference(r) {
    plainObject(r, 'reference');
    noExtraKeys(r, Object.keys(REF_DEFS), 'reference');
    var out = {};
    P.reference.forEach(function (d) { out[d.key] = checkNumber(d, r[d.key], 'reference'); });
    return out;
  }
  function validateLayout(l, opts) {
    plainObject(l, 'layout');
    var fill = opts && opts.fillDefaults, L = P.layout, out = {}, def = defaultLayout();
    var allowed = Object.keys(L.choices).concat(Object.keys(L.numbers), Object.keys(L.booleans));
    noExtraKeys(l, allowed, 'layout');
    Object.keys(L.choices).forEach(function (k) {
      if (l[k] === undefined && fill) { out[k] = def[k]; return; }
      if (L.choices[k].indexOf(l[k]) < 0) fail('layout: invalid ' + k);
      out[k] = l[k];
    });
    Object.keys(L.numbers).forEach(function (k) {
      if (l[k] === undefined && fill) { out[k] = def[k]; return; }
      var n = L.numbers[k];
      if (!isNum(l[k]) || l[k] < n.min || l[k] > n.max) fail('layout: ' + k + ' out of range');
      out[k] = l[k];
    });
    Object.keys(L.booleans).forEach(function (k) {
      if (l[k] === undefined && fill) { out[k] = def[k]; return; }
      if (typeof l[k] !== 'boolean') fail('layout: ' + k + ' must be boolean');
      out[k] = l[k];
    });
    return out;
  }
  function validateRecon(r) {
    plainObject(r, 'reconstruction');
    noExtraKeys(r, ['renderer', 'rendererVersion', 'params'], 'reconstruction');
    plainObject(r.params, 'reconstruction.params');
    if (r.renderer === 'semantic-grating') {
      if (r.rendererVersion === '1.0.0') {        // 1.0.0 -> 1.1.0: side-limited features added; 'whole' is pixel-identical
        var up = {}; for (var k0 in r.params) up[k0] = r.params[k0];
        ['bendSide', 'zigSide', 'fragSide', 'crossSide'].forEach(function (k) { if (up[k] === undefined) up[k] = 'whole'; });
        r = { renderer: r.renderer, rendererVersion: SEM.version, params: up };
      }
      if (r.rendererVersion !== SEM.version) fail('Unsupported semantic-grating version ' + r.rendererVersion);
      noExtraKeys(r.params, Object.keys(SEM_DEFS), 'semantic params');
      var p = {};
      SEM.params.forEach(function (d) {
        var v = r.params[d.key];
        if (d.type === 'enum') { if (d.choices.indexOf(v) < 0) fail('semantic params: invalid ' + d.key); p[d.key] = v; }
        else p[d.key] = checkNumber(d, v, 'semantic params');
      });
      return { renderer: r.renderer, rendererVersion: r.rendererVersion, params: p };
    }
    if (r.renderer === 'legacy-rectified') {
      if (r.rendererVersion !== LEG.version) fail('Unsupported legacy-rectified version ' + r.rendererVersion);
      noExtraKeys(r.params, ['contrast', 'components'], 'legacy params');
      var cs = r.params.components;
      if (!Array.isArray(cs) || cs.length < 1 || cs.length > LEG.maxComponents) fail('Expected 1-' + LEG.maxComponents + ' components');
      var ids = {};
      var comps = cs.map(function (c) {
        plainObject(c, 'component');
        noExtraKeys(c, ['id', 'enabled'].concat(Object.keys(LEG_DEFS)), 'component');
        if (!(typeof c.id === 'number' && Math.floor(c.id) === c.id && c.id >= 1 && c.id < 1e9) || ids[c.id]) fail('Invalid or duplicate component id');
        ids[c.id] = true;
        if (typeof c.enabled !== 'boolean') fail('Component enabled flag must be boolean');
        var o = { id: c.id, enabled: c.enabled };
        LEG.componentParams.forEach(function (d) { o[d.key] = checkNumber(d, c[d.key], 'component ' + c.id); });
        return o;
      });
      return { renderer: r.renderer, rendererVersion: r.rendererVersion,
        params: { contrast: checkNumber(LEG.contrast, r.params.contrast, 'legacy params'), components: comps } };
    }
    fail('Unknown renderer ' + r.renderer);
  }
  function validateWork(w) {
    plainObject(w, 'work');
    noExtraKeys(w, ['recon', 'pins', 'origin'], 'work');
    var recon = validateRecon(w.recon);
    if (!Array.isArray(w.pins)) fail('pins must be an array');
    var seen = {};
    w.pins.forEach(function (p) {
      if (!hasPath(recon, p)) fail('Pinned field ' + p + ' does not exist');
      if (seen[p]) fail('Duplicate pin ' + p);
      seen[p] = true;
    });
    var out = { recon: recon, pins: w.pins.slice() };
    if (w.origin !== undefined) out.origin = clone(w.origin);
    return out;
  }
  function str(v, max, where) { if (typeof v !== 'string' || v.length > max) fail(where + ' must be a string of at most ' + max + ' characters'); return v; }
  function validateSession(s) {
    plainObject(s, 'session');
    if (s.schema !== SESSION_SCHEMA) fail('Unsupported session schema ' + s.schema);
    str(s.sessionId, 200, 'sessionId'); str(s.softwareVersion, 40, 'softwareVersion');
    str(s.createdAt, 40, 'createdAt'); str(s.updatedAt, 40, 'updatedAt');
    str(s.participant, 120, 'participant'); str(s.condition, 120, 'condition'); str(s.notes, 20000, 'notes');
    validateReference(s.reference);
    s.layout = validateLayout(s.layout, { fillDefaults: true });   // older sessions lack newer layout fields
    s.work = validateWork(s.work);   // also normalises key order so JSON comparisons are stable
    ['undo', 'redo', 'proposals', 'descriptions', 'accepted', 'actions'].forEach(function (k) {
      if (!Array.isArray(s[k])) fail(k + ' must be an array');
    });
    if (s.undo.length > MAX_UNDO || s.redo.length > MAX_UNDO) fail('Undo/redo history too long');
    if (s.actions.length > 2000000) fail('Action log too long');
    s.undo.concat(s.redo).forEach(function (e) { plainObject(e, 'history entry'); e.work = validateWork(e.work); });
    s.proposals.forEach(function (p) { plainObject(p, 'proposal set'); if (p.base) p.base = validateWork(p.base); });
    if (s.nulls !== undefined && !Array.isArray(s.nulls)) fail('nulls must be an array');
    if (s.task !== undefined && s.task !== null) {
      plainObject(s.task, 'task');
      if (s.task.kind !== 'null') fail('Unknown task ' + s.task.kind);
      s.task.matchWork = validateWork(s.task.matchWork);
    }
    s.descriptions.forEach(function (d) { plainObject(d, 'description'); str(d.text, 20000, 'description text'); });
    if (s.outcome !== null) {
      plainObject(s.outcome, 'outcome');
      if (OUTCOMES.indexOf(s.outcome.status) < 0) fail('Invalid outcome status');
    }
    plainObject(s.settings, 'settings');
    return s;
  }

  // ---------------------------------------------------------------- session / history
  function newSession(opts) {
    opts = opts || {};
    var reference = opts.reference ? validateReference(opts.reference) : defaultReference();
    var t = nowISO();
    var s = {
      schema: SESSION_SCHEMA, softwareVersion: VERSION,
      sessionId: opts.sessionId || uuid(), createdAt: t, updatedAt: t,
      participant: opts.participant || '', condition: opts.condition || '', notes: '',
      reference: reference,
      layout: opts.layout ? validateLayout(opts.layout, { fillDefaults: true }) : defaultLayout(),
      work: { recon: identityRecon(reference), pins: [], origin: { type: 'gallery', id: 'reference' } },
      undo: [], redo: [],
      settings: { proposalScale: 'coarse', sliderStep: 'fine', shrinkRepeated: true, shrinkFactor: 0.6,
        proposalCount: 4, includeAdvanced: false, revealedFamilies: [], showLabels: true },
      neighborhood: { round: 0, anchor: null },
      proposals: [], descriptions: [], accepted: [], outcome: null, nulls: [], task: null,
      actions: [], provenance: { createdBy: 'Distortion Lab ' + VERSION }
    };
    log(s, 'session-created', { reference: reference });
    return s;
  }
  var RUNTIME = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function runtime(s) {
    if (!RUNTIME) return (s.__rt = s.__rt || {});
    var r = RUNTIME.get(s); if (!r) { r = {}; RUNTIME.set(s, r); } return r;
  }
  function log(s, type, payload) {
    var e = { time: nowISO(), type: type };
    if (payload) for (var k in payload) e[k] = clone(payload[k]);
    s.actions.push(e);
    s.updatedAt = e.time;
    return e;
  }
  function sameWork(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  /** Replace the current work with an undo entry. opts: {label, action, coalesce, detail}. */
  function commit(s, nextWork, opts) {
    opts = opts || {};
    nextWork = validateWork(nextWork);
    if (sameWork(nextWork.recon, s.work.recon) && sameWork(nextWork.pins, s.work.pins)) return false;
    var rt = runtime(s), t = Date.now();
    var coalesced = !!(opts.coalesce && rt.coalesce === opts.coalesce && t - rt.time < COALESCE_MS && s.undo.length);
    if (!coalesced) {
      s.undo.push({ time: nowISO(), label: opts.label || opts.action || 'change', action: opts.action || 'change', work: clone(s.work) });
      if (s.undo.length > MAX_UNDO) s.undo.shift();
    }
    s.work = nextWork;
    s.redo = [];
    rt.coalesce = opts.coalesce || null; rt.time = t;
    if (!coalesced) log(s, opts.action || 'change', Object.assign({ label: opts.label }, opts.detail || {}));
    else s.updatedAt = nowISO();
    return true;
  }
  /** End a slider drag: the next edit starts a new undo entry. */
  function endCoalesce(s, detail) {
    var rt = runtime(s);
    if (rt.coalesce) log(s, 'edit-committed', Object.assign({ key: rt.coalesce }, detail || {}));
    rt.coalesce = null;
  }
  function undo(s) {
    if (!s.undo.length) return false;
    var e = s.undo.pop();
    s.redo.push({ time: nowISO(), label: e.label, action: e.action, work: clone(s.work) });
    s.work = clone(e.work);
    runtime(s).coalesce = null;
    log(s, 'undo', { label: e.label });
    return true;
  }
  function redo(s) {
    if (!s.redo.length) return false;
    var e = s.redo.pop();
    s.undo.push({ time: nowISO(), label: e.label, action: e.action, work: clone(s.work) });
    s.work = clone(e.work);
    runtime(s).coalesce = null;
    log(s, 'redo', { label: e.label });
    return true;
  }
  function resetNeighborhood(s) { s.neighborhood = { round: 0, anchor: null }; }

  // ---------------------------------------------------------------- edits
  function assertNotPinned(work, path) {
    if (work.pins.indexOf(path) >= 0) throw cannotApply(labelFor(work.recon, path) + ' is pinned. Unpin it to change it.', [path]);
  }
  /** Controller entry point shared by sliders, keyboard, dials and the API. */
  function setParam(s, path, value, opts) {
    opts = opts || {};
    assertNotPinned(s.work, path);
    var recon = withValue(s.work.recon, path, value);
    var w = { recon: recon, pins: s.work.pins.slice(), origin: { type: 'manual', source: opts.source || 'api' } };
    var changed = commit(s, w, { action: 'set-parameter', label: labelFor(recon, path), coalesce: opts.coalesce,
      detail: { path: path, value: getValue(recon, path), source: opts.source || 'api' } });
    if (changed) resetNeighborhood(s);
    return changed;
  }
  function stepFor(def, mode) { return mode === 'coarse' ? def.coarseStep : def.step; }
  function nudge(s, path, steps, opts) {
    opts = opts || {};
    if (!isNum(Number(steps)) || typeof steps === 'boolean') fail('steps must be a number');
    var def = defFor(s.work.recon, path);
    if (def.type !== 'number') fail(def.label + ' cannot be nudged');
    var cur = getValue(s.work.recon, path);
    var next = cur + Number(steps) * stepFor(def, opts.stepMode || s.settings.sliderStep);
    if (def.periodic && opts.wrap !== false) next = wrapPeriodic(def, next);
    return setParam(s, path, next, { source: opts.source || 'api', coalesce: opts.coalesce || ('nudge:' + path) });
  }
  function togglePin(s, path) {
    if (!hasPath(s.work.recon, path)) fail('Cannot pin unknown field ' + path);
    var pins = s.work.pins.slice(), i = pins.indexOf(path), pinned = i < 0;
    if (pinned) pins.push(path); else pins.splice(i, 1);
    commit(s, { recon: clone(s.work.recon), pins: pins, origin: s.work.origin }, {
      action: pinned ? 'pin' : 'unpin', label: (pinned ? 'Pin ' : 'Unpin ') + labelFor(s.work.recon, path), detail: { path: path } });
    return pinned;
  }
  /**
   * Replace the reconstruction with `target` while honouring pins.
   * Throws CannotApply (with an explanation) instead of silently dropping a pin.
   */
  function withPins(work, target) {
    var kept = [];
    if (work.pins.length) {
      if (target.renderer !== work.recon.renderer)
        throw cannotApply('This choice uses a different renderer (' + target.renderer + ') than the current reconstruction (' +
          work.recon.renderer + '). The pinned properties (' + work.pins.map(function (p) { return labelFor(work.recon, p); }).join(', ') +
          ') cannot be carried across renderers. Unpin them to apply this choice.', work.pins.slice());
      var missing = work.pins.filter(function (p) { return !hasPath(target, p); });
      if (missing.length) throw cannotApply('This choice has no field for pinned ' + missing.join(', ') + '. Unpin to apply it.', missing);
      target = clone(target);
      work.pins.forEach(function (p) {
        var cur = getValue(work.recon, p);
        if (JSON.stringify(getValue(target, p)) !== JSON.stringify(cur)) kept.push({ path: p, wanted: getValue(target, p), kept: cur });
        var r = parsePath(target, p); r.obj[r.key] = cur;
      });
    }
    return { recon: target, kept: kept };
  }
  function applyRecon(s, target, opts) {
    var r = withPins(s.work, validateRecon(target));
    commit(s, { recon: r.recon, pins: s.work.pins.slice(), origin: opts.origin }, {
      action: opts.action, label: opts.label, detail: Object.assign({ origin: opts.origin, keptPinned: r.kept }, opts.detail || {}) });
    resetNeighborhood(s);
    return r;
  }
  function addComponent(s) {
    var r = s.work.recon;
    if (r.renderer !== 'legacy-rectified') fail('Components exist only in the original synthesis renderer');
    if (r.params.components.length >= LEG.maxComponents) throw cannotApply('At most ' + LEG.maxComponents + ' components are supported');
    var next = clone(r), id = Math.max.apply(null, r.params.components.map(function (c) { return c.id; })) + 1;
    next.params.components.push({ id: id, enabled: true, orientation: 45, frequency: quantize(LEG_DEFS.frequency, s.reference.frequency * 0.75),
      phase: 0, duty: 0, threshold: 1, weight: 0.25 });
    commit(s, { recon: next, pins: s.work.pins.slice(), origin: { type: 'manual' } }, { action: 'add-component', label: 'Add component', detail: { id: id } });
    return id;
  }
  function removeComponent(s, id) {
    var r = s.work.recon;
    if (r.renderer !== 'legacy-rectified') fail('Components exist only in the original synthesis renderer');
    if (r.params.components.length <= 1) throw cannotApply('At least one component is required');
    var pinnedHere = s.work.pins.filter(function (p) { return p.indexOf('c' + id + '.') === 0; });
    if (pinnedHere.length) throw cannotApply('Component has pinned fields (' + pinnedHere.join(', ') + '). Unpin them before removing it.', pinnedHere);
    var next = clone(r);
    next.params.components = next.params.components.filter(function (c) { return c.id !== id; });
    if (next.params.components.length === r.params.components.length) fail('Component ' + id + ' does not exist');
    commit(s, { recon: next, pins: s.work.pins.slice(), origin: { type: 'manual' } }, { action: 'remove-component', label: 'Remove component', detail: { id: id } });
  }
  /**
   * Mix two legacy presets (or the current legacy reconstruction and a preset):
   * concatenates components, scaling weights by wa and wb. Respects pins.
   */
  function mixLegacy(s, presetA, presetB, wa, wb) {
    var A = presetA === 'current' ? s.work.recon : legacyRecon(legacyPreset(presetA).model);
    var B = legacyRecon(legacyPreset(presetB).model);
    if (A.renderer !== 'legacy-rectified') throw cannotApply('The current reconstruction is not in the original synthesis renderer, so it cannot be mixed with legacy components.');
    wa = wa === undefined ? 0.5 : wa; wb = wb === undefined ? 0.5 : wb;
    if (!(isNum(wa) && isNum(wb) && wa >= 0 && wb >= 0 && wa <= 2 && wb <= 2)) fail('Mixing weights must be between 0 and 2');
    var n = A.params.components.length + B.params.components.length;
    if (n > LEG.maxComponents) throw cannotApply('The mixture would need ' + n + ' components; the maximum is ' + LEG.maxComponents + '.');
    var comps = [], id = 1;
    A.params.components.forEach(function (c) { var o = clone(c); o.id = id++; o.weight = quantize(LEG_DEFS.weight, c.weight * wa); comps.push(o); });
    B.params.components.forEach(function (c) { var o = clone(c); o.id = id++; o.weight = quantize(LEG_DEFS.weight, c.weight * wb); comps.push(o); });
    var target = { renderer: 'legacy-rectified', rendererVersion: LEG.version, params: { contrast: A.params.contrast, components: comps } };
    return applyRecon(s, target, { action: 'mix-legacy', label: 'Mix ' + presetA + ' + ' + presetB,
      origin: { type: 'mix', a: presetA, b: presetB, wa: wa, wb: wb } });
  }

  // ---------------------------------------------------------------- gallery
  var GAL = P.gallery;
  function galleryFamily(id) {
    var f = GAL.families.filter(function (x) { return x.id === id; })[0];
    if (!f) fail('Unknown gallery family ' + id);
    return f;
  }
  function applyOverrides(recon, reference, ov) {
    var next = clone(recon);
    Object.keys(ov).forEach(function (k) {
      if (k === 'orientationOffset') next.params.orientation = quantize(SEM_DEFS.orientation, wrapPeriodic(SEM_DEFS.orientation, reference.orientation + ov[k]));
      else next.params[k] = coerce(SEM_DEFS[k], ov[k]);
    });
    return next;
  }
  function templateRecon(reference, famId, level) {
    return applyOverrides(identityRecon(reference), reference, galleryFamily(famId)[level || 'mild']);
  }
  function familyParams(f) { return f.params; }
  function combinationRecons(reference, a, b) {
    if (a === b) throw cannotApply('Choose two different features to combine.');
    var A = galleryFamily(a), B = galleryFamily(b);
    var overlap = familyParams(A).filter(function (p) { return familyParams(B).indexOf(p) >= 0; });
    if (overlap.length) throw cannotApply('"' + A.label + '" and "' + B.label + '" are produced by the same controls (' +
      overlap.join(', ') + '), so they cannot be combined as separate features. Choose one of them, or adjust it with the sliders.', overlap);
    return [['mild', 'mild'], ['strong', 'mild'], ['mild', 'strong'], ['strong', 'strong']].map(function (lv) {
      var r = applyOverrides(applyOverrides(identityRecon(reference), reference, A[lv[0]]), reference, B[lv[1]]);
      return { id: a + ':' + lv[0] + '+' + b + ':' + lv[1], label: A.label + ' (' + lv[0] + ') + ' + B.label + ' (' + lv[1] + ')', recon: r };
    });
  }
  /** Two-grating plaid relative to the test grating (legacy renderer; linear because K=0, T=1, W1+W2<=1). */
  function plaidRecon(reference, spec) {
    var comp = function (id, c) {
      return { id: id, enabled: true,
        orientation: quantize(LEG_DEFS.orientation, wrapPeriodic(LEG_DEFS.orientation, reference.orientation + c.dOri)),
        frequency: quantize(LEG_DEFS.frequency, reference.frequency * c.fMul),
        phase: quantize(LEG_DEFS.phase, wrapPeriodic(LEG_DEFS.phase, reference.phase + c.phase)),
        duty: 0, threshold: 1, weight: quantize(LEG_DEFS.weight, c.w) };
    };
    return { renderer: 'legacy-rectified', rendererVersion: LEG.version,
      params: { contrast: reference.contrast, components: [comp(1, spec.c1), comp(2, spec.c2)] } };
  }
  /** All gallery tiles for the current reference. Order: unchanged, plaid types, feature families, combinations, original forms. */
  function galleryItems(reference) {
    var items = [{ id: 'reference', kind: 'reference', label: 'Unchanged reference', families: [], recon: identityRecon(reference) }];
    (GAL.plaids || []).forEach(function (pl) {
      items.push({ id: 'plaid:' + pl.id, kind: 'plaid', label: pl.label, families: [], recon: plaidRecon(reference, pl) });
    });
    GAL.families.forEach(function (f) {
      ['mild', 'strong'].forEach(function (lv) {
        items.push({ id: f.id + ':' + lv, kind: 'family', family: f.id, level: lv, label: f.label + ' (' + lv + ')', families: [f.id], recon: templateRecon(reference, f.id, lv) });
      });
    });
    GAL.combinations.forEach(function (pair) {
      var c = combinationRecons(reference, pair[0], pair[1])[0];
      items.push({ id: 'combo:' + c.id, kind: 'combination', label: c.label, families: pair.slice(), recon: c.recon });
    });
    DATA.legacyPresets.presets.forEach(function (p) {
      items.push({ id: 'legacy:' + p.id, kind: 'legacy', label: String(p.index).padStart(2, '0') + ' · ' + p.name, families: [],
        recon: legacyRecon(p.model), legacy: { id: p.id, status: p.status, note: p.note, provenance: p.provenance, reference: p.reference } });
    });
    return items;
  }
  function galleryItem(reference, id) {
    if (id.indexOf('combo:') === 0) {
      var parts = id.slice(6).split('+'), a = parts[0].split(':'), b = parts[1].split(':');
      var A = galleryFamily(a[0]), B = galleryFamily(b[0]);
      var r = applyOverrides(applyOverrides(identityRecon(reference), reference, A[a[1]]), reference, B[b[1]]);
      return { id: id, kind: 'combination', label: A.label + ' (' + a[1] + ') + ' + B.label + ' (' + b[1] + ')', families: [a[0], b[0]], recon: r };
    }
    var it = galleryItems(reference).filter(function (x) { return x.id === id; })[0];
    if (!it) fail('Unknown gallery item ' + id);
    return it;
  }
  function chooseGallery(s, id) {
    var it = galleryItem(s.reference, id);
    var r = applyRecon(s, it.recon, { action: 'gallery-choice', label: 'Choose ' + it.label, origin: { type: 'gallery', id: id },
      detail: { item: id, kind: it.kind } });
    if (it.kind !== 'legacy') s.settings.revealedFamilies = [];
    return r;
  }
  function recordGalleryOutcome(s, kind, detail) {
    // kind: 'more-than-one' | 'none-close'. Records the response; the reconstruction is unchanged.
    return log(s, 'gallery-' + kind, detail || {});
  }

  // ---------------------------------------------------------------- proposals
  function proposalMagnitude(def, value) {
    var m = def.proposal;
    if (def.proposalRel) m = Math.max(m, def.proposalRel * Math.abs(value));
    return m;
  }
  /** Numeric fields eligible for proposals given a focus. */
  function focusFields(recon, focus, opts) {
    var list = paramList(recon).filter(function (e) { return e.def.type === 'number' && (opts.includeAdvanced || !e.def.advanced); });
    if (recon.renderer === 'legacy-rectified') {
      var enabled = {};
      recon.params.components.forEach(function (c) { if (c.enabled) enabled['c' + c.id] = true; });
      list = list.filter(function (e) { return e.family === 'output' || enabled[e.family]; });
      if (!focus || focus === 'auto' || focus === 'all') return list;
      if (focus.indexOf('path:') === 0) return paramList(recon).filter(function (e) { return e.path === focus.slice(5) && e.def.type === 'number'; });
      return list.filter(function (e) { return e.family === focus; });
    }
    if (focus && focus.indexOf('path:') === 0) return paramList(recon).filter(function (e) { return e.path === focus.slice(5); });
    if (focus === 'all') return list;
    if (focus && focus !== 'auto') {
      if (!SEM.families[focus]) fail('Unknown focus ' + focus);
      return list.filter(function (e) { return e.family === focus; });
    }
    var fams = relevantFamilies(recon, opts.revealed);
    return list.filter(function (e) { return fams.indexOf(e.family) >= 0; });
  }
  /**
   * Deterministic nearby alternatives. Same (recon, pins, options, seed) => same candidates.
   * Alternates single-parameter and coordinated two-parameter proposals. Never changes pins.
   */
  function generateProposals(work, options) {
    var o = { count: 4, scale: 'coarse', round: 0, shrinkFactor: 0.6, seed: 1, focus: 'auto', includeAdvanced: false, revealed: [] };
    for (var k in options) if (options[k] !== undefined) o[k] = options[k];
    if (!(o.count >= 1 && o.count <= 12)) fail('count must be 1-12');
    if (['coarse', 'fine'].indexOf(o.scale) < 0) fail('scale must be coarse or fine');
    var recon = work.recon, pins = work.pins;
    var fields = focusFields(recon, o.focus, o);
    var pinnedInFocus = fields.filter(function (e) { return pins.indexOf(e.path) >= 0; }).map(function (e) { return e.path; });
    fields = fields.filter(function (e) { return pins.indexOf(e.path) < 0 && e.def.type === 'number'; });
    var settings = { count: o.count, scale: o.scale, round: o.round, shrinkFactor: o.shrinkFactor, focus: o.focus,
      includeAdvanced: o.includeAdvanced, revealed: o.revealed.slice(), seed: o.seed >>> 0 };
    if (!fields.length) {
      return { settings: settings, candidates: [], fields: [], pinnedInFocus: pinnedInFocus,
        reason: pinnedInFocus.length ? 'Every property in this focus is pinned (' + pinnedInFocus.map(function (p) { return labelFor(recon, p); }).join(', ') +
          '). Unpin one, or choose another focus.' : 'No adjustable properties in this focus.' };
    }
    var rng = mulberry32(o.seed >>> 0);
    var order = fields.slice();
    for (var i = order.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = order[i]; order[i] = order[j]; order[j] = t; }
    var factor = (o.scale === 'fine' ? 0.25 : 1) * Math.pow(o.shrinkFactor, o.round);
    var seen = {}; seen[JSON.stringify(recon)] = true;
    var cands = [], cursor = 0, attempts = 0;
    function moved(e, cur, delta) {
      var nv = cur + delta;
      if (e.def.periodic) nv = wrapPeriodic(e.def, nv);
      return quantize(e.def, nv);
    }
    while (cands.length < o.count && attempts < o.count * 25) {
      attempts++;
      var pair = (cands.length % 2 === 1) && order.length > 1;
      var picks = pair ? [order[cursor % order.length], order[(cursor + 1) % order.length]] : [order[cursor % order.length]];
      cursor += pair ? 2 : 1;
      if (attempts > order.length * 2) cursor += 1; // decorrelate after a full sweep
      var next = clone(recon), changes = [];
      picks.forEach(function (e) {
        var cur = getValue(next, e.path);
        var sign = rng() < 0.5 ? -1 : 1;
        var mag = Math.max(e.def.step, proposalMagnitude(e.def, cur) * factor * (0.75 + 0.5 * rng()));
        var nv = moved(e, cur, sign * mag);
        if (nv === cur) nv = moved(e, cur, -sign * mag);
        if (nv !== cur) {
          var r = parsePath(next, e.path); r.obj[r.key] = nv;
          changes.push({ path: e.path, label: labelFor(recon, e.path), from: cur, to: nv });
        }
      });
      if (!changes.length) continue;
      var key = JSON.stringify(next);
      if (seen[key]) continue;
      seen[key] = true;
      cands.push({ id: 'p' + cands.length, label: changes.map(function (c) { return c.label + (c.to > c.from ? ' ↑' : ' ↓'); }).join(' + '),
        changes: changes, recon: next });
    }
    return { settings: settings, candidates: cands, fields: fields.map(function (e) { return e.path; }), pinnedInFocus: pinnedInFocus, reason: cands.length ? null : 'No distinct alternatives could be generated (values may be at their limits).' };
  }
  function nextSeed(s) { return (hashString(s.sessionId) + Math.imul(s.proposals.length + 1, 2654435761)) >>> 0; }
  /** Request alternatives around the current reconstruction; records the proposal set. */
  function requestAlternatives(s, opts) {
    opts = opts || {};
    var st = s.settings;
    var anchorKey = JSON.stringify(s.work.recon);
    var round = 0;
    if (opts.repeat && st.shrinkRepeated && s.neighborhood.anchor === anchorKey) round = s.neighborhood.round + 1;
    var seed = opts.seed !== undefined ? opts.seed >>> 0 : nextSeed(s);
    var g = generateProposals(s.work, { count: opts.count || st.proposalCount, scale: opts.scale || st.proposalScale, round: round,
      shrinkFactor: st.shrinkFactor, seed: seed, focus: opts.focus || 'auto', includeAdvanced: st.includeAdvanced, revealed: st.revealedFamilies });
    var rec = { id: 'set' + (s.proposals.length + 1), time: nowISO(), source: 'seeded', seed: seed, settings: g.settings,
      base: clone(s.work), candidates: g.candidates, pinnedInFocus: g.pinnedInFocus, reason: g.reason, choice: null, choiceTime: null };
    s.proposals.push(rec);
    log(s, 'alternatives-shown', { set: rec.id, seed: seed, settings: g.settings, count: g.candidates.length, reason: g.reason });
    return rec;
  }
  /** Record externally-produced candidate sets (combinations, AI) in the same structure. */
  function recordCandidates(s, source, candidates, extra) {
    var rec = { id: 'set' + (s.proposals.length + 1), time: nowISO(), source: source, seed: null, settings: extra && extra.settings || {},
      base: clone(s.work), candidates: candidates, choice: null, choiceTime: null };
    if (extra) for (var k in extra) if (k !== 'settings') rec[k] = clone(extra[k]);
    s.proposals.push(rec);
    log(s, 'alternatives-shown', { set: rec.id, source: source, count: candidates.length });
    return rec;
  }
  function combine(s, a, b) {
    var list = combinationRecons(s.reference, a, b).map(function (c, i) {
      var r = withPins(s.work, c.recon);
      return { id: 'p' + i, label: c.label, galleryId: 'combo:' + c.id, recon: r.recon, keptPinned: r.kept, changes: [] };
    });
    return recordCandidates(s, 'combination', list, { settings: { families: [a, b] } });
  }
  function findSet(s, setId) {
    var rec = s.proposals.filter(function (p) { return p.id === setId; })[0];
    if (!rec) fail('Unknown proposal set ' + setId);
    return rec;
  }
  /** Choose a candidate (or 'keep'). Keep current never changes the reconstruction. */
  function chooseCandidate(s, setId, candId) {
    var rec = findSet(s, setId);
    var isBase = JSON.stringify(rec.base.recon) === JSON.stringify(s.work.recon);
    if (!isBase)
      throw cannotApply(rec.choice !== null && rec.choice !== 'keep'
        ? 'You already chose from these alternatives. Undo back to the version they were made from to choose a different one, or request new alternatives.'
        : 'The reconstruction changed after these alternatives were shown. Request new alternatives.');
    if (!rec.choices) rec.choices = rec.choice !== null ? [{ choice: rec.choice, time: rec.choiceTime }] : [];
    if (candId === 'keep') {
      rec.choice = 'keep'; rec.choiceTime = nowISO(); rec.choices.push({ choice: 'keep', time: rec.choiceTime });
      s.neighborhood = { round: rec.settings && rec.settings.round || 0, anchor: JSON.stringify(s.work.recon) };
      log(s, 'keep-current', { set: setId });
      return false;
    }
    var c = rec.candidates.filter(function (x) { return x.id === candId; })[0];
    if (!c) fail('Unknown candidate ' + candId);
    // Re-check pins at choice time (pins may have been added since display).
    var r = withPins(s.work, validateRecon(c.recon));
    var violated = s.work.pins.filter(function (p) { return JSON.stringify(getValue(c.recon, p)) !== JSON.stringify(getValue(s.work.recon, p)); });
    if (violated.length) throw cannotApply('This alternative would change pinned ' + violated.join(', ') + '. Request new alternatives.', violated);
    var anchorRound = rec.settings && rec.settings.round || 0;
    var revised = rec.choices.length > 0;
    commit(s, { recon: r.recon, pins: s.work.pins.slice(), origin: { type: rec.source, set: setId, candidate: candId } },
      { action: 'choose-candidate', label: 'Choose alternative ' + candId, detail: { set: setId, candidate: candId, changes: c.changes, revisedChoice: revised } });
    rec.choice = candId; rec.choiceTime = nowISO(); rec.choices.push({ choice: candId, time: rec.choiceTime });
    s.neighborhood = { round: anchorRound, anchor: JSON.stringify(s.work.recon) };
    return true;
  }
  /** Can a choice be made from this set now (i.e. is the reconstruction still the set's base)? */
  function canChoose(s, setId) {
    var rec = findSet(s, setId);
    return JSON.stringify(rec.base.recon) === JSON.stringify(s.work.recon);
  }

  // ---------------------------------------------------------------- descriptions, outcome, acceptance
  function captureDescription(s, d) {
    plainObject(d, 'description');
    str(d.text || '', 20000, 'description text');
    var region = null;
    if (d.region) {
      region = {};
      ['x0', 'y0', 'x1', 'y1'].forEach(function (k) { if (!isNum(d.region[k]) || Math.abs(d.region[k]) > 20) fail('Invalid region'); region[k] = d.region[k]; });
    }
    var rec = { id: 'd' + (s.descriptions.length + 1), time: nowISO(), text: d.text || '', region: region,
      properties: Array.isArray(d.properties) ? d.properties.filter(function (p) { return typeof p === 'string'; }).slice(0, 20) : [],
      context: typeof d.context === 'string' ? d.context.slice(0, 60) : 'still-different',
      work: clone(s.work), reference: clone(s.reference), renderer: s.work.recon.renderer, rendererVersion: s.work.recon.rendererVersion,
      softwareVersion: VERSION, aiStatus: d.aiStatus || 'unknown' };
    s.descriptions.push(rec);
    log(s, 'description-captured', { id: rec.id, length: rec.text.length, hasRegion: !!region, context: rec.context });
    return rec;
  }
  function setOutcome(s, status, note) {
    if (OUTCOMES.indexOf(status) < 0) fail('Unknown outcome ' + status);
    s.outcome = { status: status, time: nowISO(), note: typeof note === 'string' ? note.slice(0, 2000) : '', work: clone(s.work) };
    log(s, 'outcome', { status: status });
    return s.outcome;
  }
  function accept(s, status) {
    var rec = { index: s.accepted.length + 1, time: nowISO(), status: status || 'matched', work: clone(s.work), reference: clone(s.reference),
      layout: clone(s.layout), renderer: s.work.recon.renderer, rendererVersion: s.work.recon.rendererVersion, softwareVersion: VERSION };
    s.accepted.push(rec);
    log(s, 'accept', { index: rec.index, status: rec.status });
    return rec;
  }
  function setReference(s, key, value) {
    if (!REF_DEFS[key]) fail('Unknown reference field ' + key);
    var v = coerce(REF_DEFS[key], value);
    if (s.reference[key] === v) return false;
    s.reference[key] = v;
    log(s, 'reference', { key: key, value: v });
    return true;
  }
  function eyeRouting(layout) {
    if (layout.linked) {
      layout.leftEye = layout.referenceSide === 'left' ? 'AE' : 'FE';
      layout.rightEye = layout.referenceSide === 'right' ? 'AE' : 'FE';
    }
  }
  function setLayout(s, key, value, opts) {
    var next = clone(s.layout); next[key] = value;
    next = validateLayout(next, { fillDefaults: true });
    eyeRouting(next);
    if (JSON.stringify(next) === JSON.stringify(s.layout)) return false;
    s.layout = next;
    if (!(opts && opts.quiet)) log(s, 'layout', { key: key, value: value });
    return true;
  }

  // ---------------------------------------------------------------- nulling
  /**
   * Starting point for nulling: the "reverse" of a matched distortion, i.e. a stimulus that would look like the
   * reference if the eye applied the same distortion again. Exact for the geometric operations under the stated
   * assumptions (see docs/MODEL.md); a linear prediction (2S - P) for the original/plaid renderer; breaks and gaps
   * cannot be reversed and are removed. Returns {recon, notes: [plain-language caveats]}.
   */
  function reverseRecon(recon, reference) {
    var notes = [];
    recon = validateRecon(recon);
    if (recon.renderer === 'semantic-grating') {
      var p = clone(recon.params), D = SEM_DEFS;
      var set = function (k, v) { p[k] = quantize(D[k], D[k].periodic ? wrapPeriodic(D[k], v) : v); };
      set('orientation', 2 * reference.orientation - p.orientation);
      set('frequency', reference.frequency * reference.frequency / p.frequency);
      set('phase', 2 * reference.phase - p.phase);
      if (p.contrast > 0 && p.contrast < reference.contrast) { set('contrast', Math.min(1, reference.contrast * reference.contrast / p.contrast)); notes.push('Lower perceived contrast is compensated by raising contrast (capped at 1).'); }
      else set('contrast', reference.contrast);
      if (p.bendAmount > 0) set('bendPhase', p.bendPhase + 180);
      if (p.zigAmount > 0) set('zigPhase', p.zigPhase + 180);
      if (p.offsetAmount !== 0) set('offsetAmount', -p.offsetAmount);
      if (p.crossStrength > 0) { set('crossPhase', p.crossPhase + 180); notes.push('Crossing lines are reversed by adding them in counter-phase; this only cancels if they add linearly.'); }
      if (p.fragExtent > 0) { p.fragExtent = 0; notes.push('Breaks cannot be reversed (missing information); they are left out of the starting point.'); }
      if (p.holeSize > 0) { p.holeSize = 0; notes.push('A gap cannot be reversed (missing information); it is left out of the starting point.'); }
      if (p.sharpness > 0) { p.sharpness = 0; notes.push('Edge sharpness is reset to a plain sinusoid.'); }
      return { recon: validateRecon({ renderer: recon.renderer, rendererVersion: recon.rendererVersion, params: p }), notes: notes };
    }
    // Original/plaid renderer: linear prediction N = 2S - P (each component negated by phase + 180 deg and duty -K).
    var comps = recon.params.components.filter(function (c) { return c.enabled; });
    if (comps.length + 1 > LEG.maxComponents) throw cannotApply('Too many components to build the reverse; start from the straight grating instead.');
    var out = [{ id: 1, enabled: true, orientation: reference.orientation, frequency: reference.frequency, phase: reference.phase,
      duty: 0, threshold: 1, weight: quantize(LEG_DEFS.weight, 2 * reference.contrast) }];
    var sumW = 2 * reference.contrast, nonlinear = false;
    comps.forEach(function (c, i) {
      var w = quantize(LEG_DEFS.weight, c.weight * recon.params.contrast);
      sumW += w * Math.min(1, c.threshold);
      if (c.duty !== 0 || c.threshold < 1) nonlinear = true;
      out.push({ id: i + 2, enabled: true, orientation: c.orientation, frequency: c.frequency,
        phase: quantize(LEG_DEFS.phase, wrapPeriodic(LEG_DEFS.phase, c.phase + 180)), duty: quantize(LEG_DEFS.duty, -c.duty), threshold: c.threshold, weight: w });
    });
    notes.push('Linear prediction: straight grating plus (straight grating minus the matched picture).');
    if (nonlinear) notes.push('The matched picture uses clipped components, so the reverse is only approximate.');
    if (sumW > 1) notes.push('The reverse can exceed the display range and is clipped at full contrast.');
    return { recon: validateRecon({ renderer: 'legacy-rectified', rendererVersion: LEG.version, params: { contrast: 1, components: out } }), notes: notes };
  }
  var NULL_STATUSES = ['nulled', 'not-nullable', 'unstable', 'cannot-tell'];
  var NULL_CHECKS = ['opposite', 'straight', 'like-original', 'cannot-tell'];
  /**
   * Start (or repeat) nulling. opts: {adjEye: 'AE'|'FE', standard: 'other'|'none', start: 'reverse'|'straight',
   * matchWork: the matched reconstruction to reverse (default: current work)}.
   * The adjustable picture is shown to adjEye; the other eye sees the straight grating ('other') or nothing ('none').
   */
  function startNulling(s, opts) {
    opts = opts || {};
    var adjEye = opts.adjEye === 'FE' ? 'FE' : 'AE', standard = opts.standard === 'none' ? 'none' : 'other';
    var start = opts.start === 'straight' ? 'straight' : 'reverse';
    var matchWork = validateWork(clone(opts.matchWork || (s.task && s.task.kind === 'null' ? s.task.matchWork : s.work)));
    var rev = start === 'reverse' ? reverseRecon(matchWork.recon, s.reference) : { recon: identityRecon(s.reference), notes: [] };
    if (!s.nulls) s.nulls = [];
    var key = JSON.stringify(matchWork.recon);
    var repeat = s.nulls.filter(function (n) { return JSON.stringify(n.matchWork.recon) === key && n.adjEye === adjEye && n.standard === standard; }).length + 1;
    s.task = { kind: 'null', adjEye: adjEye, standard: standard, start: start, check: false, repeat: repeat, notes: rev.notes,
      matchWork: matchWork, startRecon: clone(rev.recon), startedAt: nowISO() };
    commit(s, { recon: rev.recon, pins: [], origin: { type: 'null-start', start: start, adjEye: adjEye } },
      { action: 'null-start', label: 'Start nulling (' + adjEye + ', ' + start + ')', detail: { adjEye: adjEye, standard: standard, start: start, repeat: repeat, notes: rev.notes } });
    resetNeighborhood(s);
    return s.task;
  }
  function recordNull(s, status, note) {
    if (!s.task || s.task.kind !== 'null') fail('Not nulling');
    if (NULL_STATUSES.indexOf(status) < 0) fail('Unknown nulling result ' + status);
    var t = s.task;
    var rec = { index: s.nulls.length + 1, time: nowISO(), status: status, note: typeof note === 'string' ? note.slice(0, 2000) : '',
      adjEye: t.adjEye, standard: t.standard, start: t.start, repeat: t.repeat, startRecon: clone(t.startRecon), final: clone(s.work.recon),
      matchWork: clone(t.matchWork), reference: clone(s.reference), layout: clone(s.layout), startNotes: t.notes.slice(),
      renderer: s.work.recon.renderer, rendererVersion: s.work.recon.rendererVersion, softwareVersion: VERSION, otherEyeCheck: null };
    s.nulls.push(rec);
    log(s, 'null-recorded', { index: rec.index, status: status, adjEye: t.adjEye, standard: t.standard, start: t.start, repeat: t.repeat });
    return rec;
  }
  /** Show the current null stimulus to the other eye (it should look distorted the opposite way). */
  function setNullCheck(s, on) {
    if (!s.task || s.task.kind !== 'null') fail('Not nulling');
    s.task.check = !!on;
    log(s, 'null-check-view', { on: !!on });
  }
  function recordNullCheck(s, response) {
    if (NULL_CHECKS.indexOf(response) < 0) fail('Unknown check response ' + response);
    var last = (s.nulls || [])[s.nulls.length - 1];
    if (!last) fail('Record a nulling result first');
    last.otherEyeCheck = { response: response, time: nowISO() };
    log(s, 'null-check', { index: last.index, response: response });
    return last;
  }
  /** Leave nulling; by default restore the matched reconstruction (one undoable step). */
  function endNulling(s, restore) {
    if (!s.task || s.task.kind !== 'null') return false;
    var t = s.task;
    s.task = null;
    if (restore !== false) commit(s, { recon: clone(t.matchWork.recon), pins: t.matchWork.pins.slice(), origin: { type: 'null-end' } },
      { action: 'null-end', label: 'Back to matching' });
    log(s, 'null-ended', {});
    return true;
  }

  // ---------------------------------------------------------------- structured operations (AI bridge)
  /**
   * Validate a list of bounded operations [{path, op:'set'|'delta', value}] against the
   * current work: known numeric/enum fields only, never pinned, finite, in range, <= 6 ops.
   * Returns {recon, applied, rejected}. Mirrored in distortion_lab/model.py.
   */
  function applyOperations(work, ops) {
    if (!Array.isArray(ops)) fail('operations must be an array');
    if (ops.length > 6) fail('At most 6 operations per candidate');
    var recon = clone(work.recon), applied = [], rejected = [];
    ops.forEach(function (op) {
      try {
        plainObject(op, 'operation');
        noExtraKeys(op, ['path', 'op', 'value'], 'operation');
        if (['set', 'delta'].indexOf(op.op) < 0) fail('op must be set or delta');
        var r = parsePath(recon, op.path);
        if (work.pins.indexOf(op.path) >= 0) fail(op.path + ' is pinned');
        if (r.def.type === 'boolean') fail(op.path + ' is not an adjustable control');
        var v;
        if (r.def.type === 'enum') { if (op.op !== 'set') fail('enum fields only support set'); v = coerce(r.def, op.value); }
        else {
          if (!isNum(op.value)) fail('value must be a finite number');
          var raw = op.op === 'set' ? op.value : r.obj[r.key] + op.value;
          if (raw < r.def.min || raw > r.def.max) fail(op.path + ' would leave its range [' + r.def.min + ', ' + r.def.max + ']');
          v = quantize(r.def, raw);
        }
        applied.push({ path: op.path, from: r.obj[r.key], to: v });
        r.obj[r.key] = v;
      } catch (e) { rejected.push({ op: clone(op), reason: e.message }); }
    });
    return { recon: recon, applied: applied, rejected: rejected };
  }
  /** Minimal task context sent to an AI provider: no participant label, condition or notes. */
  function aiContext(s, description, focus) {
    return { softwareVersion: VERSION, renderer: s.work.recon.renderer, rendererVersion: s.work.recon.rendererVersion,
      reference: clone(s.reference), params: clone(s.work.recon.params), pins: s.work.pins.slice(), focus: focus || 'auto',
      description: { text: description.text, region: description.region, properties: description.properties },
      geometry: { diameter: s.layout.diameter, sigma: s.layout.sigma, aperture: s.layout.aperture },
      history: s.descriptions.filter(function (d) { return d.id !== description.id && d.text; }).slice(-5).map(function (d) { return d.text.slice(0, 500); }) };
  }

  // ---------------------------------------------------------------- legacy import
  var LEGACY_OUTCOME = { matched: 'matched', approximate: 'approximate', unmatchable: 'unmatchable', unstable: 'unstable', 'not-visible': 'not-visible' };
  function legacyStateToParts(st) {
    plainObject(st, 'legacy state');
    if (st.schema !== 'distortion-lab/1') fail('Unsupported legacy state schema ' + st.schema);
    var reference = validateReference(st.reference);
    var recon = validateRecon(legacyRecon(st.model || {}));
    var l = clone(st.layout || {});
    if (st.visibility !== undefined) l.visibility = st.visibility;
    var layout = validateLayout(l, { fillDefaults: true });
    return { reference: reference, recon: recon, layout: layout };
  }
  /** Import distortion-lab/session/1, a bare distortion-lab/1 state, or a v2 session. */
  function importSession(data) {
    plainObject(data, 'file');
    if (data.schema === SESSION_SCHEMA) { var v = validateSession(clone(data)); return v; }
    var st, meta = {};
    if (data.schema === 'distortion-lab/session/1') {
      st = data.state;
      if (data.trials !== undefined && !Array.isArray(data.trials)) fail('Invalid legacy trials');
      if (data.history !== undefined && !Array.isArray(data.history)) fail('Invalid legacy history');
      (data.trials || []).forEach(function (t) { legacyStateToParts(t.state); });
      meta = data;
    } else if (data.schema === 'distortion-lab/1') { st = data; }
    else fail('Unsupported file schema ' + data.schema);
    var parts = legacyStateToParts(st);
    var s = newSession({ reference: parts.reference, layout: parts.layout, sessionId: undefined });
    s.work = { recon: parts.recon, pins: [], origin: { type: 'import', schema: data.schema, presetOrigin: meta.presetOrigin || null } };
    s.participant = typeof meta.participant === 'string' ? meta.participant.slice(0, 120) : '';
    s.condition = typeof meta.condition === 'string' ? meta.condition.slice(0, 120) : '';
    s.notes = typeof meta.notes === 'string' ? meta.notes.slice(0, 20000) : '';
    if (LEGACY_OUTCOME[meta.outcome] && (meta.trials || []).length) s.outcome = { status: LEGACY_OUTCOME[meta.outcome], time: meta.exportedAt || nowISO(), note: 'imported', work: clone(s.work) };
    s.provenance.imported = { schema: data.schema, version: meta.version || st.version || null, sessionId: meta.sessionId || null,
      startedAt: meta.startedAt || null, exportedAt: meta.exportedAt || null, presetOrigin: meta.presetOrigin || null,
      modelImplementation: meta.modelImplementation || null, source: meta.source || null, selected: st.selected,
      trials: clone(meta.trials || []), history: clone(meta.history || []), originalOutcome: meta.outcome || null };
    log(s, 'import-legacy', { schema: data.schema, presetOrigin: meta.presetOrigin || null, trials: (meta.trials || []).length });
    return s;
  }

  // ---------------------------------------------------------------- development request (Codex)
  function devRequest(s, description, images) {
    return {
      schema: 'distortion-lab/dev-request/1', createdAt: nowISO(), softwareVersion: VERSION,
      purpose: 'Development request: the participant description below could not be reproduced with the existing tested controls. ' +
        'Propose a new deterministic, documented control or renderer extension. Do not change the live experiment; add tests.',
      renderer: s.work.recon.renderer, rendererVersion: s.work.recon.rendererVersion,
      reference: clone(s.reference), current: clone(s.work), pins: s.work.pins.slice(),
      description: description ? { text: description.text, region: description.region, properties: description.properties, time: description.time } : null,
      parameterSchema: clone(P.renderers[s.work.recon.renderer]),
      images: images || null,
      privacy: 'Contains no participant label, condition or notes. Review before sharing.'
    };
  }

  return {
    VERSION: VERSION, SESSION_SCHEMA: SESSION_SCHEMA, DATA: DATA, OUTCOMES: OUTCOMES, COALESCE_MS: COALESCE_MS,
    util: { clone: clone, clamp: clamp, quantize: quantize, wrapPeriodic: wrapPeriodic, mulberry32: mulberry32, hashString: hashString, hash01: hash01, uuid: uuid },
    math: { carrier: carrier, legacyComponent: legacyComponent, legacySignal: legacySignal, envelope: envelope, semanticSignal: semanticSignal,
      semanticPrepare: semanticPrepare, triWave: triWave, stepWave: stepWave, profile: profile },
    renderRecon: renderRecon, renderReference: renderReference, referenceRecon: referenceRecon, signalFor: signalFor, maxFrequency: maxFrequency,
    identityRecon: identityRecon, legacyRecon: legacyRecon, legacyPreset: legacyPreset, semanticDefaults: semanticDefaults,
    defaultReference: defaultReference, defaultLayout: defaultLayout,
    paramList: paramList, getValue: getValue, defFor: defFor, hasPath: hasPath, withValue: withValue, labelFor: labelFor, familyLabel: familyLabel,
    activeFamilies: activeFamilies, relevantFamilies: relevantFamilies, stepFor: stepFor,
    validateReference: validateReference, validateLayout: validateLayout, validateRecon: validateRecon, validateWork: validateWork, validateSession: validateSession,
    newSession: newSession, commit: commit, endCoalesce: endCoalesce, undo: undo, redo: redo, log: log,
    setParam: setParam, nudge: nudge, togglePin: togglePin, withPins: withPins, applyRecon: applyRecon,
    addComponent: addComponent, removeComponent: removeComponent, mixLegacy: mixLegacy,
    galleryItems: galleryItems, galleryItem: galleryItem, plaidRecon: plaidRecon, galleryFamily: galleryFamily, templateRecon: templateRecon, combinationRecons: combinationRecons,
    chooseGallery: chooseGallery, recordGalleryOutcome: recordGalleryOutcome,
    generateProposals: generateProposals, requestAlternatives: requestAlternatives, recordCandidates: recordCandidates, combine: combine, chooseCandidate: chooseCandidate, canChoose: canChoose,
    captureDescription: captureDescription, setOutcome: setOutcome, accept: accept, setReference: setReference, setLayout: setLayout, eyeRouting: eyeRouting,
    applyOperations: applyOperations, aiContext: aiContext,
    reverseRecon: reverseRecon, startNulling: startNulling, recordNull: recordNull, setNullCheck: setNullCheck, recordNullCheck: recordNullCheck, endNulling: endNulling,
    NULL_STATUSES: NULL_STATUSES, NULL_CHECKS: NULL_CHECKS, importSession: importSession, devRequest: devRequest
  };
});
