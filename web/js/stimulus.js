/* Participant stimulus window: draws exactly what the console sends. No controls. */
(function () {
  'use strict';
  var C = window.DLCore, D = window.DLDraw;
  var canvas = document.getElementById('stage'), ctx = canvas.getContext('2d', { alpha: false });
  var state = null, pending = false, cursorTimer = null;
  var bc = ('BroadcastChannel' in window) ? new BroadcastChannel('distortion-lab-v2') : null;

  function send(m) {
    if (bc) try { bc.postMessage(m); } catch (e) { /* ignore */ }
    if (window.opener) try { window.opener.postMessage(m, '*'); } catch (e) { /* ignore */ }
  }
  function accept(m) {
    if (!m || m.type !== 'state') return;
    try {
      state = { reference: C.validateReference(m.reference), recon: C.validateRecon(m.recon), layout: C.validateLayout(m.layout), seqStart: m.seqStart || 0,
        view: sanitizeView(m.view) };
      document.getElementById('status').textContent = 'linked · ' + state.recon.renderer + ' · session ' + String(m.sessionId).slice(0, 8);
    } catch (e) { document.getElementById('status').textContent = 'rejected invalid state: ' + e.message; return; }
    request();
  }
  function sanitizeView(v) {
    if (!v || typeof v !== 'object' || ['AE', 'FE', 'both'].indexOf(v.eye) < 0) return null;
    var o = v.overlay && typeof v.overlay === 'object' ? v.overlay : null, str = function (t) { return typeof t === 'string' ? t.slice(0, 80) : ''; };
    var ring = null;
    if (v.ring && typeof v.ring === 'object' && Array.isArray(v.ring.items)) {
      ring = { highlight: (v.ring.highlight | 0), items: v.ring.items.slice(0, 8).map(function (it) {
        if (!it || typeof it !== 'object') return null;
        if (it.none) return { none: true };
        try { return { recon: C.validateRecon(it.recon) }; } catch (e) { return null; }
      }) };
    }
    return { eye: v.eye, ring: ring, overlay: o ? { title: str(o.title), status: str(o.status), lines: (Array.isArray(o.lines) ? o.lines.slice(0, 6) : []).map(function (l) {
      return { text: str(l && l.text), faint: !!(l && l.faint), strong: !!(l && l.strong), bar: l && typeof l.bar === 'number' ? l.bar : undefined }; }) } : null };
  }
  if (bc) bc.onmessage = function (e) { accept(e.data); };
  window.addEventListener('message', function (e) { accept(e.data); });

  function report() {
    send({ type: 'display', w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1, fullscreen: !!document.fullscreenElement });
  }
  function draw() {
    pending = false;
    var dpr = window.devicePixelRatio || 1, W = window.innerWidth, H = window.innerHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    if (!state) { ctx.fillStyle = 'rgb(128,128,128)'; ctx.fillRect(0, 0, canvas.width, canvas.height); return; }
    D.drawDisplay(ctx, W, H, dpr, state, { scale: 1, now: Date.now(), timing: { seqStart: state.seqStart } });
    if (state.layout.comparison === 'sequential') setTimeout(request, 16);
  }
  function request() { if (!pending) { pending = true; requestAnimationFrame(draw); } }
  function present(on) {
    document.body.classList.toggle('present', on);
    if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {});
    if (!on && document.fullscreenElement) document.exitFullscreen().catch(function () {});
  }
  document.getElementById('present').addEventListener('click', function () { present(true); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'f' || e.key === 'F') { present(!document.body.classList.contains('present')); return; }
    if (e.key === 'Escape') { present(false); return; }
    // Participant controls typed in this window are forwarded to the console, which owns the state.
    if (state && state.view && window.DLController && DLController.keyAction(e.key, e.shiftKey)) {
      e.preventDefault();
      send({ type: 'key', key: e.key, shift: e.shiftKey });
    }
  });
  // ---- Mouse as a participant controller (participant controls on): wheel = knob, buttons = actions.
  // The pointer is locked to this window on the first click so the wheel keeps reaching it; Esc releases it.
  var wheelAcc = 0, holdTimer = null, held = false;
  function action(a, steps) { send({ type: 'action', action: a, steps: steps || 1 }); }
  function active() { return state && state.view; }
  canvas.addEventListener('wheel', function (e) {
    if (!active()) return;
    e.preventDefault();
    var px = e.deltaMode === 1 ? e.deltaY * 40 : (e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY);
    wheelAcc += px;
    var notch = 100;
    while (Math.abs(wheelAcc) >= notch * 0.5) {           // one step per wheel notch (trackpads accumulate)
      var dir = wheelAcc > 0 ? -1 : 1;                     // scroll up/away = increase
      wheelAcc -= -dir * notch;
      if (Math.abs(wheelAcc) < notch * 0.5) wheelAcc = 0;
      action('value', e.shiftKey ? 5 * dir : dir);
    }
  }, { passive: false });
  canvas.addEventListener('mousedown', function (e) {
    if (!active()) return;
    e.preventDefault();
    if (canvas.requestPointerLock && document.pointerLockElement !== canvas) { try { var p = canvas.requestPointerLock(); if (p && p.catch) p.catch(function () {}); } catch (err) { /* optional */ } }
    if (e.button === 0) { held = false; clearTimeout(holdTimer); holdTimer = setTimeout(function () { held = true; action('alts'); }, 900); }
    else if (e.button === 1) action('mode');
    else if (e.button === 2) action('eye');
    else if (e.button === 3) action('undo');
    else if (e.button === 4) action('alts');
  });
  canvas.addEventListener('mouseup', function (e) {
    if (!active() || e.button !== 0) return;
    clearTimeout(holdTimer);
    if (!held) action('press');
    held = false;
  });
  canvas.addEventListener('contextmenu', function (e) { if (active()) e.preventDefault(); });
  canvas.addEventListener('auxclick', function (e) { if (active()) e.preventDefault(); });
  document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement) document.body.classList.remove('present'); report(); request(); });
  document.addEventListener('mousemove', function () {
    document.body.classList.remove('hide-cursor'); clearTimeout(cursorTimer);
    cursorTimer = setTimeout(function () { document.body.classList.add('hide-cursor'); }, 1500);
  });
  window.addEventListener('resize', function () { report(); request(); });
  send({ type: 'hello' }); report(); request();
  setInterval(report, 3000);
  window.DistortionLabStimulus = { getState: function () { return state; } };
})();
