/* Participant stimulus window: draws exactly what the console sends. No controls. */
(function () {
  'use strict';
  var C = window.DLCore, D = window.DLDraw;
  var canvas = document.getElementById('stage'), ctx = canvas.getContext('2d', { alpha: false });
  var state = null, pending = false, cursorTimer = null, lastInfo = null;
  var bc = ('BroadcastChannel' in window) ? new BroadcastChannel('distortion-lab-v2') : null;

  // Each message goes out on both channels (BroadcastChannel and the opener), so the console can receive it twice:
  // a unique id lets it apply every key, click and wheel step exactly once.
  var sendId = Math.random().toString(36).slice(2), sendSeq = 0;
  function send(m) {
    m.mid = sendId + ':' + (++sendSeq);
    if (bc) try { bc.postMessage(m); } catch (e) { /* ignore */ }
    if (window.opener) try { window.opener.postMessage(m, '*'); } catch (e) { /* ignore */ }
  }
  function accept(m) {
    if (!m || m.type !== 'state') return;
    try {
      state = { reference: C.validateReference(m.reference), recon: C.validateRecon(m.recon), layout: C.validateLayout(m.layout), seqStart: m.seqStart || 0,
        view: sanitizeView(m.view), task: sanitizeTask(m.task), tutorial: sanitizeTutorial(m.tutorial),
        align: m.align && typeof m.align === 'object' ? { selected: m.align.selected === 'left' || m.align.selected === 'right' ? m.align.selected : null } : null };
      document.getElementById('status').textContent = 'linked · ' + state.recon.renderer + ' · session ' + String(m.sessionId).slice(0, 8);
    } catch (e) { document.getElementById('status').textContent = 'rejected invalid state: ' + e.message; return; }
    request();
  }
  function sanitizeTask(t) {
    if (!t || typeof t !== 'object' || t.kind !== 'null') return null;
    return { kind: 'null', adjEye: t.adjEye === 'FE' ? 'FE' : 'AE', standard: t.standard === 'none' ? 'none' : 'other', check: !!t.check };
  }
  /** Controls tutorial screen (see tutorial.js / DLDraw.drawTutorial). Only known fields, bounded strings. */
  function sanitizeTutorial(t) {
    if (!t || typeof t !== 'object') return null;
    var str = function (x, n) { return typeof x === 'string' ? x.slice(0, n || 200) : ''; };
    var num = function (x) { return typeof x === 'number' && isFinite(x) ? x : 0; };
    var sc = t.scene && typeof t.scene === 'object' ? t.scene : {}, kinds = ['none', 'align', 'ring', 'picture', 'mode', 'eye'];
    var scene = { kind: kinds.indexOf(sc.kind) >= 0 ? sc.kind : 'none', dx: Math.max(-3, Math.min(3, num(sc.dx))), dy: Math.max(-3, Math.min(3, num(sc.dy))),
      caption: str(sc.caption, 60), label: str(sc.label, 80), button: str(sc.button, 20), mode: str(sc.mode, 12), eye: ['AE', 'FE', 'both'].indexOf(sc.eye) >= 0 ? sc.eye : 'both' };
    if (scene.kind === 'ring' && sc.ring && Array.isArray(sc.ring.items)) {
      scene.ring = { highlight: sc.ring.highlight | 0, target: typeof sc.ring.target === 'number' ? sc.ring.target | 0 : -1,
        items: sc.ring.items.slice(0, 8).map(function (it) { try { return it && it.recon ? { recon: C.validateRecon(it.recon) } : null; } catch (e) { return null; } }) };
    } else if (scene.kind === 'ring') scene.kind = 'none';
    if (Array.isArray(sc.lines)) scene.lines = sc.lines.slice(0, 6).map(function (l) {
      return { text: str(l && l.text, 80), faint: !!(l && l.faint), strong: !!(l && l.strong), bar: l && typeof l.bar === 'number' ? l.bar : undefined,
        target: l && typeof l.target === 'number' ? l.target : undefined }; });
    return { progress: str(t.progress, 40), section: str(t.section, 60), title: str(t.title, 120), how: str(t.how, 200),
      text: (Array.isArray(t.text) ? t.text.slice(0, 6) : []).map(function (x) { return str(x, 300); }),
      feedback: t.feedback && typeof t.feedback === 'object' ? { ok: !!t.feedback.ok, text: str(t.feedback.text, 200) } : null, scene: scene };
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
    if (!tutButtonStep()) vcur = null; else if (!vcur) vcur = { x: 0, y: 0 };
    lastInfo = D.drawDisplay(ctx, W, H, dpr, state, { scale: 1, now: Date.now(), timing: { seqStart: state.seqStart }, cursor: vcur });
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
    // Alignment keys (as in the lab battery) and participant controls typed here go to the console, which owns the state.
    if (state && state.align && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '4', '6', 'l', 'L', 'r', 'R', '7', '9', '0', 'Enter'].indexOf(e.key) >= 0) {
      e.preventDefault(); send({ type: 'alignKey', key: e.key }); return;
    }
    if (state && !state.align && state.layout && state.layout.fusionBox && (e.key === 'c' || e.key === 'C') &&
        !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); send({ type: 'recalibrate' }); return;
    }
    if (state && state.view && window.DLController && DLController.keyAction(e.key, e.shiftKey)) {
      e.preventDefault();
      send({ type: 'key', key: e.key, shift: e.shiftKey });
    }
  });
  // ---- Mouse as a participant controller (participant controls on): wheel = knob, buttons = actions.
  // The pointer is locked to this window on the first click so the wheel keeps reaching it; Esc releases it.
  var wheelAcc = 0, holdTimer = null, held = false, skipUp = false;
  // Tutorial only: an on-screen Undo button, for mice without a "back" side button. The pointer is locked (and hidden),
  // so the tutorial draws its own arrow in both eyes' boxes, moved by the mouse (vcur, in degrees from the box centre).
  var vcur = null;
  function tutButtonStep() { return !!(state && state.tutorial && state.tutorial.scene && state.tutorial.scene.button); }
  function onTutButton() {
    var b = lastInfo && lastInfo.tutorialButton;
    return !!(tutButtonStep() && vcur && b && Math.abs(vcur.x - b.x) <= b.w / 2 && Math.abs(vcur.y - b.y) <= b.h / 2);
  }
  function action(a, steps) { send({ type: 'action', action: a, steps: steps || 1 }); }
  function active() { return state && state.view; }
  var lastIgnored = 0;
  function ignored() {                                    // tell the console so the experimenter sees why nothing happens
    if (!state || Date.now() - lastIgnored < 2000) return;
    lastIgnored = Date.now(); send({ type: 'ignoredInput' });
  }
  canvas.addEventListener('wheel', function (e) {
    if (state && state.align) {                          // alignment: scroll = apart/together, Shift+scroll = vertical
      e.preventDefault();
      var up = (e.deltaY || e.deltaX) < 0;
      send({ type: 'alignKey', key: e.shiftKey ? (up ? 'ArrowUp' : 'ArrowDown') : (up ? 'ArrowRight' : 'ArrowLeft') });
      return;
    }
    if (!active()) { ignored(); return; }
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
    if (state && state.align) {
      e.preventDefault();
      if (e.button === 0) { send({ type: 'alignKey', key: 'Enter' }); skipUp = true; }
      // In the controls tutorial, other buttons are reported too, so a wrong button gets "incorrect control" feedback.
      else if (state.tutorial) action(['', 'mode', 'eye', 'undo', 'alts'][e.button] || 'press');
      return;
    }
    if (!active()) { ignored(); return; }
    e.preventDefault();
    if (canvas.requestPointerLock && document.pointerLockElement !== canvas) { try { var p = canvas.requestPointerLock(); if (p && p.catch) p.catch(function () {}); } catch (err) { /* optional */ } }
    if (e.button === 0) { held = false; clearTimeout(holdTimer); holdTimer = setTimeout(function () { held = true; action('alts'); }, 900); }
    else if (e.button === 1) action('mode');
    else if (e.button === 2) action('eye');
    else if (e.button === 3) action('undo');
    else if (e.button === 4) action('alts');
  });
  canvas.addEventListener('mouseup', function (e) {
    if (skipUp) { skipUp = false; return; }               // the click that accepted alignment is not a "press"
    if (!active() || e.button !== 0) return;
    clearTimeout(holdTimer);
    if (!held) action(onTutButton() ? 'undo' : 'press');
    held = false;
  });
  canvas.addEventListener('contextmenu', function (e) { if (active() || (state && state.align)) e.preventDefault(); });
  canvas.addEventListener('auxclick', function (e) { if (active()) e.preventDefault(); });
  document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement) document.body.classList.remove('present'); report(); request(); });
  document.addEventListener('mousemove', function (e) {
    if (tutButtonStep() && vcur) {
      var ppdCss = state.layout.ppd / (window.devicePixelRatio || 1), lim = (state.layout.fusionBox ? state.layout.boxSize : 15) / 2 - 0.8;
      vcur.x = Math.max(-lim, Math.min(lim, vcur.x + (e.movementX || 0) / ppdCss));
      vcur.y = Math.max(-lim, Math.min(lim, vcur.y + (e.movementY || 0) / ppdCss));
      request();
      if (document.body.classList.contains('present')) return;      // keep the system pointer hidden; our arrow is the cursor
    }
    document.body.classList.remove('hide-cursor'); clearTimeout(cursorTimer);
    cursorTimer = setTimeout(function () { document.body.classList.add('hide-cursor'); }, 1500);
  });
  window.addEventListener('resize', function () { report(); request(); });
  send({ type: 'hello' }); report(); request();
  setInterval(report, 3000);
  window.DistortionLabStimulus = { getState: function () { return state; }, getInfo: function () { return lastInfo; }, getCursor: function () { return vcur; } };
})();
