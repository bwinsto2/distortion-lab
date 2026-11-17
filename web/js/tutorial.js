/*
 * Participant controls tutorial, shown in the stereoscope (stimulus window).
 *
 * Walks the participant through every screen of the distortion task (Choose, Adjust, switching steps, Compare,
 * switching eyes, undo); calibrating the fusion boxes is not part of it, says which mouse control does what, and has them practise each one. Every input is
 * judged: "Correct control!" or "Incorrect control: that was ... Try: ...". Practice happens on the tutorial's own
 * copies of the pictures and box positions, so it never changes the session's reconstruction, alignment or history;
 * only the tutorial's own progress is logged (tutorial-start, tutorial-step, tutorial-end).
 *
 * The console owns it (app.js): participant actions and alignment keys are passed to action() / alignKey() while it
 * runs, and payload() is sent to the stimulus window as state.tutorial (drawn by DLDraw.drawDisplay).
 */
(function (root) {
  'use strict';
  var C = root.DLCore;

  var NAMES = {
    scroll: function (src) { return src === 'keyboard' ? 'the ← → arrow keys' : 'scrolling the wheel'; },
    shiftScroll: function () { return 'Shift + scroll'; },
    press: function (src) { return src === 'keyboard' ? 'the Enter key' : 'a quick left click'; },
    hold: function (src) { return src === 'keyboard' ? 'the N key' : 'holding the left button down'; },
    middle: function (src) { return src === 'keyboard' ? 'the M key' : 'pressing the wheel (middle click)'; },
    right: function (src) { return src === 'keyboard' ? 'the space bar' : 'a right click'; },
    undo: function () { return 'undo'; },
    select: function () { return 'the ↑ ↓ arrow keys'; },
    key: function () { return 'a keyboard key'; }
  };
  var HOW = {
    scroll: 'scroll the wheel', shiftScroll: 'hold Shift and scroll the wheel', press: 'click the left button once',
    hold: 'hold the left button down for about 1 second, then let go', middle: 'press the wheel down like a button (middle click)',
    right: 'click the right button', undo: 'move the arrow onto the Undo button and click it (or press Z on the keyboard)'
  };
  var ACTION_KIND = { value: 'scroll', press: 'press', alts: 'hold', mode: 'middle', eye: 'right', undo: 'undo', select: 'select' };
  var EYE_NEXT = { both: 'AE', AE: 'FE', FE: 'both' };
  var EYE_LABEL = { both: 'Now: both eyes', AE: 'Now: weaker eye only', FE: 'Now: stronger eye only' };

  function create(host) {
    var t = null, timer = null;

    function lib() { return host.galleryItems().filter(function (it) { return it.kind !== 'none'; }); }
    /** The practice picture: a mild feature from the gallery, and its first adjustable feature control. */
    function practicePicture() {
      // A wavy (bend) picture if the gallery has one: its "Bend amount" bar changes the picture visibly.
      var items = lib(), mild = items.filter(function (it) { return it.kind === 'family' && it.level === 'mild'; });
      var pick = mild.filter(function (it) { return it.family === 'bend'; })[0] || mild[0] || items[0];
      var recon = C.util.clone(pick.recon), ctl = null, list = [];
      if (recon.renderer === 'semantic-grating') {
        var fams = C.relevantFamilies(recon, []);
        C.DATA.parameters.renderers['semantic-grating'].params.forEach(function (d) {
          if (fams.indexOf(d.family) >= 0 && !d.advanced && d.type === 'number') list.push({ path: d.key, def: d, label: d.label, family: d.family });
        });
        ctl = list.filter(function (x) { return x.family === pick.family; })[0] || list.filter(function (x) { return x.family !== 'global'; })[0] || list[0];
      } else {
        C.paramList(recon).forEach(function (e) { if (e.def.type === 'number') list.push({ path: e.path, def: e.def, label: C.labelFor(recon, e.path) }); });
        ctl = list[0];
      }
      return { recon: recon, list: list, index: Math.max(0, list.indexOf(ctl)), label: pick.label };
    }
    function step(def) { return C.stepFor(def, host.stepMode()); }
    /** Step per wheel notch-step: exactly the one the task uses for participants (app.js participantStep). */
    function practiceStep(def) { return host.participantStep(def); }
    function scrollBar(ev) {
      var d = cur().def, s = practiceStep(d), n = host.wheelSteps(ev.steps, ev.source, 'tutorial:' + cur().path);
      if (n) t.recon = setVal(t.recon, cur().path, Math.max(d.min, Math.min(d.max, curVal() + n * s)));
    }
    function atTarget() { return t.target !== null && Math.abs(t.target - curVal()) / practiceStep(cur().def) <= 1.01; }
    function towards() { return t.target > curVal() ? 'Keep going: scroll up' : 'Keep going: scroll down'; }
    function setVal(recon, path, v) { return C.withValue(recon, path, v); }
    function cur() { return t.pic.list[t.pic.index]; }
    function curVal() { return C.getValue(t.recon, cur().path); }
    function barLines(withTarget) {
      var L = t.pic.list, i = t.pic.index, c = L[i], d = c.def, v = C.getValue(t.recon, c.path), out = [];
      if (L.length > 2) out.push({ text: L[(i - 1 + L.length) % L.length].label, faint: true });
      var line = { text: c.label, strong: true, bar: (v - d.min) / (d.max - d.min) };
      if (withTarget && t.target !== null) line.target = (t.target - d.min) / (d.max - d.min);
      out.push(line);
      if (L.length > 1) out.push({ text: L[(i + 1) % L.length].label, faint: true });
      return out;
    }
    function versions(seed) {
      var c = cur(), d = c.def, s = practiceStep(d), base = t.recon, out = [base], m = 1 + ((seed || 0) % 3);
      [3 * m, -3 * m, 6 * m, -6 * m].forEach(function (k) { out.push(setVal(base, c.path, Math.max(d.min, Math.min(d.max, C.getValue(base, c.path) + k * s)))); });
      return out;
    }

    // What each setting does, in plain words (shown while it is the highlighted setting).
    var DOES = {
      orientation: 'tilts the stripes', frequency: 'makes the stripes thinner and closer together (up) or wider (down)',
      phase: 'slides the stripes sideways', contrast: 'makes the stripes stronger or fainter',
      bendAmount: 'makes the stripes more or less wavy', bendSpacing: 'changes how far apart the waves are',
      zigAmount: 'makes the zigzags or steps bigger or smaller', zigSpacing: 'changes how far apart the zigzags or steps are',
      zigShape: 'turns sharp zigzags into square steps', offsetAmount: 'shifts the stripes sideways on one side of a line',
      offsetPosition: 'moves that line', fragExtent: 'makes the breaks in the stripes longer or shorter',
      fragLength: 'changes how far apart the breaks are', holeSize: 'makes the missing patch bigger or smaller',
      holeX: 'moves the missing patch left or right', holeY: 'moves the missing patch up or down',
      holeResidual: 'makes the stripes inside the patch more or less visible', crossStrength: 'makes the crossing lines stronger or fainter',
      crossAngle: 'changes the angle of the crossing lines', crossSpacing: 'changes how far apart the crossing lines are'
    };
    function does(c) {
      if (DOES[c.path]) return DOES[c.path];
      var f = c.def && c.def.family && C.DATA.parameters.renderers['semantic-grating'].families[c.def.family];
      return f ? 'changes this: ' + f.plain.toLowerCase() : 'changes the picture';
    }
    function nowLine() { var c = cur(); return 'Now: "' + c.label + '" ' + does(c) + '.'; }

    // ---- the steps. on(ev) returns {ok, msg, done}; ok === null means "say nothing". text/how may be functions.
    var STEPS = [
      { id: 'welcome', section: '', title: 'How to use the mouse',
        text: ['In the task you see striped pictures. You make a picture that looks like what your weaker eye sees.',
          'This tutorial shows what each part of the task does, and which mouse control to use.'],
        how: 'To start: click the left button',
        scene: function () { return { kind: 'none' }; },
        on: function (ev) { return ev.kind === 'press' ? { ok: true, done: true } : { ok: false, hint: HOW.press }; } },

      // Most actions are practised REPS (3) times (choosing in the ring and asking for new versions once); t.rep counts
      // the rounds done in the current step.
      { id: 'choose-scroll', section: 'Step 1: Choose', title: 'Choose: find the closest starting picture',
        text: ['The middle picture is what your weaker eye sees. The ones around it are each changed in a different way (wavy, tilted, broken…).',
          'Scrolling moves the dark ring.'],
        how: function () { return 'Scroll the dark ring onto the dotted circle · ' + roundOf(); },
        init: function () { t.hl = 0; t.goal = RING_GOALS[0]; },
        scene: function () { return { kind: 'ring', ring: ringScene(true) }; },
        on: function (ev) {
          if (ev.kind !== 'scroll') return { ok: false, hint: HOW.scroll };
          t.hl = ((t.hl + ev.steps) % 8 + 8) % 8;
          if (t.hl !== t.goal) return { ok: true, msg: 'Keep scrolling' };
          t.rep++;
          if (t.rep < REPS) { t.goal = RING_GOALS[t.rep]; return { ok: true, msg: 'Now move it to the new dotted circle' }; }
          return { ok: true, done: true };
        } },

      { id: 'choose-press', section: 'Step 1: Choose', title: 'Choose: pick it',
        text: ['Clicking picks the picture with the dark ring as your starting picture. Next you fine-tune it in Adjust.'],
        how: 'Try it: click the left button',          // practised once (the click is practised 3 times in Adjust and Compare)
        scene: function () { return { kind: 'ring', ring: ringScene(false) }; },
        on: function (ev) { return ev.kind === 'press' ? { ok: true, msg: 'Chosen', done: true } : { ok: false, hint: HOW.press }; } },

      { id: 'adjust-scroll', section: 'Step 2: Adjust', title: 'Adjust: change the picture',
        text: function () { return ['Adjust fine-tunes your picture until it matches. Each setting changes one thing about the stripes.', nowLine(),
          'Scroll up = more, scroll down = less. Hold Shift to go faster.']; },
        how: function () { return 'Scroll the bar to the black marker · ' + roundOf(); },
        init: function () { t.recon = C.util.clone(t.pic.recon); newBarTarget(true); },
        scene: function () { return { kind: 'picture', lines: barLines(true) }; },
        on: function (ev) {
          if (ev.kind !== 'scroll') return { ok: false, hint: HOW.scroll };
          scrollBar(ev);
          if (!atTarget()) return { ok: true, msg: towards() };
          t.recon = setVal(t.recon, cur().path, t.target); t.rep++;
          if (t.rep < REPS) { newBarTarget(t.rep % 2 === 0); return { ok: true, msg: 'The marker moved: scroll to it again' }; }
          return { ok: true, done: true };
        } },

      // Each round: click to the next setting, then scroll that setting's bar to its marker (as in the task).
      { id: 'adjust-next', section: 'Step 2: Adjust', title: 'Adjust: go through the settings',
        text: function () { return ['The list under the picture shows the settings. Clicking moves to the next one; scrolling changes it.', nowLine()]; },
        how: function () { return (t.phase === 'next' ? 'Click for the next setting, then scroll its bar to the marker' : 'Scroll the bar to the black marker') + ' · ' + roundOf(); },
        init: function () { t.target = null; t.phase = 'next'; },
        scene: function () { return { kind: 'picture', lines: barLines(t.phase === 'adjust') }; },
        on: function (ev) {
          if (ev.kind === 'press') {
            t.pic.index = (t.pic.index + 1) % t.pic.list.length; t.phase = 'adjust'; newBarTarget(t.rep % 2 === 0);
            return { ok: true, msg: 'Next setting: "' + cur().label + '". Scroll its bar to the marker' };
          }
          if (ev.kind !== 'scroll') return { ok: false, hint: t.phase === 'next' ? HOW.press : HOW.scroll };
          scrollBar(ev);
          if (t.phase !== 'adjust') return { ok: true, msg: 'That changes this setting. Now click for the next one' };
          if (!atTarget()) return { ok: true, msg: towards() };
          t.recon = setVal(t.recon, cur().path, t.target); t.rep++; t.phase = 'next'; t.target = null;
          return { ok: true, msg: t.rep < REPS ? 'Done. Click for the next setting (' + more() + ')' : '', done: t.rep >= REPS };
        } },

      { id: 'mode', section: 'Moving between steps', title: 'Choose → Adjust → Compare',
        text: ['Choose picks a starting picture, Adjust fine-tunes it, and Compare shows similar versions.',
          'Pressing the wheel down like a button (a middle click) goes to the next one.'],
        how: function () { return 'Try it: press the wheel down · ' + roundOf(); },
        init: function () { t.mode = 'ADJUST'; },
        scene: function () { return { kind: 'mode', mode: t.mode }; },
        on: function (ev) {
          if (ev.kind !== 'middle') return { ok: false, hint: HOW.middle };
          t.mode = t.mode === 'CHOOSE' ? 'ADJUST' : (t.mode === 'ADJUST' ? 'COMPARE' : 'CHOOSE'); t.rep++;
          return { ok: true, msg: 'Now: ' + t.mode + (t.rep < REPS ? '. ' + more() : ''), done: t.rep >= REPS };
        } },

      { id: 'compare-new', section: 'Step 3: Compare', title: 'Compare: get new versions',
        text: ['Compare makes 4 versions of your picture, each changed slightly in a different way. They help when you are close but not quite right.',
          'Holding the left button down for 1 second makes 4 new versions.'],
        how: 'Try it: hold the left button, then let go',     // practised once
        init: function () { t.vers = null; t.vi = 0; },
        scene: function () { return { kind: 'picture', caption: 'Your version' }; },
        on: function (ev) {
          if (ev.kind === 'press') return { ok: false, hint: 'hold the button down longer (about 1 second)' };
          if (ev.kind !== 'hold') return { ok: false, hint: HOW.hold };
          t.vers = versions(1); t.vi = 0;
          return { ok: true, msg: '4 new versions', done: true };
        } },

      { id: 'compare-scroll', section: 'Step 3: Compare', title: 'Compare: look through the versions',
        text: ['Scrolling swaps the picture between your version and versions A to D, in the same place, so you can see which is closest to the middle picture.'],
        how: function () { return 'Scroll to "' + versionName(VERSION_GOALS[t.rep]) + '" · ' + roundOf(); },
        scene: function () { return { kind: 'picture', caption: versionName(t.vi), recon: t.vers[t.vi] }; },
        on: function (ev) {
          if (ev.kind !== 'scroll') return { ok: false, hint: HOW.scroll };
          t.vi = ((t.vi + ev.steps) % 5 + 5) % 5;
          if (t.vi !== VERSION_GOALS[t.rep]) return { ok: true, msg: 'Showing ' + versionName(t.vi) + '. Keep scrolling' };
          t.rep++;
          if (t.rep < REPS) return { ok: true, msg: 'Now find "' + versionName(VERSION_GOALS[t.rep]) + '"' };
          return { ok: true, done: true };
        } },

      { id: 'compare-choose', section: 'Step 3: Compare', title: 'Compare: keep the best one',
        text: ['Clicking keeps the version that is showing: it becomes your picture. If none is better, scroll back to "Your version".'],
        how: function () { return 'Try it: click the left button · ' + roundOf(); },
        scene: function () { return { kind: 'picture', caption: versionName(t.vi), recon: t.vers[t.vi] }; },
        on: function (ev) {
          if (ev.kind !== 'press') return { ok: false, hint: HOW.press };
          t.hist.push(t.recon); t.recon = t.vers[t.vi]; t.rep++;
          if (t.rep < REPS) { t.vers = versions(t.rep + 3); t.vi = KEEP_SHOW[t.rep]; return { ok: true, msg: 'Kept. Another version is showing: keep it too' }; }
          return { ok: true, msg: 'Kept', done: true };
        } },

      { id: 'eye', section: 'Switching eyes', title: 'Look with one eye at a time',
        text: ['A right click changes which eye sees the pictures: weaker eye only, stronger eye only, or both. Use it to check each picture on its own. The words always stay.'],
        how: function () { return 'Try it: right click · ' + roundOf(); },
        init: function () { t.eye = 'both'; },
        scene: function () { return { kind: 'eye', eye: t.eye, label: EYE_LABEL[t.eye] }; },
        on: function (ev) {
          if (ev.kind !== 'right') return { ok: false, hint: HOW.right };
          t.eye = EYE_NEXT[t.eye]; t.rep++;
          return { ok: true, msg: t.rep < REPS ? more() : '', done: t.rep >= REPS };
        } },

      { id: 'undo', section: 'Undo', title: 'Undo a change',
        text: ['Undo takes back your last change to the picture, one change at a time.',
          'Here: move the arrow onto the Undo button and click. (Z on the keyboard also works.)'],
        how: function () { return 'Try it: click the Undo button · ' + roundOf(); },
        // Three earlier changes to undo (the versions kept in Compare; made up if that step was skipped).
        init: function () { var k = 1; while (t.hist.length < REPS) { var v = versions(k++); t.hist.unshift(v[1]); } },
        // The on-screen button exists only in this tutorial step; the stimulus window turns a click on it into "undo".
        scene: function () { return { kind: 'picture', caption: 'Your version', button: 'Undo' }; },
        on: function (ev) {
          if (ev.kind === 'press') return { ok: false, said: 'a click outside the Undo button', hint: 'move the arrow onto the Undo button first, then click' };
          if (ev.kind !== 'undo') return { ok: false, hint: HOW.undo };
          if (t.hist.length) t.recon = t.hist.pop();
          t.rep++;
          return { ok: true, msg: 'Undone: the picture went back' + (t.rep < REPS ? '. ' + more() : ''), done: t.rep >= REPS };
        } },

      { id: 'done', section: '', title: 'Tutorial complete',
        text: ['Well done: you have practised every control.', 'Please tell the researcher you are ready.'],
        how: 'Click the left button to finish',
        scene: function () { return { kind: 'none' }; },
        on: function (ev) { return ev.kind === 'press' ? { ok: true, done: true, msg: 'Finished' } : { ok: false, hint: HOW.press }; } }
    ];

    var REPS = 3, RING_GOALS = [5, 2, 7], VERSION_GOALS = [3, 1, 4], KEEP_SHOW = [0, 2, 4];
    function roundOf() { return 'round ' + Math.min(REPS, t.rep + 1) + ' of ' + REPS; }
    function more() { var n = REPS - t.rep; return n + (n === 1 ? ' more time' : ' more times'); }
    /** A new bar target 8 practice steps from the current value, upward if `up` (and there is room), else downward. */
    function newBarTarget(up) {
      var d = cur().def, s = practiceStep(d), v = curVal();
      if (up && v + 8 * s > d.max) up = false;
      if (!up && v - 8 * s < d.min) up = true;
      t.target = C.getValue(setVal(t.recon, cur().path, v + (up ? 8 : -8) * s), cur().path);
    }
    function versionName(i) { return i === 0 ? 'Your version' : 'Version ' + String.fromCharCode(64 + i); }
    function ringScene(withTarget) {
      var items = lib().slice(0, 8).map(function (it) { return { recon: it.recon }; });
      return { items: items, highlight: t.hl, target: withTarget ? t.goal : -1 };
    }

    function enter(i) {
      clearTimeout(timer);
      t.i = Math.max(0, Math.min(STEPS.length - 1, i));
      t.feedback = null; t.advancing = false; t.rep = 0;
      t.stats[t.i] = t.stats[t.i] || { id: STEPS[t.i].id, correct: 0, incorrect: 0, ms: 0 };
      t.enteredAt = Date.now();
      if (STEPS[t.i].init) STEPS[t.i].init();
    }
    function leave(how) {
      var s = t.stats[t.i]; s.ms += Date.now() - t.enteredAt;
      host.log('tutorial-step', { step: s.id, index: t.i + 1, correct: s.correct, incorrect: s.incorrect, seconds: Math.round(s.ms / 100) / 10, how: how });
    }
    function finish(how) {
      clearTimeout(timer);
      var stats = t.stats.filter(Boolean);
      host.log('tutorial-end', { how: how, stepsDone: t.i + (how === 'completed' ? 1 : 0), total: STEPS.length,
        correct: stats.reduce(function (a, s) { return a + s.correct; }, 0), incorrect: stats.reduce(function (a, s) { return a + s.incorrect; }, 0), steps: stats });
      t = null;
      host.ended(how);
    }
    function handle(ev) {
      if (!t || t.advancing) return true;
      var st = STEPS[t.i], r = st.on(ev), s = t.stats[t.i];
      if (r.ok === true) {
        s.correct++;
        t.feedback = { ok: true, text: 'Correct control!' + (r.msg ? ' ' + r.msg + '.' : '') };
      } else if (r.ok === false) {
        s.incorrect++;
        t.feedback = { ok: false, text: 'Incorrect control: that was ' + (r.said || NAMES[ev.kind](ev.source)) + '. Instead, ' + r.hint + '.' };
      }
      if (r.done) {
        t.advancing = true;
        if (t.i === STEPS.length - 1) { leave('done'); host.changed(); timer = setTimeout(function () { finish('completed'); }, 1500); }
        else {
          t.feedback = { ok: true, text: 'Correct control! ' + (r.msg ? r.msg + '. ' : '') + 'Well done.' };
          timer = setTimeout(function () { leave('done'); enter(t.i + 1); host.changed(); }, 1600);
        }
      }
      host.changed();
      return true;
    }

    return {
      active: function () { return !!t; },
      start: function () {
        t = { i: 0, stats: [], pic: practicePicture(), hist: [] };
        t.recon = C.util.clone(t.pic.recon); t.target = null;
        host.log('tutorial-start', { steps: STEPS.length, practicePicture: t.pic.label });
        enter(0); host.changed();
      },
      stop: function () { if (t) { leave('ended-by-researcher'); finish('ended-by-researcher'); } },
      next: function () { if (t) { leave('skipped'); if (t.i >= STEPS.length - 1) finish('completed'); else { enter(t.i + 1); host.changed(); } } },
      back: function () { if (t && t.i > 0) { leave('back'); enter(t.i - 1); host.changed(); } },
      /** A participant action (from the mouse, keys or MIDI): value / press / alts / mode / eye / undo / select. */
      action: function (action, steps, source, shift) {
        var kind = ACTION_KIND[action];
        if (!kind) return false;
        return handle({ kind: kind, steps: steps, dir: steps < 0 ? -1 : 1, source: source, shift: shift });
      },
      /** Alignment keys arrive while an alignment practice screen is showing (scroll / Shift+scroll / click / keys). */
      alignKey: function (key, source) {
        var ev = key === 'ArrowLeft' || key === 'ArrowRight' ? { kind: 'scroll', dir: key === 'ArrowRight' ? 1 : -1, steps: key === 'ArrowRight' ? 1 : -1 } :
          key === 'ArrowUp' || key === 'ArrowDown' ? { kind: 'shiftScroll', dir: key === 'ArrowUp' ? 1 : -1, steps: 1 } :
          key === 'Enter' ? { kind: 'press' } : { kind: 'key' };
        ev.source = source || 'mouse';
        return handle(ev);
      },
      /** state.tutorial for the stimulus window, plus the picture to draw and whether it is an alignment screen. */
      payload: function () {
        if (!t) return null;
        var st = STEPS[t.i], sc = st.scene();
        var recon = sc.recon || t.recon;
        delete sc.recon;
        return { tutorial: { progress: 'Tutorial ' + (t.i + 1) + ' / ' + STEPS.length, section: st.section, title: st.title,
          text: typeof st.text === 'function' ? st.text() : st.text,
          how: typeof st.how === 'function' ? st.how() : st.how, feedback: t.feedback, scene: sc }, recon: recon, align: sc.kind === 'align' };
      },
      status: function () {
        if (!t) return null;
        var s = t.stats[t.i];
        return { index: t.i + 1, total: STEPS.length, id: STEPS[t.i].id, title: (STEPS[t.i].section ? STEPS[t.i].section + ': ' : '') + STEPS[t.i].title,
          correct: s.correct, incorrect: s.incorrect,
          totalCorrect: t.stats.reduce(function (a, x) { return a + (x ? x.correct : 0); }, 0),
          totalIncorrect: t.stats.reduce(function (a, x) { return a + (x ? x.incorrect : 0); }, 0) };
      },
      steps: function () { return STEPS.map(function (s) { return s.id; }); }
    };
  }
  root.DLTutorial = { create: create };
})(typeof self !== 'undefined' ? self : this);
