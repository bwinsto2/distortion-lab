/*
 * Distortion Lab console UI. All state changes go through DLCore functions so
 * that mouse, keyboard, external dials (/api/control) and tests share one
 * validated, pin-respecting, undoable controller API (window.DistortionLab).
 */
(function () {
  'use strict';
  var C = window.DLCore, D = window.DLDraw, K = window.DLController;
  var $ = function (id) { return document.getElementById(id); };
  var LS_KEY = 'distortion-lab:v2:autosave', LS_PREV = 'distortion-lab:v2:previous';
  var DPR = Math.min(2, window.devicePixelRatio || 1);
  var S = null;
  var backend = false, aiStatus = { provider: 'none', connected: false, label: 'AI off', detail: '' };
  var ui = { tab: 'gallery', selectedComponent: null, multi: false, multiSel: [], comboSet: null, currentSet: null, marking: false,
    region: null, structureKey: null, galleryKey: null, seqStart: Date.now(), stimWin: null, display: null, pendingResume: false,
    preview: null, stereo: { on: false, eye: 'both', mode: 'choose', ctl: 0, lib: 0, status: '', statusUntil: 0 },
    descContext: 'still-different', saveState: { local: null, server: null, error: null }, lastDesc: null, aiSet: null };
  var bc = ('BroadcastChannel' in window) ? new BroadcastChannel('distortion-lab-v2') : null;

  // ------------------------------------------------------------------ helpers
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.hidden = true; }, ms || 3200);
  }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (k) { if (k !== null && k !== undefined) e.append(k); });
    return e;
  }
  function download(name, data, type) {
    var a = document.createElement('a'), url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: type }));
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function dataURLtoBlob(u) {
    var b = atob(u.split(',')[1]), arr = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i);
    return new Blob([arr], { type: 'image/png' });
  }
  function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
  function time(iso) { try { return new Date(iso).toLocaleTimeString(); } catch (e) { return iso; } }
  function fmt(v) { return typeof v === 'number' ? String(Number(v.toFixed(4))) : String(v); }
  function geom() { return D.geomOf(S.layout); }
  function api(path, opts) {
    opts = opts || {};
    return fetch('api/' + path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok || j.ok === false) { var e = new Error(j.error || ('HTTP ' + r.status)); e.body = j; throw e; } return j; });
    });
  }

  /** Run a state-changing function; report CannotApply/validation errors without changing anything. */
  function act(fn, quiet) {
    try { var r = fn(); changed(); return r; }
    catch (e) { if (!quiet) toast(e.message, 5000); refresh(); return undefined; }
  }
  function changed() { refresh(); scheduleSave(); broadcast(); }

  // ------------------------------------------------------------------ controller API (mouse, keyboard, dials, tests)
  var Lab = {
    core: C,
    getSession: function () { return C.util.clone(S); },
    getWork: function () { return C.util.clone(S.work); },
    set: function (path, value, o) { o = o || {}; return act(function () { return C.setParam(S, path, value, { source: o.source || 'api', coalesce: o.coalesce }); }, o.quiet); },
    nudge: function (path, steps, o) { o = o || {}; return act(function () { return C.nudge(S, path, steps, { source: o.source || 'api', stepMode: o.stepMode }); }, o.quiet); },
    endEdit: function (detail) { C.endCoalesce(S, detail); scheduleSave(); },
    pin: function (path) { if (S.work.pins.indexOf(path) < 0) act(function () { C.togglePin(S, path); }); },
    unpin: function (path) { if (S.work.pins.indexOf(path) >= 0) act(function () { C.togglePin(S, path); }); },
    togglePin: function (path) { return act(function () { return C.togglePin(S, path); }); },
    undo: function () { return act(function () { var r = C.undo(S); if (!r) toast('Nothing to undo'); return r; }, true); },
    redo: function () { return act(function () { var r = C.redo(S); if (!r) toast('Nothing to redo'); return r; }, true); },
    chooseGallery: function (id) { return act(function () { return C.chooseGallery(S, id); }); },
    requestAlternatives: function (o) { ui.preview = null; var r = act(function () { return C.requestAlternatives(S, o || {}); }); if (r) { ui.currentSet = r.id; refresh(); } return r; },
    choose: function (setId, candId) { return act(function () { return C.chooseCandidate(S, setId, candId); }); },
    combine: function (a, b) { return act(function () { return C.combine(S, a, b); }); },
    setLayout: function (k, v) { return act(function () { return C.setLayout(S, k, v); }); },
    setReference: function (k, v) { return act(function () { return C.setReference(S, k, v); }); },
    captureDescription: function (d) { return act(function () { return C.captureDescription(S, d); }); },
    setOutcome: function (st) { return act(function () { C.accept(S, st); return C.setOutcome(S, st); }); },
    reconPNG: function (n) { return D.singlePNG(S.work.recon, n || 512, geom()); },
    referencePNG: function (n) { return D.singlePNG(C.referenceRecon(S.reference), n || 512, geom()); },
    saveNow: function () { return saveNow(); },
    status: function () { return { backend: backend, ai: aiStatus, save: ui.saveState }; },
    participantControls: function (on) { setStereo(!!on); },
    controllerAction: function (action, steps) { return stereoAction(action, steps === undefined ? 1 : steps, 'api'); },
    midiMessage: function (bytes) { midiMessage(bytes); },
    startControllerSetup: function () { startLearn(); },
    stereoState: function () { return C.util.clone(ui.stereo); }
  };
  window.DistortionLab = Lab;

  // ------------------------------------------------------------------ persistence
  var saveTimer = null, saveChain = Promise.resolve();
  function scheduleSave() { if (ui.pendingResume) return; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
  function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(S)); ui.saveState.local = new Date().toISOString(); ui.saveState.localError = null; }
    catch (e) { ui.saveState.localError = e.message; }
  }
  /** Saves are serialised; the returned promise resolves once the state as of this call is stored. */
  function saveNow() {
    if (ui.pendingResume) return Promise.resolve();
    clearTimeout(saveTimer);
    saveLocal();
    if (!backend) { updateSaveStatus(); return Promise.resolve(); }
    saveChain = saveChain.then(function () {
      return api('sessions/' + encodeURIComponent(S.sessionId), { method: 'PUT', body: S }).then(function (j) {
        ui.saveState.server = { time: new Date().toISOString(), revision: j.revision }; ui.saveState.error = null;
      }).catch(function (e) { ui.saveState.error = e.message; }).then(updateSaveStatus);
    });
    return saveChain;
  }
  function updateSaveStatus() {
    var p = $('saveStatus'), st = ui.saveState, parts = [];
    if (st.local) parts.push('browser ' + time(st.local));
    if (st.localError) parts.push('browser save failed');
    if (backend && st.server) parts.push('server rev ' + st.server.revision);
    if (st.error) parts.push('server save failed: ' + st.error);
    p.textContent = parts.length ? 'Autosaved · ' + parts.join(' · ') : 'Not saved yet';
    p.className = 'pill ' + (st.error || st.localError ? 'bad' : (st.local ? 'ok' : 'muted'));
  }
  window.addEventListener('beforeunload', function () { if (!ui.pendingResume && S) saveLocal(); });

  // ------------------------------------------------------------------ stimulus window link
  /** The candidate being previewed (shown large and optionally in the stimulus window), or null. */
  function previewInfo() {
    if (!ui.preview) return null;
    var rec = S.proposals.filter(function (p) { return p.id === ui.preview.setId; })[0];
    var idx = rec ? rec.candidates.map(function (c) { return c.id; }).indexOf(ui.preview.candId) : -1;
    if (idx < 0) { ui.preview = null; return null; }
    return { rec: rec, cand: rec.candidates[idx], letter: String.fromCharCode(65 + idx), choosable: C.canChoose(S, rec.id) };
  }
  function setPreview(setId, candId) {
    var same = ui.preview && ui.preview.setId === setId && ui.preview.candId === candId;
    ui.preview = (candId && !same) ? { setId: setId, candId: candId } : null;
    if (ui.preview) C.log(S, 'preview-candidate', { set: setId, candidate: candId });
    refresh(); broadcast(); scheduleSave();
  }
  function stimMessage() {
    var pv = previewInfo(), showPv = pv && (ui.stereo.on || $('previewOnStim').checked);
    var recon = showPv ? pv.cand.recon : S.work.recon;
    return { type: 'state', reference: S.reference, recon: recon, layout: S.layout, seqStart: ui.seqStart, sessionId: S.sessionId, previewing: !!showPv,
      view: ui.stereo.on ? { eye: ui.stereo.eye, overlay: stereoOverlay(), ring: ui.stereo.mode === 'choose' ? stereoRing() : null } : null };
  }
  function broadcast() {
    if (!S) return;
    var m = stimMessage();
    if (bc) try { bc.postMessage(m); } catch (e) { /* ignore */ }
    if (ui.stimWin && !ui.stimWin.closed) try { ui.stimWin.postMessage(m, '*'); } catch (e) { /* ignore */ }
  }
  function onStimMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'hello') broadcast();
    if (m.type === 'display' && typeof m.w === 'number') { ui.display = { w: m.w, h: m.h, dpr: m.dpr, fullscreen: !!m.fullscreen }; drawPreview(); }
    if (m.type === 'key' && typeof m.key === 'string') { var a = K.keyAction(m.key, !!m.shift); if (a) stereoAction(a.action, a.steps, 'keyboard'); }
    if (m.type === 'action' && K.ACTIONS.some(function (x) { return x.id === m.action; }) && typeof m.steps === 'number' && Math.abs(m.steps) <= 20)
      stereoAction(m.action, m.steps, 'mouse');
  }
  if (bc) bc.onmessage = function (e) { onStimMessage(e.data); };
  window.addEventListener('message', function (e) { if (e.source === ui.stimWin) onStimMessage(e.data); });

  // ------------------------------------------------------------------ drawing
  function drawMain() {
    var c = $('reconCanvas'), n = Math.round(360 * DPR);
    if (c.width !== n) { c.width = c.height = n; }
    var pv = previewInfo();
    D.drawSingle(c, pv ? pv.cand.recon : S.work.recon, geom());
    $('previewBar').hidden = !pv;
    $('reconTitle').textContent = pv ? 'Previewing ' + pv.letter + ' (not chosen)' : 'Current reconstruction';
    if (pv) {
      $('previewText').textContent = pv.choosable ? 'Previewing ' + pv.letter + '. Nothing has changed yet.' : 'Previewing ' + pv.letter + ' from an earlier set (Undo to choose it).';
      $('previewChoose').textContent = 'Choose ' + pv.letter;
      $('previewChoose').hidden = !pv.choosable;
    }
    var r = $('refCanvas'), m = Math.round(160 * DPR);
    if (r.width !== m) { r.width = r.height = m; }
    D.drawSingle(r, C.referenceRecon(S.reference), geom());
    $('reconInfo').textContent = '· ' + S.work.recon.renderer + '/' + S.work.recon.rendererVersion + (S.work.origin ? ' · from ' + (S.work.origin.id || S.work.origin.type) : '') +
      (S.work.pins.length ? ' · ' + S.work.pins.length + ' pinned' : '');
    drawPreview();
  }
  function drawPreview() {
    var c = $('previewCanvas'), cssW = c.clientWidth || 380;
    var disp = ui.display || { w: 1440, h: 900 };
    var cssH = Math.round(cssW * disp.h / disp.w);
    c.style.aspectRatio = disp.w + ' / ' + disp.h;
    var W = Math.round(cssW * DPR), H = Math.round(cssH * DPR);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    var sm = stimMessage();
    var info = D.drawDisplay(c.getContext('2d'), cssW, cssH, DPR, { reference: S.reference, recon: sm.recon, layout: S.layout, view: sm.view },
      { scale: cssW / disp.w, labels: true, now: Date.now(), timing: { seqStart: ui.seqStart } });
    // Warnings are evaluated at full stimulus-window scale.
    var n = Math.max(8, Math.min(2048, Math.ceil(S.layout.diameter * S.layout.ppd * ((ui.display && ui.display.dpr) || 1))));
    var w = []; var f = Math.max(S.reference.frequency, C.maxFrequency(S.work.recon));
    if (f * S.layout.diameter > n / 2) w.push('At the stimulus window resolution (' + n + ' samples across the aperture) the highest carrier frequency exceeds the Nyquist limit.');
    else if (f * S.layout.diameter > n / 4) w.push('Fewer than four samples per carrier cycle in the stimulus window; fine detail is poorly sampled.');
    info.warnings.filter(function (x) { return x.indexOf('Nyquist') < 0 && x.indexOf('four raster') < 0; }).forEach(function (x) { w.push(x); });
    $('warnings').hidden = !w.length; $('warnings').textContent = w.join(' ');
    $('previewInfo').textContent = '· ' + disp.w + '×' + disp.h + (ui.display ? (ui.display.fullscreen ? ' fullscreen' : ' window') : ' (assumed; open the stimulus window)') +
      (info.showing ? ' · showing ' + info.showing : '');
  }
  setInterval(function () { if (S && S.layout.comparison === 'sequential') drawPreview(); }, 100);

  function thumb(recon, px) {
    var c = el('canvas', { width: Math.round(px * DPR), height: Math.round(px * DPR) });
    D.drawSingle(c, recon, { diameter: S.layout.diameter, sigma: S.layout.sigma, aperture: S.layout.aperture });
    return c;
  }

  // ------------------------------------------------------------------ gallery
  function tile(opts) {
    var t = el('div', { class: 'tile' + (opts.selected ? ' selected' : '') + (opts.current ? ' current' : ''), tabindex: 0, role: 'button',
      'data-id': opts.id, title: opts.title || '' }, [
      el('span', { class: 'badge', text: opts.badge }), thumb(opts.recon, opts.px || 118),
      opts.caption ? el('div', { class: 'cap lbl', text: opts.caption }) : null,
      opts.sub ? el('div', { class: 'sub lbl', text: opts.sub }) : null]);
    if (opts.onclick) { t.addEventListener('click', opts.onclick); t.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onclick(); } }); }
    if (opts.button) t.append(opts.button);
    return t;
  }
  function buildGallery() {
    var key = JSON.stringify([S.reference, S.layout.diameter, S.layout.sigma, S.layout.aperture, ui.multi, ui.multiSel, S.work.origin]);
    if (key === ui.galleryKey) return;
    ui.galleryKey = key;
    var items = C.galleryItems(S.reference);
    var grid = $('galleryGrid'), leg = $('legacyGrid');
    grid.replaceChildren(); leg.replaceChildren();
    var num = 0;
    items.forEach(function (it) {
      var isCurrent = S.work.origin && S.work.origin.type === 'gallery' && S.work.origin.id === it.id;
      var t = tile({ id: it.id, recon: it.recon, badge: it.kind === 'legacy' ? 'L' + it.id.split(':')[1].slice(0, 3) : String(++num),
        caption: it.label, sub: it.kind === 'legacy' ? it.legacy.status : (it.kind === 'combination' ? 'combination' : ''),
        selected: ui.multi && ui.multiSel.indexOf(it.family) >= 0 && it.kind === 'family',
        current: isCurrent, title: it.legacy ? it.legacy.note : '',
        onclick: function () { onGalleryClick(it); } });
      (it.kind === 'legacy' ? leg : grid).append(t);
    });
    $('multiSelect').classList.toggle('active', ui.multi);
    $('multiHint').textContent = ui.multi ? 'Pick two pictures that each show one feature (' + ui.multiSel.length + '/2 chosen).' : '';
    $('showCombos').hidden = !(ui.multi && ui.multiSel.length === 2);
  }
  function onGalleryClick(it) {
    if (ui.multi) {
      if (it.kind !== 'family') { toast('In "more than one" mode, pick pictures that show a single feature.'); return; }
      var i = ui.multiSel.indexOf(it.family);
      if (i >= 0) ui.multiSel.splice(i, 1);
      else { if (ui.multiSel.length >= 2) ui.multiSel.shift(); ui.multiSel.push(it.family); }
      ui.galleryKey = null; buildGallery();
      return;
    }
    if (it.kind === 'legacy' && it.legacy && JSON.stringify(it.legacy.reference) !== JSON.stringify(S.reference))
      toast('Note: this original form was constructed for reference orientation ' + it.legacy.reference.orientation + '°, ' + it.legacy.reference.frequency + ' c/°.', 5000);
    if (Lab.chooseGallery(it.id) !== undefined) toast('Starting point chosen. Adjust it, or compare alternatives.');
  }
  function showCombos() {
    var rec = Lab.combine(ui.multiSel[0], ui.multiSel[1]);
    if (!rec) return;
    ui.comboSet = rec.id;
    renderCombos();
  }
  function renderCombos() {
    var rec = ui.comboSet && S.proposals.filter(function (p) { return p.id === ui.comboSet; })[0];
    $('comboArea').hidden = !rec;
    if (!rec) return;
    var g = $('comboGrid'); g.replaceChildren();
    rec.candidates.forEach(function (c, i) {
      var b = el('button', { text: rec.choice === c.id ? 'Chosen' : 'Choose', disabled: rec.choice !== null,
        onclick: function (e) { e.stopPropagation(); if (Lab.choose(rec.id, c.id)) { toast('Combination chosen. You can still revise it.'); ui.multi = false; ui.multiSel = []; ui.galleryKey = null; renderCombos(); } } });
      g.append(tile({ id: c.id, recon: c.recon, badge: String.fromCharCode(65 + i), caption: c.label,
        sub: c.keptPinned && c.keptPinned.length ? 'pinned kept: ' + c.keptPinned.map(function (k) { return k.path; }).join(', ') : '', button: b, px: 140 }));
    });
  }

  // ------------------------------------------------------------------ adjust controls
  var bindings = [];
  function controlRow(path, def, value, o) {
    var pinned = S.work.pins.indexOf(path) >= 0;
    var row = el('div', { class: 'ctrl' + (pinned ? ' pinned' : ''), 'data-path': path });
    var id = 'ctl-' + path.replace(/\W/g, '_');
    row.append(el('label', { for: id, text: (o && o.label) || def.label }));
    var input, number = null;
    if (def.type === 'enum') {
      input = el('select', { id: id, disabled: pinned }, def.choices.map(function (c) { return el('option', { value: c, text: (def.choiceLabels || {})[c] || c }); }));
      input.value = value;
      input.addEventListener('change', function () { o.onSet(path, input.value, { source: 'mouse' }); });
      row.append(input, el('span'));
    } else {
      var step = C.stepFor(def, S.settings.sliderStep);
      input = el('input', { id: id, type: 'range', min: def.min, max: def.max, step: step, value: value, disabled: pinned });
      number = el('input', { type: 'number', min: def.min, max: def.max, step: def.step, value: value, class: 'num', disabled: pinned, 'aria-label': def.label + ' value' });
      input.addEventListener('input', function () { o.onSet(path, input.value, { source: 'mouse', coalesce: 'slider:' + path }); });
      input.addEventListener('change', function () { o.onEnd(path); });
      number.addEventListener('change', function () { o.onSet(path, number.value, { source: 'keyboard' }); o.onEnd(path); });
      row.append(input, el('span', { class: 'val' }, [number, el('span', { class: 'unit', text: def.unit || '' })]));
    }
    if (o.pinnable) {
      row.append(el('button', { class: 'pinbtn', 'aria-pressed': String(pinned), title: pinned ? 'Pinned: automatic proposals and compositions will not change this. Click to unpin.' : 'Pin: keep this fixed during proposals and compositions',
        text: pinned ? 'Pinned' : 'Pin', onclick: function () { Lab.togglePin(path); } }));
    } else row.append(el('span'));
    bindings.push({ path: path, input: input, number: number, get: o.get });
    return row;
  }
  var workSet = function (path, v, o) { Lab.set(path, v, o); };
  var workEnd = function (path) { Lab.endEdit({ path: path, value: C.getValue(S.work.recon, path) }); };

  function buildControls() {
    var r = S.work.recon, st = S.settings;
    if (r.renderer === 'semantic-grating') {
      C.activeFamilies(r).forEach(function (f) { if (st.revealedFamilies.indexOf(f) < 0) st.revealedFamilies.push(f); });
    } else {
      var ids = r.params.components.map(function (c) { return c.id; });
      if (ids.indexOf(ui.selectedComponent) < 0) ui.selectedComponent = ids[0];
    }
    var key = JSON.stringify([r.renderer, r.renderer === 'legacy-rectified' ? r.params.components.map(function (c) { return [c.id, c.enabled]; }) : 0,
      C.relevantFamilies(r, st.revealedFamilies), st.includeAdvanced, S.work.pins, ui.selectedComponent, st.sliderStep]);
    if (key === ui.structureKey) { syncControls(); return; }
    ui.structureKey = key;
    bindings = [];
    var box = $('controls'); box.replaceChildren();
    var add = $('addFamilies'); add.replaceChildren();
    $('legacyTools').hidden = r.renderer !== 'legacy-rectified';
    var get = function (p) { return C.getValue(S.work.recon, p); };
    if (r.renderer === 'semantic-grating') {
      var fams = C.relevantFamilies(r, st.revealedFamilies), F = C.DATA.parameters.renderers['semantic-grating'].families;
      fams.forEach(function (f) {
        var sec = el('section', { class: 'family', 'data-family': f });
        var hdr = el('header', {}, [el('span', { text: F[f].label })]);
        if (f !== 'global' && F[f].activator && r.params[F[f].activator] === 0)
          hdr.append(el('button', { class: 'small', text: 'Hide', onclick: function () { st.revealedFamilies = st.revealedFamilies.filter(function (x) { return x !== f; }); ui.structureKey = null; refresh(); scheduleSave(); } }));
        sec.append(hdr);
        C.DATA.parameters.renderers['semantic-grating'].params.forEach(function (d) {
          if (d.family !== f || (d.advanced && !st.includeAdvanced)) return;
          sec.append(controlRow(d.key, d, r.params[d.key], { pinnable: true, onSet: workSet, onEnd: workEnd, get: get }));
        });
        box.append(sec);
      });
      Object.keys(F).forEach(function (f) {
        if (fams.indexOf(f) >= 0) return;
        add.append(el('button', { text: '+ ' + F[f].label, title: F[f].plain, onclick: function () { st.revealedFamilies.push(f); ui.structureKey = null; refresh(); scheduleSave(); C.log(S, 'reveal-controls', { family: f }); } }));
      });
      if (add.children.length) add.prepend(el('span', { class: 'muted', text: 'Add a feature:' }));
    } else {
      var L = C.DATA.parameters.renderers['legacy-rectified'];
      var out = el('section', { class: 'family' }, [el('header', { text: 'Output' })]);
      out.append(controlRow('contrast', L.contrast, r.params.contrast, { pinnable: true, onSet: workSet, onEnd: workEnd, get: get }));
      box.append(out);
      var comps = el('div', { class: 'comps' });
      r.params.components.forEach(function (c, i) {
        comps.append(el('button', { text: 'C' + (i + 1), class: (c.id === ui.selectedComponent ? 'active' : '') + (c.enabled ? '' : ' off'), 'aria-pressed': String(c.id === ui.selectedComponent),
          title: 'Component id ' + c.id, onclick: function () { ui.selectedComponent = c.id; ui.structureKey = null; refresh(); } }));
      });
      comps.append(el('button', { class: 'small', text: '+ component', disabled: r.params.components.length >= L.maxComponents, onclick: function () { var id = act(function () { return C.addComponent(S); }); if (id) { ui.selectedComponent = id; ui.structureKey = null; refresh(); } } }));
      comps.append(el('button', { class: 'small', text: '− remove', disabled: r.params.components.length <= 1, onclick: function () { act(function () { C.removeComponent(S, ui.selectedComponent); }); } }));
      var sel = r.params.components.filter(function (c) { return c.id === ui.selectedComponent; })[0];
      var sec2 = el('section', { class: 'family' }, [el('header', { text: 'Components (original synthesis; ' + r.params.components.length + ' of max ' + L.maxComponents + ')' }), comps]);
      var en = el('input', { type: 'checkbox', id: 'compEnabled' }); en.checked = sel.enabled;
      en.disabled = S.work.pins.indexOf('c' + sel.id + '.enabled') >= 0;
      en.addEventListener('change', function () { Lab.set('c' + sel.id + '.enabled', en.checked, { source: 'mouse' }); });
      sec2.append(el('label', { class: 'toggle' }, [en, ' enabled']));
      L.componentParams.forEach(function (d) {
        sec2.append(controlRow('c' + sel.id + '.' + d.key, d, sel[d.key], { pinnable: true, onSet: workSet, onEnd: workEnd, get: get }));
      });
      box.append(sec2);
    }
  }
  function syncControls() {
    bindings.forEach(function (b) {
      var v;
      try { v = b.get(b.path); } catch (e) { return; }
      if (b.input && document.activeElement !== b.input && String(b.input.value) !== String(v)) b.input.value = v;
      if (b.input && b.input.type === 'range' && document.activeElement === b.input && Number(b.input.value) !== v) b.input.value = v;
      if (b.number && document.activeElement !== b.number) b.number.value = v;
    });
  }

  function buildRefControls() {
    var box = $('refControls');
    if (box.childElementCount) { box.querySelectorAll('[data-path]').forEach(function (row) {
      var k = row.getAttribute('data-path').slice(4), inputs = row.querySelectorAll('input');
      inputs.forEach(function (i) { if (document.activeElement !== i) i.value = S.reference[k]; });
    }); return; }
    C.DATA.parameters.reference.forEach(function (d) {
      var row = controlRow('ref.' + d.key, d, S.reference[d.key], { pinnable: false,
        onSet: function (p, v) { Lab.setReference(d.key, v); }, onEnd: function () {}, get: function () { return S.reference[d.key]; } });
      box.append(row);
    });
    bindings = bindings.filter(function (b) { return b.path.indexOf('ref.') !== 0; });
  }

  // ------------------------------------------------------------------ alternatives
  function focusOptions() {
    var sel = $('altFocus'), r = S.work.recon, cur = sel.value, opts = [['auto', 'Properties shown in Adjust']];
    if (r.renderer === 'semantic-grating') {
      var F = C.DATA.parameters.renderers['semantic-grating'].families;
      Object.keys(F).forEach(function (f) { opts.push([f, 'Only: ' + F[f].label]); });
      opts.push(['all', 'Everything']);
    } else {
      opts.push(['output', 'Only: output contrast']);
      r.params.components.forEach(function (c, i) { opts.push(['c' + c.id, 'Only: component C' + (i + 1)]); });
    }
    var key = JSON.stringify(opts);
    if (sel.dataset.key !== key) {
      sel.replaceChildren.apply(sel, opts.map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      sel.dataset.key = key;
      sel.value = opts.some(function (o) { return o[0] === cur; }) ? cur : 'auto';
    }
  }
  function renderCandidates() {
    var box = $('candidates'); box.replaceChildren();
    var rec = ui.currentSet && S.proposals.filter(function (p) { return p.id === ui.currentSet; })[0];
    $('keepCurrent').hidden = true;
    if (!rec) { $('altInfo').textContent = ''; return; }
    var stale = JSON.stringify(rec.base.recon) !== JSON.stringify(S.work.recon);
    var info = [];
    if (rec.source === 'seeded') info.push('seed ' + rec.seed + ' · ' + rec.settings.scale + (rec.settings.round ? ' · repeat ' + rec.settings.round + ' (×' + Math.pow(rec.settings.shrinkFactor, rec.settings.round).toFixed(2) + ')' : '') + ' · focus ' + rec.settings.focus);
    if (rec.source === 'ai') {
      info.push((rec.isAI ? 'Suggested by AI (' + rec.provider + ' ' + rec.model + ')' : 'Test mock (not AI)') +
        (rec.judged ? ' · picked after viewing ' + rec.considered + ' rendered candidates' : '') + ' · nothing changes until you choose');
      if (rec.limitations) info.push('AI says it cannot fully do this: ' + rec.limitations);
      if (rec.judgeNotes) info.push('AI notes: ' + rec.judgeNotes);
    }
    if (rec.source === 'combination') info.push('combinations of ' + (rec.settings.families || []).join(' + '));
    if (rec.pinnedInFocus && rec.pinnedInFocus.length) info.push('pinned and left unchanged: ' + rec.pinnedInFocus.join(', '));
    if (rec.reason) info.push(rec.reason);
    var choosable = !stale;
    if (rec.choice && rec.choice !== 'keep' && stale) info.push('You chose ' + String.fromCharCode(65 + Number(rec.choice.slice(1))) + '. Undo to come back to these and choose a different one, or ask for more alternatives.');
    else if (rec.choice === 'keep') info.push('You kept the current version. You can still choose one of these.');
    else if (stale) info.push('These alternatives were made for an earlier version. Request new ones.');
    $('altInfo').textContent = info.join('\n');
    var big = !!S.settings.bigCandidates, px = big ? 300 : 150;
    box.classList.toggle('big', big);
    var pv = ui.preview && ui.preview.setId === rec.id ? ui.preview.candId : null;
    var cur = tile({ id: 'current', recon: S.work.recon, badge: '★', caption: 'Current', current: !pv, px: px,
      onclick: function () { setPreview(null, null); },
      button: el('button', { text: 'Keep current', disabled: !choosable, onclick: function (e) { e.stopPropagation(); ui.preview = null; Lab.choose(rec.id, 'keep'); } }) });
    box.append(cur);
    rec.candidates.forEach(function (c, i) {
      var L = String.fromCharCode(65 + i), chosen = rec.choice === c.id && stale;
      var t = tile({ id: c.id, recon: c.recon, badge: L + (chosen ? ' ✓' : ''), caption: c.label, px: px,
        sub: (rec.source === 'ai' && c.rationale ? c.rationale + ' — ' : '') + (c.changes && c.changes.length ? c.changes.map(function (x) { return x.path + ' ' + fmt(x.from) + '→' + fmt(x.to); }).join('; ') : ''),
        onclick: function () { setPreview(rec.id, c.id); },
        button: el('button', { text: chosen ? 'Chosen' : 'Choose ' + L, disabled: !choosable, onclick: function (e) {
          e.stopPropagation(); ui.preview = null; if (Lab.choose(rec.id, c.id)) toast('Updated. The sliders now show this version. Undo returns to these alternatives.'); } }) });
      if (pv === c.id) t.classList.add('previewing');
      if (!choosable) t.classList.add('stale');
      box.append(t);
    });
  }
  function cyclePreview(dir) {
    var rec = ui.currentSet && S.proposals.filter(function (p) { return p.id === ui.currentSet; })[0];
    if (!rec || !rec.candidates.length) return;
    var ids = [null].concat(rec.candidates.map(function (c) { return c.id; }));
    var cur = ui.preview && ui.preview.setId === rec.id ? ids.indexOf(ui.preview.candId) : 0;
    var next = ids[(cur + dir + ids.length) % ids.length];
    ui.preview = null;
    setPreview(rec.id, next);
  }

  // ------------------------------------------------------------------ describe
  var PROPS = [['global', 'Tilt, spacing or position of the stripes'], ['bend', 'Bending or waves'], ['zigzag', 'Corners, zigzags or steps'],
    ['offset', 'A shift at a boundary'], ['fragment', 'Breaks in the stripes'], ['hole', 'A missing or faint area'], ['cross', 'Extra crossing lines'],
    ['contrast', 'Too faint or too strong'], ['other', 'Something else'], ['unsure', 'Not sure']];
  function buildDescProps() {
    var box = $('descProps'); if (box.childElementCount) return;
    PROPS.forEach(function (p) { box.append(el('label', { class: 'toggle' }, [el('input', { type: 'checkbox', value: p[0] }), ' ' + p[1]])); });
  }
  function selectedProps() { return Array.prototype.map.call($('descProps').querySelectorAll('input:checked'), function (i) { return i.value; }); }
  function focusForProps(props) {
    if (S.work.recon.renderer !== 'semantic-grating') return 'auto';
    for (var i = 0; i < props.length; i++) {
      var p = props[i];
      if (p === 'contrast') return 'path:contrast';
      if (C.DATA.parameters.renderers['semantic-grating'].families[p]) return p;
    }
    return 'auto';
  }
  function saveDescription(silentIfEmpty) {
    var text = $('descText').value, props = selectedProps();
    if (!text.trim() && !ui.region && !props.length) { if (!silentIfEmpty) toast('Nothing to save yet: type a description, mark an area or choose a property.'); return null; }
    var rec = Lab.captureDescription({ text: text, region: ui.region, properties: props, context: ui.descContext, aiStatus: aiStatus.label });
    if (rec) {
      ui.lastDesc = rec;
      $('descText').value = ''; clearRegion();
      $('descProps').querySelectorAll('input:checked').forEach(function (i) { i.checked = false; });
      toast('Description saved exactly as written. The current picture is unchanged.');
    }
    return rec;
  }
  function renderDescList() {
    var box = $('descList'); box.replaceChildren();
    S.descriptions.slice().reverse().slice(0, 30).forEach(function (d) {
      box.append(el('div', {}, [el('strong', { text: d.id + ' · ' + time(d.time) + ' ' }), el('span', { text: '“' + d.text + '”' }),
        el('span', { class: 'muted', text: (d.region ? ' · area marked' : '') + (d.properties.length ? ' · ' + d.properties.join(', ') : '') + ' · ' + d.context })]));
    });
    $('outcomeInfo').textContent = S.outcome ? 'Recorded: ' + S.outcome.status + ' at ' + time(S.outcome.time) + ' (the current version was saved with it).' : '';
  }
  function updateAiUi() {
    var p = $('aiStatus');
    p.textContent = aiStatus.label;
    p.title = aiStatus.detail || '';
    p.className = 'pill ' + (aiStatus.connected === true ? (aiStatus.isAI ? 'ok' : 'off') : (aiStatus.connected === null ? 'off' : 'muted'));
    var usable = backend && aiStatus.connected !== false;
    $('aiSuggest').disabled = !usable;
    $('aiNote').textContent = usable ? (aiStatus.isAI ? 'AI suggestions are optional. Only the description, current parameters and pins are sent; never the participant label, condition or notes. Suggestions are validated and shown as alternatives; nothing changes until a choice is made.' : 'The connected provider is a deterministic test mock, not AI.')
      : 'AI bridge not connected (' + (backend ? aiStatus.detail : 'backend not running') + '). Descriptions are still saved.';
  }
  function askAI() {
    var rec = saveDescription(true) || ui.lastDesc;
    if (!rec) { toast('Please describe what looks different first.'); return; }
    var focus = focusForProps(rec.properties);
    // Seeded alternatives are sent too; the AI looks at all candidates and picks the ones that fit best.
    var poolSeed = (C.util.hashString(S.sessionId + ':ai:' + S.proposals.length)) >>> 0;
    var pool = C.generateProposals(S.work, { count: 8, seed: poolSeed, focus: focus, scale: S.settings.proposalScale,
      includeAdvanced: true, revealed: S.settings.revealedFamilies }).candidates;
    $('aiSuggest').disabled = true; $('aiSuggest').textContent = 'Asking… (up to a minute)';
    api('ai/propose', { method: 'POST', body: { work: S.work, context: C.aiContext(S, rec, focus), count: 4, pool: pool.map(function (c) { return c.recon; }) } }).then(function (j) {
      aiStatus = j.ai || aiStatus;
      var list = [];
      j.candidates.forEach(function (c) {
        if (!c.recon) return;
        var item;
        if (c.source === 'pool') {
          var pc = pool[c.poolIndex];
          if (!pc) return;
          item = { label: c.judgeReason ? 'Seeded: ' + pc.label : pc.label, changes: pc.changes, recon: pc.recon, source: 'pool' };
        } else {
          var local = C.applyOperations(S.work, c.operations);   // re-validate in the browser too
          if (!local.applied.length || JSON.stringify(local.recon) !== JSON.stringify(C.validateRecon(c.recon))) return;
          item = { label: c.label, operations: c.operations, rejected: local.rejected, recon: local.recon, source: 'ai',
            changes: local.applied.map(function (a) { return { path: a.path, label: C.labelFor(S.work.recon, a.path), from: a.from, to: a.to }; }) };
        }
        item.id = 'p' + list.length;
        item.rationale = c.judgeReason || c.rationale || '';
        list.push(item);
      });
      var set = act(function () { return C.recordCandidates(S, 'ai', list, { provider: j.provider, model: j.model, isAI: !!(j.ai && j.ai.isAI), descriptionId: rec.id,
        limitations: j.limitations || '', judged: !!j.judged, judgeNotes: j.judgeNotes || '', considered: j.considered,
        poolSeed: poolSeed, rejectedCount: (j.rejectedSets || []).length }); });
      if (set) {
        ui.currentSet = set.id; switchTab('alternatives');
        if (ui.stereo.on) { ui.stereo.mode = 'compare'; stereoFlash(list.length ? list.length + ' new suggestions' : 'No matching suggestions'); broadcast(); }
        toast(list.length ? list.length + ' suggestion(s), picked after looking at ' + j.considered + ' rendered candidates. Choose one or keep current.'
          : 'None of the candidates matched. See the note above the pictures.', 6000);
      }
    }).catch(function (e) { toast('AI request failed: ' + e.message + ' (description is saved)', 6000); if (e.body && e.body.ai) aiStatus = e.body.ai; })
      .then(function () { $('aiSuggest').textContent = 'Ask AI for suggestions'; updateAiUi(); });
  }
  function devRequest() {
    var d = ui.lastDesc || S.descriptions[S.descriptions.length - 1] || null;
    var req = C.devRequest(S, d, { reconstruction: Lab.reconPNG(256), reference: Lab.referencePNG(256) });
    C.log(S, 'dev-request-exported', { description: d && d.id });
    download('distortion-lab-dev-request-' + stamp() + '.json', JSON.stringify(req, null, 1), 'application/json');
    if (backend) api('dev-request', { method: 'POST', body: req }).then(function (j) { toast('Development request saved: ' + j.path); }).catch(function (e) { toast('Server copy failed: ' + e.message); });
    scheduleSave();
  }

  // region marking on the reconstruction canvas
  var dragStart = null;
  function clearRegion() { ui.region = null; $('markOverlay').hidden = true; $('clearRegion').hidden = true; $('regionInfo').textContent = ''; }
  function canvasPoint(e) {
    var r = $('reconCanvas').getBoundingClientRect();
    return { px: Math.min(Math.max(e.clientX - r.left, 0), r.width), py: Math.min(Math.max(e.clientY - r.top, 0), r.height), w: r.width, h: r.height };
  }
  function toDeg(p) { var d = S.layout.diameter; return { x: (p.px / p.w - 0.5) * d, y: (0.5 - p.py / p.h) * d }; }
  function drawOverlay(a, b) {
    var o = $('markOverlay'); o.hidden = false;
    o.style.left = Math.min(a.px, b.px) + 'px'; o.style.top = Math.min(a.py, b.py) + 'px';
    o.style.width = Math.abs(a.px - b.px) + 'px'; o.style.height = Math.abs(a.py - b.py) + 'px';
  }
  $('reconCanvas').addEventListener('pointerdown', function (e) { if (!ui.marking) return; dragStart = canvasPoint(e); e.target.setPointerCapture(e.pointerId); });
  $('reconCanvas').addEventListener('pointermove', function (e) { if (ui.marking && dragStart) drawOverlay(dragStart, canvasPoint(e)); });
  $('reconCanvas').addEventListener('pointerup', function (e) {
    if (!ui.marking || !dragStart) return;
    var end = canvasPoint(e), a = toDeg(dragStart), b = toDeg(end);
    dragStart = null;
    var r = function (v) { return Number(v.toFixed(3)); };
    ui.region = { x0: r(Math.min(a.x, b.x)), y0: r(Math.min(a.y, b.y)), x1: r(Math.max(a.x, b.x)), y1: r(Math.max(a.y, b.y)) };
    ui.marking = false; $('reconCanvas').parentElement.classList.remove('marking'); $('markRegion').classList.remove('active');
    $('clearRegion').hidden = false;
    $('regionInfo').textContent = 'Area marked (' + ui.region.x0 + '…' + ui.region.x1 + '°, ' + ui.region.y0 + '…' + ui.region.y1 + '°)';
  });

  // ------------------------------------------------------------------ experimenter
  var LAYOUT_NUM = ['diameter', 'sigma', 'ppd', 'separation', 'vertical', 'sequenceMs'];
  var LAYOUT_SEL = ['referenceSide', 'leftEye', 'rightEye', 'aperture', 'comparison', 'comparisonSide'];
  var LAYOUT_BOOL = ['linked', 'fixation'];
  function syncExperimenter() {
    ['participant', 'condition', 'notes'].forEach(function (k) { if (document.activeElement !== $(k)) $(k).value = S[k]; });
    LAYOUT_NUM.concat(LAYOUT_SEL).forEach(function (k) { var i = $('lay-' + k); if (document.activeElement !== i) i.value = S.layout[k]; });
    LAYOUT_BOOL.forEach(function (k) { $('lay-' + k).checked = S.layout[k]; });
    $('lay-leftEye').disabled = $('lay-rightEye').disabled = S.layout.linked;
    $('lay-sigma').disabled = S.layout.aperture !== 'gaussian';
    document.querySelectorAll('#visButtons [data-vis]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.vis === S.layout.visibility)); });
    $('toggleShowing').disabled = S.layout.comparison !== 'toggle';
    $('toggleInfo').textContent = S.layout.comparison === 'toggle' ? 'showing: ' + S.layout.toggleShowing : '';
    $('acceptInfo').textContent = S.accepted.length + ' record(s)';
    buildRefControls();
  }
  LAYOUT_NUM.forEach(function (k) { $('lay-' + k).addEventListener('change', function (e) { Lab.setLayout(k, Number(e.target.value)); }); });
  LAYOUT_SEL.forEach(function (k) { $('lay-' + k).addEventListener('change', function (e) { if (k === 'comparison') ui.seqStart = Date.now(); Lab.setLayout(k, e.target.value); }); });
  LAYOUT_BOOL.forEach(function (k) { $('lay-' + k).addEventListener('change', function (e) { Lab.setLayout(k, e.target.checked); }); });
  document.querySelectorAll('#visButtons [data-vis]').forEach(function (b) { b.addEventListener('click', function () { Lab.setLayout('visibility', b.dataset.vis); }); });
  $('toggleShowing').addEventListener('click', function () { Lab.setLayout('toggleShowing', S.layout.toggleShowing === 'reference' ? 'reconstruction' : 'reference'); });
  ['participant', 'condition', 'notes'].forEach(function (k) {
    $(k).addEventListener('input', function (e) { S[k] = e.target.value; scheduleSave(); });
    $(k).addEventListener('change', function (e) { C.log(S, 'metadata', { key: k, length: e.target.value.length }); scheduleSave(); });
  });
  $('calApply').addEventListener('click', function () {
    var d = Number($('calDist').value), pxcm = Number($('calPxcm').value);
    var ppd = d * Math.tan(Math.PI / 180) * pxcm;
    $('calOut').textContent = ppd.toFixed(1) + ' px/° (nominal: verify through the stereoscope)';
    if (isFinite(ppd)) Lab.setLayout('ppd', Math.round(ppd * 10) / 10);
  });

  function sessionDownload() {
    var copy = C.util.clone(S);
    copy.exportedAt = new Date().toISOString();
    copy.exportImages = { note: 'Browser-rendered 512 px PNGs of the saved parameters (convenience copy; parameters are canonical).',
      reconstruction: Lab.reconPNG(512), reference: Lab.referencePNG(512),
      accepted: S.accepted.map(function (a) { return D.singlePNG(a.work.recon, 512, D.geomOf(a.layout)); }) };
    download('distortion-session-' + (S.participant || 'unlabelled').replace(/[^\w-]/g, '_') + '-' + stamp() + '.json', JSON.stringify(copy, null, 1), 'application/json');
    C.log(S, 'download-json', {}); scheduleSave();
  }
  function replaceSession(next, why) {
    S = next; ui.currentSet = null; ui.comboSet = null; ui.structureKey = null; ui.galleryKey = null; ui.lastDesc = null;
    $('refControls').replaceChildren();
    toast(why); changed(); saveNow();
  }
  function loadFile(f) {
    if (f.size > 60 * 1024 * 1024) { toast('File is larger than 60 MB'); return; }
    f.text().then(function (txt) {
      var data = JSON.parse(txt);
      delete data.exportImages; delete data.exportedAt;
      var next = C.importSession(data);
      if ((S.actions.length > 3 || S.accepted.length) && !confirm('Replace the current session? It is autosaved and can be reopened from the saved-sessions list.')) return;
      saveNow();
      replaceSession(next, next.provenance && next.provenance.imported ? 'Imported original session (' + next.provenance.imported.schema + '); provenance preserved.' : 'Session opened.');
    }).catch(function (e) { toast('Could not open file: ' + e.message, 6000); });
  }
  function newSession() {
    openStart({ cancelable: true, participant: S.participant, base: S });
  }

  // ------------------------------------------------------------------ start screen (participant ID + session first)
  var startCtx = null;
  function sessionLabel(s) {
    if (!s.participant && !s.condition) return 'Practice (no ID)';
    return (s.participant || 'no ID') + (s.condition ? ' · ' + s.condition : '');
  }
  function fillSessionSuggestions() {
    var seen = {}, dl = $('sessionSuggestions');
    var add = function (v) { if (v && !seen[v]) { seen[v] = true; dl.append(el('option', { value: v })); } };
    dl.replaceChildren();
    if (S && S.condition) add(S.condition);
    if (backend) api('sessions').then(function (j) { j.sessions.forEach(function (x) { add(x.condition); }); }).catch(function () {});
  }
  /** opts: {saved: unfinished session to offer, cancelable, participant, base: session whose optics/reference carry over} */
  function openStart(opts) {
    startCtx = opts;
    var d = $('startDialog');
    $('startResumeBox').hidden = !opts.saved;
    if (opts.saved) $('startResumeText').textContent = 'Unfinished session: ' + sessionLabel(opts.saved) + ', last change ' +
      new Date(opts.saved.updatedAt).toLocaleString() + ' (' + opts.saved.actions.length + ' actions).';
    $('startParticipant').value = opts.participant || '';
    $('startSession').value = '';
    var L = (opts.base || S).layout, eye = L.leftEye === 'AE' ? 'left' : (L.rightEye === 'AE' ? 'right' : 'unset');
    document.querySelectorAll('input[name=startEye]').forEach(function (r) { r.checked = r.value === eye; });
    $('startError').textContent = '';
    $('startCancel').hidden = !opts.cancelable;
    fillSessionSuggestions();
    if (!d.open) d.showModal();
    setTimeout(function () { (opts.participant ? $('startSession') : $('startParticipant')).focus(); }, 0);
  }
  function closeStart() { $('startDialog').close(); startCtx = null; }
  function beginSession(participant, condition, eye) {
    var base = (startCtx && startCtx.base) || S;
    var layout = C.util.clone(base.layout);
    if (eye === 'left' || eye === 'right') { layout.referenceSide = eye; layout.linked = true; C.eyeRouting(layout); }
    if (startCtx && startCtx.saved) { try { localStorage.setItem(LS_PREV, JSON.stringify(startCtx.saved)); } catch (e) { /* ignore */ } }
    var prev = S && !ui.pendingResume ? S.sessionId : (startCtx && startCtx.saved ? startCtx.saved.sessionId : null);
    if (S && !ui.pendingResume) saveNow();
    var next = C.newSession({ reference: base.reference, layout: layout, participant: participant, condition: condition });
    C.log(next, 'session-started', { amblyopicEye: eye, previousSession: prev });
    ui.pendingResume = false;
    closeStart();
    replaceSession(next, participant ? 'Session started: ' + sessionLabel(next) : 'Practice session started (no participant ID).');
  }
  $('startForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var pid = $('startParticipant').value.trim(), ses = $('startSession').value.trim();
    var eye = (document.querySelector('input[name=startEye]:checked') || {}).value || 'unset';
    if (!pid) { $('startError').textContent = 'Enter a participant ID (or use "Practice without an ID").'; $('startParticipant').focus(); return; }
    if (!ses) { $('startError').textContent = 'Enter a session name, e.g. "Baseline 1".'; $('startSession').focus(); return; }
    beginSession(pid, ses, eye);
  });
  $('startPractice').addEventListener('click', function () {
    beginSession('', '', (document.querySelector('input[name=startEye]:checked') || {}).value || 'unset');
  });
  $('startResume').addEventListener('click', function () {
    var saved = startCtx.saved;
    ui.pendingResume = false; closeStart();
    S = saved; C.log(S, 'session-resumed', {}); ui.structureKey = null; ui.galleryKey = null; $('refControls').replaceChildren();
    toast('Continuing ' + sessionLabel(S) + '.'); changed();
  });
  $('startCancel').addEventListener('click', closeStart);
  $('startDialog').addEventListener('cancel', function (e) { if (!startCtx || !startCtx.cancelable) e.preventDefault(); });
  function listSessions() {
    if (!backend) { $('sessionList').textContent = 'Backend not running: only this browser autosave is available.'; return; }
    api('sessions').then(function (j) {
      var box = $('sessionList'); box.replaceChildren();
      j.sessions.forEach(function (s) {
        box.append(el('div', {}, [el('span', { text: (s.participant || '(no label)') + ' · ' + (s.condition || '') + ' · ' + (s.outcome || 'no outcome') + ' · rev ' + s.revision + ' · ' + time(s.saved_at) + ' ' }),
          el('button', { class: 'small', text: s.id === S.sessionId ? 'current' : 'Open', disabled: s.id === S.sessionId, onclick: function () {
            api('sessions/' + encodeURIComponent(s.id)).then(function (r) { saveNow(); replaceSession(C.validateSession(r.session), 'Session reopened.'); }).catch(function (e) { toast(e.message); });
          } })]));
      });
    }).catch(function (e) { $('sessionList').textContent = e.message; });
  }
  function displayPNG() {
    var disp = ui.display || { w: 1440, h: 900 };
    var c = el('canvas', { width: disp.w, height: disp.h });
    D.drawDisplay(c.getContext('2d'), disp.w, disp.h, 1, { reference: S.reference, recon: S.work.recon, layout: S.layout }, { scale: 1, now: Date.now(), timing: { seqStart: ui.seqStart } });
    return c.toDataURL('image/png');
  }
  function runChecks() {
    var out = [], ok = 0;
    function check(name, fn) { try { if (fn() !== true) throw new Error('returned false'); out.push('PASS ' + name); ok++; } catch (e) { out.push('FAIL ' + name + ': ' + e.message); } }
    var g = { diameter: 3.2, sigma: 0.53, aperture: 'circle' };
    check('Semantic identity equals legacy reference pixels', function () {
      var a = C.renderRecon(C.identityRecon(S.reference), 64, g), b = C.renderReference(S.reference, 64, g);
      return a.every(function (v, i) { return v === b[i]; });
    });
    check('All ten original presets validate and render', function () {
      return C.DATA.legacyPresets.presets.every(function (p) { var r = C.validateRecon(C.legacyRecon(p.model)); return C.renderRecon(r, 16, p.geometry).length === 1024; });
    });
    check('Undo/redo restores exact states', function () {
      var s = C.newSession(); var w0 = JSON.stringify(s.work);
      C.setParam(s, 'bendAmount', 0.1); var w1 = JSON.stringify(s.work); C.chooseGallery(s, 'cross:mild'); var w2 = JSON.stringify(s.work);
      C.undo(s); var a = JSON.stringify(s.work) === w1; C.undo(s); var b = JSON.stringify(s.work) === w0; C.redo(s); C.redo(s);
      return a && b && JSON.stringify(s.work) === w2;
    });
    check('Proposals deterministic and respect pins', function () {
      var s = C.newSession(); C.chooseGallery(s, 'bend:strong'); C.togglePin(s, 'bendAmount');
      var a = C.generateProposals(s.work, { seed: 42, focus: 'bend' }), b = C.generateProposals(s.work, { seed: 42, focus: 'bend' });
      return JSON.stringify(a) === JSON.stringify(b) && a.candidates.length > 0 && a.candidates.every(function (c) { return c.recon.params.bendAmount === s.work.recon.params.bendAmount; });
    });
    check('Keep current does not change the reconstruction', function () {
      var s = C.newSession(); var before = JSON.stringify(s.work.recon); var rec = C.requestAlternatives(s, {}); C.chooseCandidate(s, rec.id, 'keep');
      return JSON.stringify(s.work.recon) === before;
    });
    check('Malformed reconstruction rejected', function () { try { C.validateRecon({ renderer: 'semantic-grating', rendererVersion: '1.0.0', params: { orientation: NaN } }); return false; } catch (e) { return true; } });
    check('Current session validates', function () { C.validateSession(C.util.clone(S)); return true; });
    $('testOut').hidden = false; $('testOut').textContent = out.join('\n') + '\n' + ok + '/' + out.length + ' checks passed. (Software checks only; they do not establish perceptual validity.)';
  }

  // ------------------------------------------------------------------ records
  function renderRecords() {
    if (ui.tab !== 'records') return;
    var u = $('undoList'); u.replaceChildren();
    S.undo.slice().reverse().slice(0, 40).forEach(function (e) { u.append(el('div', { text: time(e.time) + ' · ' + e.label })); });
    var a = $('acceptedList'); a.replaceChildren();
    S.accepted.slice().reverse().forEach(function (r) { a.append(el('div', { text: '#' + r.index + ' · ' + r.status + ' · ' + r.renderer + ' · ' + time(r.time) })); });
    var p = $('proposalList'); p.replaceChildren();
    S.proposals.slice().reverse().slice(0, 40).forEach(function (r) { p.append(el('div', { text: r.id + ' · ' + r.source + (r.seed !== null ? ' seed ' + r.seed : '') + ' · ' + r.candidates.length + ' shown · choice: ' + (r.choice || 'none') })); });
    var l = $('actionList'); l.replaceChildren();
    S.actions.slice(-80).reverse().forEach(function (x) { l.append(el('div', { text: time(x.time) + ' ' + x.type + (x.label ? ' · ' + x.label : '') + (x.path ? ' · ' + x.path : '') })); });
  }

  // ------------------------------------------------------------------ participant controls in the stereoscope
  /** Controls the participant can step through: the same ones shown in the Adjust tab. */
  function stereoControls() {
    var r = S.work.recon, st = S.settings, out = [];
    if (r.renderer === 'semantic-grating') {
      var fams = C.relevantFamilies(r, st.revealedFamilies);
      C.DATA.parameters.renderers['semantic-grating'].params.forEach(function (d) {
        if (fams.indexOf(d.family) >= 0 && (!d.advanced || st.includeAdvanced)) out.push({ path: d.key, def: d, label: d.label });
      });
    } else {
      var en = {};
      r.params.components.forEach(function (c) { if (c.enabled) en['c' + c.id] = true; });
      C.paramList(r).forEach(function (e) {
        if (e.def.type === 'number' && (e.family === 'output' || en[e.family])) out.push({ path: e.path, def: e.def, label: C.labelFor(r, e.path) });
      });
    }
    return out;
  }
  function stereoSet() {
    var rec = ui.currentSet && S.proposals.filter(function (p) { return p.id === ui.currentSet; })[0];
    return rec && rec.candidates.length && C.canChoose(S, rec.id) ? rec : null;
  }
  /** Starting-point library for the stereoscope: unchanged, plaid types, feature families, combinations, then "None of these". */
  var libCache = { key: null, items: [] };
  function stereoLibrary() {
    var key = JSON.stringify(S.reference);
    if (libCache.key !== key) {
      libCache = { key: key, items: C.galleryItems(S.reference).filter(function (it) { return it.kind !== 'legacy'; })
        .concat([{ id: 'none', kind: 'none', label: 'None of these' }]) };
    }
    return libCache.items;
  }
  function stereoRing() {
    var lib = stereoLibrary(), st = ui.stereo;
    st.lib = ((st.lib % lib.length) + lib.length) % lib.length;
    var page = Math.floor(st.lib / 8), items = [];
    for (var i = 0; i < 8; i++) {
      var it = lib[page * 8 + i];
      items.push(!it ? null : (it.kind === 'none' ? { none: true } : { recon: it.recon }));
    }
    return { items: items, highlight: st.lib % 8 };
  }
  function stereoOverlay() {
    var st = ui.stereo, o = { title: st.mode === 'choose' ? 'CHOOSE THE CLOSEST' : (st.mode === 'adjust' ? 'ADJUST' : 'COMPARE'), lines: [],
      status: Date.now() < st.statusUntil ? st.status : '' };
    if (st.mode === 'choose') {
      var lib = stereoLibrary(), pages = Math.ceil(lib.length / 8);
      o.lines.push({ text: 'Page ' + (Math.floor(st.lib / 8) + 1) + ' of ' + pages, strong: true });
      o.lines.push({ text: 'Turn to move · press to choose', faint: true });
      return o;
    }
    if (st.mode === 'adjust') {
      var list = stereoControls();
      if (!list.length) { o.lines.push({ text: 'Nothing to adjust' }); return o; }
      st.ctl = ((st.ctl % list.length) + list.length) % list.length;
      var cur = list[st.ctl], prev = list.length > 2 ? list[(st.ctl - 1 + list.length) % list.length] : null, next = list.length > 1 ? list[(st.ctl + 1) % list.length] : null;
      var v = C.getValue(S.work.recon, cur.path), pinned = S.work.pins.indexOf(cur.path) >= 0;
      if (prev) o.lines.push({ text: prev.label, faint: true });
      var line = { text: cur.label + (pinned ? ' (fixed)' : ''), strong: true };
      if (cur.def.type === 'number') line.bar = (v - cur.def.min) / (cur.def.max - cur.def.min);
      else line.text += ': ' + ((cur.def.choiceLabels || {})[v] || v);
      o.lines.push(line);
      if (next) o.lines.push({ text: next.label, faint: true });
    } else {
      var rec = stereoSet();
      if (!rec) { o.lines.push({ text: 'Press "New alternatives" to see other versions' }); return o; }
      var pv = previewInfo();
      o.lines.push({ text: pv && pv.rec.id === rec.id ? 'Version ' + pv.letter + ' of ' + rec.candidates.length : 'Current version', strong: true });
      o.lines.push({ text: 'Turn to look through ' + rec.candidates.length + ' versions · press to choose', faint: true });
    }
    return o;
  }
  function stereoFlash(msg) {
    ui.stereo.status = msg; ui.stereo.statusUntil = Date.now() + 2200;
    clearTimeout(stereoFlash.t); stereoFlash.t = setTimeout(function () { broadcast(); drawPreview(); }, 2300);
  }
  /** One controller action from a knob/button (MIDI), the keyboard, or the stimulus window. */
  function stereoAction(action, steps, source) {
    var st = ui.stereo;
    if (!st.on || !S || ui.pendingResume) return false;
    var sign = steps < 0 ? -1 : 1;
    if (action === 'eye') { st.eye = st.eye === 'AE' ? 'FE' : (st.eye === 'FE' ? 'both' : 'AE'); }
    else if (action === 'mode') {
      st.mode = st.mode === 'choose' ? 'adjust' : (st.mode === 'adjust' ? 'compare' : 'choose');
      if (st.mode !== 'compare') ui.preview = null;
    }
    else if (st.mode === 'choose' && (action === 'value' || action === 'select')) {
      st.lib += action === 'select' ? 8 * sign : steps;
    }
    else if (st.mode === 'choose' && action === 'press') {
      var lib = stereoLibrary(), item = lib[((st.lib % lib.length) + lib.length) % lib.length];
      if (item.kind === 'none') {
        C.recordGalleryOutcome(S, 'none-close', { current: S.work.origin, source: source });
        ui.descContext = 'none-close';
        $('describeLead').textContent = 'None of the pictures were close. Please describe, in your own words, what you see.';
        switchTab('describe');
        stereoFlash('Please tell the researcher what you see');
        toast('Participant chose "None of these". Type their description in the "Still different?" tab.', 7000);
        scheduleSave();
      } else if (Lab.chooseGallery(item.id) !== undefined) {
        st.mode = 'adjust'; st.ctl = 0;
        stereoFlash('Chosen. Now adjust it');
      } else stereoFlash('Not available, please tell the researcher');
    }
    else if (st.mode === 'choose' && action === 'alts') { stereoFlash('Choose a starting picture first'); }
    else if (action === 'select') { st.ctl += sign; }
    else if (action === 'value') {
      if (st.eye === 'AE') stereoFlash('Switch to the fellow eye to adjust');
      else if (st.mode === 'adjust') {
        var list = stereoControls(), cur = list.length ? list[((st.ctl % list.length) + list.length) % list.length] : null;
        if (!cur) { /* nothing */ }
        else if (S.work.pins.indexOf(cur.path) >= 0) stereoFlash('This one is fixed');
        else if (cur.def.type === 'enum') {
          var ch = cur.def.choices, i = ch.indexOf(C.getValue(S.work.recon, cur.path));
          Lab.set(cur.path, ch[(i + sign + ch.length) % ch.length], { source: source, quiet: true });
        } else act(function () { return C.nudge(S, cur.path, steps, { source: source }); }, true);
      } else if (stereoSet()) cyclePreview(sign);
      else stereoFlash('Press "New alternatives" first');
    } else if (action === 'press') {
      if (st.mode === 'adjust') st.ctl += 1;
      else {
        var pv = previewInfo();
        if (pv && pv.choosable) { ui.preview = null; if (Lab.choose(pv.rec.id, pv.cand.id)) stereoFlash('Chosen'); }
        else stereoFlash(stereoSet() ? 'This is the current version' : 'Press "New alternatives" first');
      }
    } else if (action === 'alts') {
      var rec = Lab.requestAlternatives({ repeat: true });
      st.mode = 'compare';
      stereoFlash(rec && rec.candidates.length ? rec.candidates.length + ' new versions' : ((rec && rec.reason) || 'No other versions available'));
    } else if (action === 'undo') { ui.preview = null; Lab.undo(); stereoFlash('Undone'); }
    else return false;
    refresh(); broadcast();
    return true;
  }
  function setStereo(on) {
    ui.stereo.on = on;
    if (on) { ui.stereo.eye = 'both'; ui.stereo.mode = 'choose'; ui.stereo.lib = 0; ui.preview = null; if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }
    C.log(S, 'participant-controls', { on: on });
    refresh(); broadcast(); scheduleSave();
  }
  function syncStereo() {
    var st = ui.stereo;
    $('stereoOn').checked = st.on;
    $('stereoPill').textContent = st.on ? 'Participant controls: ' + (st.eye === 'AE' ? 'amblyopic eye' : st.eye === 'FE' ? 'fellow eye' : 'both eyes') + ' · ' + st.mode : 'Participant controls off';
    $('stereoPill').className = 'pill ' + (st.on ? 'ok' : 'muted');
    document.querySelectorAll('[data-eye]').forEach(function (b) { b.setAttribute('aria-pressed', String(st.on && b.dataset.eye === st.eye)); b.disabled = !st.on; });
    $('stereoState').textContent = st.on ? 'Mode: ' + st.mode : '';
  }

  // ---- MIDI controller (Web MIDI; Chrome/Chromium)
  var MIDI_KEY = 'distortion-lab:midi-map';
  var midi = { access: null, inputs: [], mapping: null, memo: {}, learn: null };
  try { midi.mapping = JSON.parse(localStorage.getItem(MIDI_KEY) || 'null'); } catch (e) { midi.mapping = null; }
  function midiStatus() {
    var n = midi.mapping ? Object.keys(midi.mapping).length : 0;
    $('midiStatus').textContent = !midi.access ? (n ? 'Saved setup for ' + n + ' controls; press Connect' : 'No controller connected')
      : (midi.inputs.length ? 'Connected: ' + midi.inputs.join(', ') + (n ? ' · ' + n + ' controls set up' : ' · not set up yet') : 'MIDI available, but no controller is plugged in');
    $('midiLearn').disabled = !midi.access || !midi.inputs.length;
  }
  function midiAttach() {
    midi.inputs = [];
    midi.access.inputs.forEach(function (inp) {
      inp.onmidimessage = function (ev) { midiMessage(Array.prototype.slice.call(ev.data)); };
      midi.inputs.push(inp.name || 'MIDI input');
    });
    midiStatus();
  }
  function midiConnect(silent) {
    if (!navigator.requestMIDIAccess) { if (!silent) $('midiStatus').textContent = 'This browser has no MIDI support. Use Chrome or Chromium.'; return; }
    navigator.requestMIDIAccess().then(function (acc) { midi.access = acc; acc.onstatechange = midiAttach; midiAttach(); },
      function (e) { if (!silent) $('midiStatus').textContent = 'MIDI access was refused (' + e.message + '). Allow MIDI for this page in the browser settings.'; });
  }
  function midiMessage(bytes) {
    var m = K.parse(bytes);
    if (midi.learn) { learnFeed(m); return; }
    K.decode(midi.mapping, m, midi.memo).forEach(function (a) { stereoAction(a.action, a.steps, 'midi'); });
  }
  function learnPrompt() {
    var L = midi.learn, a = K.ACTIONS[L.i];
    $('midiLearnBox').hidden = false;
    $('midiLearnText').textContent = 'Step ' + (L.i + 1) + ' of ' + K.ACTIONS.length + ': ' + a.label + (L.msg ? ' — ' + L.msg : '');
  }
  function learnNext() {
    var L = midi.learn;
    L.i++; L.buf = []; L.msg = '';
    if (L.i >= K.ACTIONS.length) {
      midi.mapping = L.map; midi.memo = {};
      try { localStorage.setItem(MIDI_KEY, JSON.stringify(midi.mapping)); } catch (e) { /* ignore */ }
      midi.learn = null; $('midiLearnBox').hidden = true;
      C.log(S, 'controller-setup', { controls: Object.keys(midi.mapping) });
      toast('Controller set up. Turn on participant controls to use it.');
      midiStatus(); return;
    }
    learnPrompt();
  }
  function learnFeed(m) {
    var L = midi.learn, a = K.ACTIONS[L.i];
    if (a.kind === 'press') {
      var b = K.learnPress(m);
      if (b) { L.map[a.id] = b; learnNext(); }
      return;
    }
    if (m.type !== 'cc') return;
    L.buf.push(m);
    clearTimeout(L.timer);
    L.timer = setTimeout(function () {
      var b = K.learnTurn(L.buf);
      if (b) { L.map[a.id] = b; learnNext(); }
      else { L.buf = []; L.msg = 'did not catch that, please turn it again'; learnPrompt(); }
    }, 1500);
  }
  function startLearn() { midi.learn = { i: 0, buf: [], map: {}, msg: '' }; learnPrompt(); }

  // ------------------------------------------------------------------ tabs, refresh
  function switchTab(t) {
    if (t !== ui.tab && ui.preview) { ui.preview = null; broadcast(); }
    ui.tab = t;
    document.querySelectorAll('.tabs [data-tab]').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === t); b.setAttribute('aria-selected', String(b.dataset.tab === t)); });
    document.querySelectorAll('.tab').forEach(function (p) { p.hidden = p.id !== 'tab-' + t; });
    if (t === 'experimenter') listSessions();
    refresh();
  }
  function refresh() {
    if (!S) return;
    $('sessionPill').textContent = ui.pendingResume ? 'No session' : sessionLabel(S);
    syncStereo();
    $('undo').disabled = !S.undo.length; $('redo').disabled = !S.redo.length;
    $('undo').title = S.undo.length ? 'Undo: ' + S.undo[S.undo.length - 1].label : 'Nothing to undo';
    $('redo').title = S.redo.length ? 'Redo: ' + S.redo[S.redo.length - 1].label : 'Nothing to redo';
    document.querySelectorAll('input[name=sliderStep]').forEach(function (r) { r.checked = r.value === S.settings.sliderStep; });
    document.querySelectorAll('input[name=propScale]').forEach(function (r) { r.checked = r.value === S.settings.proposalScale; });
    $('showAdvanced').checked = S.settings.includeAdvanced;
    $('shrink').checked = S.settings.shrinkRepeated;
    $('bigCands').checked = !!S.settings.bigCandidates;
    $('showLabels').checked = S.settings.showLabels;
    document.body.classList.toggle('nolabels', !S.settings.showLabels || $('participantMode').checked);
    drawMain();
    buildGallery(); renderCombos();
    buildControls();
    focusOptions(); renderCandidates();
    buildDescProps(); renderDescList();
    syncExperimenter();
    renderRecords();
  }

  // ------------------------------------------------------------------ static wiring
  document.querySelectorAll('.tabs [data-tab]').forEach(function (b) { b.addEventListener('click', function () { switchTab(b.dataset.tab); }); });
  $('undo').addEventListener('click', Lab.undo);
  $('redo').addEventListener('click', Lab.redo);
  $('participantMode').addEventListener('change', function (e) {
    document.body.classList.toggle('participant', e.target.checked);
    C.log(S, 'participant-layout', { on: e.target.checked });
    if (e.target.checked && (ui.tab === 'experimenter' || ui.tab === 'records')) switchTab('gallery'); else refresh();
  });
  $('openStimulus').addEventListener('click', function () {
    ui.stimWin = window.open('stimulus.html', 'distortion-lab-stimulus', 'popup,width=1280,height=800');
    if (!ui.stimWin) toast('The browser blocked the window. Allow pop-ups for this page, or open stimulus.html manually.');
    C.log(S, 'open-stimulus-window', {});
    setTimeout(broadcast, 500);
  });
  $('multiSelect').addEventListener('click', function () {
    ui.multi = !ui.multi; ui.multiSel = []; ui.galleryKey = null;
    if (ui.multi) C.recordGalleryOutcome(S, 'more-than-one', {});
    buildGallery(); scheduleSave();
  });
  $('showCombos').addEventListener('click', showCombos);
  $('comboBack').addEventListener('click', function () { ui.comboSet = null; renderCombos(); });
  $('noneClose').addEventListener('click', function () {
    C.recordGalleryOutcome(S, 'none-close', { current: S.work.origin });
    ui.descContext = 'none-close';
    $('describeLead').textContent = 'None of the pictures were close. Please describe, in your own words, what you see.';
    scheduleSave(); switchTab('describe');
  });
  document.querySelectorAll('input[name=sliderStep]').forEach(function (r) { r.addEventListener('change', function () { S.settings.sliderStep = r.value; C.log(S, 'setting', { sliderStep: r.value }); ui.structureKey = null; refresh(); scheduleSave(); }); });
  document.querySelectorAll('input[name=propScale]').forEach(function (r) { r.addEventListener('change', function () { S.settings.proposalScale = r.value; C.log(S, 'setting', { proposalScale: r.value }); scheduleSave(); }); });
  $('showAdvanced').addEventListener('change', function (e) { S.settings.includeAdvanced = e.target.checked; ui.structureKey = null; refresh(); scheduleSave(); });
  $('shrink').addEventListener('change', function (e) { S.settings.shrinkRepeated = e.target.checked; scheduleSave(); });
  $('showLabels').addEventListener('change', function (e) { S.settings.showLabels = e.target.checked; refresh(); scheduleSave(); });
  $('stereoOn').addEventListener('change', function (e) { setStereo(e.target.checked); });
  document.querySelectorAll('[data-eye]').forEach(function (b) { b.addEventListener('click', function () { ui.stereo.eye = b.dataset.eye; refresh(); broadcast(); }); });
  $('midiConnect').addEventListener('click', function () { midiConnect(false); });
  $('midiLearn').addEventListener('click', startLearn);
  $('midiLearnSkip').addEventListener('click', function () { if (midi.learn) learnNext(); });
  $('midiLearnCancel').addEventListener('click', function () { midi.learn = null; $('midiLearnBox').hidden = true; });
  $('bigCands').addEventListener('change', function (e) { S.settings.bigCandidates = e.target.checked; refresh(); scheduleSave(); });
  $('previewOnStim').addEventListener('change', function () { broadcast(); });
  $('previewBack').addEventListener('click', function () { setPreview(null, null); });
  $('previewChoose').addEventListener('click', function () {
    var pv = previewInfo(); if (!pv) return;
    ui.preview = null;
    if (Lab.choose(pv.rec.id, pv.cand.id)) toast('Chose ' + pv.letter + '. Undo returns to these alternatives.');
  });
  $('showAlts').addEventListener('click', function () { Lab.requestAlternatives({ focus: $('altFocus').value }); });
  $('repeatAlts').addEventListener('click', function () { Lab.requestAlternatives({ focus: $('altFocus').value, repeat: true }); });
  $('markRegion').addEventListener('click', function () { ui.marking = !ui.marking; $('markRegion').classList.toggle('active', ui.marking); $('reconCanvas').parentElement.classList.toggle('marking', ui.marking); if (ui.marking) toast('Drag on the picture to mark the area.'); });
  $('clearRegion').addEventListener('click', clearRegion);
  $('saveDesc').addEventListener('click', function () { saveDescription(false); });
  $('descAlts').addEventListener('click', function () {
    var props = selectedProps(), rec = saveDescription(true);
    var focus = focusForProps(rec ? rec.properties : props);
    if (Lab.requestAlternatives({ focus: focus })) { $('altFocus').value = focus.indexOf('path:') === 0 ? 'auto' : focus; switchTab('alternatives'); }
  });
  $('aiSuggest').addEventListener('click', askAI);
  $('devRequest').addEventListener('click', devRequest);
  document.querySelectorAll('#outcomeButtons [data-outcome]').forEach(function (b) { b.addEventListener('click', function () {
    var pending = $('descText').value.trim() ? saveDescription(true) : null; void pending;
    Lab.setOutcome(b.dataset.outcome); toast('Recorded: ' + b.textContent + '. The current version is kept with it.');
  }); });
  $('newSession').addEventListener('click', newSession);
  $('saveJson').addEventListener('click', sessionDownload);
  $('loadJson').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function (e) { var f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
  $('pngRecon').addEventListener('click', function () { download('reconstruction-' + stamp() + '.png', dataURLtoBlob(Lab.reconPNG(512))); C.log(S, 'png-export', { what: 'reconstruction' }); });
  $('pngRef').addEventListener('click', function () { download('reference-' + stamp() + '.png', dataURLtoBlob(Lab.referencePNG(512))); C.log(S, 'png-export', { what: 'reference' }); });
  $('pngDisplay').addEventListener('click', function () { download('display-' + stamp() + '.png', dataURLtoBlob(displayPNG())); C.log(S, 'png-export', { what: 'display' }); });
  $('serverExport').addEventListener('click', function () {
    if (!backend) { toast('Backend not running: use the JSON/PNG downloads instead.'); return; }
    C.log(S, 'server-export', {});
    api('sessions/' + encodeURIComponent(S.sessionId) + '/export', { method: 'POST', body: { session: S, size: 512, browserPngs: { reconstruction: Lab.reconPNG(512), reference: Lab.referencePNG(512) } } })
      .then(function (j) { toast('Exported to ' + j.path, 7000); }).catch(function (e) { toast('Export failed: ' + e.message); });
  });
  $('acceptRecord').addEventListener('click', function () { act(function () { return C.accept(S, $('acceptStatus').value); }); toast('Recorded current reconstruction.'); });
  $('sessionsDetails').addEventListener('toggle', listSessions);
  $('aiCheck').addEventListener('click', function () {
    if (!backend) { toast('Backend not running.'); return; }
    api('ai/check', { method: 'POST', body: {} }).then(function (j) { aiStatus = j.ai; updateAiUi(); toast(aiStatus.label + ': ' + aiStatus.detail); });
  });
  $('runTests').addEventListener('click', runChecks);
  C.DATA.legacyPresets.presets.forEach(function (p) {
    var label = String(p.index).padStart(2, '0') + ' · ' + p.name;
    $('legacyLoad').append(el('option', { value: p.id, text: label }));
    $('mixA').append(el('option', { value: p.id, text: label }));
    $('mixB').append(el('option', { value: p.id, text: label }));
  });
  $('mixA').prepend(el('option', { value: 'current', text: 'current reconstruction' })); $('mixA').value = 'current'; $('mixB').value = 'wavy';
  $('mixGo').addEventListener('click', function () { act(function () { return C.mixLegacy(S, $('mixA').value, $('mixB').value, Number($('mixWa').value), Number($('mixWb').value)); }); });
  $('legacyLoadGo').addEventListener('click', function () {
    var p = C.legacyPreset($('legacyLoad').value);
    act(function () {
      C.applyRecon(S, C.legacyRecon(p.model), { action: 'load-legacy-preset', label: 'Load original form ' + p.name, origin: { type: 'legacy-preset', id: p.id } });
      Object.keys(p.reference).forEach(function (k) { C.setReference(S, k, p.reference[k]); });
    });
    $('refControls').replaceChildren(); refresh();
  });
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t.type === 'text' || !t.type))) return;
    var mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (ui.stereo.on && !mod && !e.altKey && t.tagName !== 'INPUT' && t.tagName !== 'SELECT' && !$('startDialog').open) {
      var ka = K.keyAction(e.key, e.shiftKey);
      if (ka) { e.preventDefault(); stereoAction(ka.action, ka.steps, 'keyboard'); return; }
    }
    if (ui.tab === 'alternatives' && !mod && t.tagName !== 'SELECT' && t.tagName !== 'INPUT') {
      if (e.key === 'ArrowRight') { e.preventDefault(); cyclePreview(1); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); cyclePreview(-1); return; }
      if (e.key === 'Escape' && ui.preview) { e.preventDefault(); setPreview(null, null); return; }
    }
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); Lab.undo(); }
    else if ((mod && k === 'z' && e.shiftKey) || (mod && k === 'y')) { e.preventDefault(); Lab.redo(); }
  });

  // ------------------------------------------------------------------ external controls (dials) via backend SSE
  function handleControl(m) {
    var src = m.source || 'external';
    if (m.op === 'set') Lab.set(m.path, m.value, { source: src, coalesce: 'ext:' + m.path });
    else if (m.op === 'nudge') act(function () { return C.nudge(S, m.path, m.steps, { source: src, stepMode: m.stepMode }); });
    else if (m.op === 'endEdit') Lab.endEdit({ source: src });
    else if (m.op === 'undo') Lab.undo();
    else if (m.op === 'redo') Lab.redo();
    else if (m.op === 'pin') Lab.pin(m.path);
    else if (m.op === 'unpin') Lab.unpin(m.path);
  }
  function connectControls() {
    if (!window.EventSource) return;
    var es = new EventSource('api/control/stream');
    es.onmessage = function (e) { try { handleControl(JSON.parse(e.data)); } catch (err) { toast('Control message rejected: ' + err.message); } };
    es.onerror = function () { /* EventSource reconnects automatically */ };
  }

  // ------------------------------------------------------------------ startup
  function start() {
    $('version').textContent = 'v' + C.VERSION;
    if (window.DL_PREVIEW_NOTE) ['openStimulus', 'saveJson', 'pngRecon', 'pngRef', 'pngDisplay', 'serverExport', 'devRequest'].forEach(function (id) { $(id).hidden = true; });
    var saved = null;
    try { var raw = localStorage.getItem(LS_KEY); if (raw) saved = C.validateSession(JSON.parse(raw)); } catch (e) { saved = null; }
    S = C.newSession(saved ? { reference: saved.reference, layout: saved.layout } : {});
    // The start screen comes first: participant ID and session (or continue an unfinished session).
    ui.pendingResume = true;
    var unfinished = saved && (saved.actions.length > 1 || saved.descriptions.length || saved.accepted.length) ? saved : null;
    openStart({ saved: unfinished, cancelable: false, participant: unfinished ? unfinished.participant : '', base: saved || S });
    refresh(); broadcast();
    if (midi.mapping) midiConnect(true);
    midiStatus();
    fetch('api/status').then(function (r) { return r.json(); }).then(function (j) {
      backend = !!j.ok; aiStatus = j.ai;
      $('backendStatus').textContent = 'Backend connected'; $('backendStatus').className = 'pill ok'; $('backendStatus').title = 'Data folder: ' + j.dataDir + ' · Python ' + j.python;
      connectControls(); updateAiUi(); scheduleSave();
    }).catch(function () {
      backend = false;
      $('backendStatus').textContent = 'Browser-only'; $('backendStatus').className = 'pill off';
      if (window.DL_PREVIEW_NOTE) $('browserOnly').innerHTML = window.DL_PREVIEW_NOTE;
      $('browserOnly').hidden = false; updateAiUi(); scheduleSave();
    });
  }
  start();
})();
