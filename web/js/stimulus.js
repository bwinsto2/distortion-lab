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
      state = { reference: C.validateReference(m.reference), recon: C.validateRecon(m.recon), layout: C.validateLayout(m.layout), seqStart: m.seqStart || 0 };
      document.getElementById('status').textContent = 'linked · ' + state.recon.renderer + ' · session ' + String(m.sessionId).slice(0, 8);
    } catch (e) { document.getElementById('status').textContent = 'rejected invalid state: ' + e.message; return; }
    request();
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
    if (e.key === 'f' || e.key === 'F') present(!document.body.classList.contains('present'));
    if (e.key === 'Escape') present(false);
  });
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
