// Core logic tests:  node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../web/js/core.js');

const ROOT = path.join(__dirname, '..');
const G = { diameter: 3.2, sigma: 0.53, aperture: 'circle' };
const J = (x) => JSON.stringify(x);
const gray = (px) => { const g = new Uint8Array(px.length / 4); for (let i = 0; i < g.length; i++) g[i] = px[4 * i]; return g; };
function render(recon, n = 128, geom = G) { return gray(C.renderRecon(recon, n, geom)); }
function semantic(over, ref) { const r = C.identityRecon(ref || C.defaultReference()); Object.assign(r.params, over); return C.validateRecon(r); }
function sample(recon, x, y) { const q = C.math.semanticPrepare(recon.params); return C.math.semanticSignal(x, y, q); }

// ------------------------------------------------------------------ renderers
test('semantic identity is pixel-identical to the legacy reference grating', () => {
  for (const ref of [C.defaultReference(), { orientation: 33.3, frequency: 2.5, phase: 45, contrast: 0.7 }]) {
    for (const ap of ['circle', 'gaussian']) {
      const g = { diameter: 3.2, sigma: 0.53, aperture: ap };
      assert.deepEqual(render(C.identityRecon(ref), 96, g), render(C.referenceRecon(ref), 96, g));
    }
  }
});

test('legacy math matches original prototype checks', () => {
  const p = { orientation: 0, frequency: 1, phase: 0, duty: 0, threshold: 1, weight: 1, enabled: true };
  const eq = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(eq(C.math.carrier(0, 0, p), 1) && eq(C.math.carrier(0.25, 0, p), 1) && eq(C.math.carrier(0, 0.25, p), 0));
  assert.ok(eq(C.math.carrier(0.25, 0, { ...p, orientation: 90 }), 0));
  assert.ok(eq(C.math.carrier(0, 0, { ...p, phase: 180 }), -1));
  assert.ok(eq(C.math.legacyComponent(0, 0, { ...p, duty: -0.5, threshold: 0.25 }), 0.25));
  assert.ok(eq(C.math.legacySignal(0, 0, [{ ...p, weight: 0.8 }, { ...p, weight: 0.8 }]), 1));
  assert.ok(eq(C.math.legacySignal(0, 0, [{ ...p, weight: 0.2 }, { ...p, weight: 0.3 }]), 0.5));
  assert.ok(eq(C.math.legacySignal(0, 0, [{ ...p, enabled: false }]), 0));
  assert.ok(eq(C.math.envelope(1, 0, { diameter: 4, sigma: 1, aperture: 'gaussian' }), Math.exp(-0.5)));
  assert.equal(C.math.envelope(3, 0, { diameter: 4, sigma: 1, aperture: 'circle' }), 0);
});

test('all ten legacy presets validate, render and import from the original session files', () => {
  const presets = C.DATA.legacyPresets.presets;
  assert.equal(presets.length, 10);
  const dir = path.join(ROOT, 'existing-prototype', 'presets');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  assert.equal(files.length, 10);
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const s = C.importSession(data);
    C.validateSession(s);
    const p = presets.find((x) => x.id === data.presetOrigin);
    assert.ok(p, 'preset for ' + f);
    assert.equal(J(s.work.recon), J(C.validateRecon(C.legacyRecon(p.model))));
    assert.equal(J(s.reference), J(p.reference));
    assert.equal(s.provenance.imported.schema, 'distortion-lab/session/1');
    assert.equal(s.provenance.imported.presetOrigin, p.id);
    assert.equal(s.provenance.imported.sessionId, data.sessionId);
    assert.equal(s.work.origin.type, 'import');
    assert.equal(s.layout.ppd, data.state.layout.ppd);
    assert.equal(render(s.work.recon, 32, p.geometry).length, 1024);
  }
});

test('bare distortion-lab/1 state imports; unsupported shapes are rejected', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'existing-prototype', 'presets', '03-wavy.json'), 'utf8'));
  const s = C.importSession(data.state);
  assert.equal(s.work.recon.params.components.length, 3);
  assert.throws(() => C.importSession({ schema: 'something-else' }), /Unsupported/);
  const bad = JSON.parse(JSON.stringify(data)); bad.state.model.components[0].weight = 99;
  assert.throws(() => C.importSession(bad), /out of range/);
  const bad2 = JSON.parse(JSON.stringify(data)); bad2.state.layout.aperture = 'square';
  assert.throws(() => C.importSession(bad2), /aperture/);
});

// ------------------------------------------------------------------ controls produce their advertised changes
test('bend amount bends stripes; bend spacing sets the wavelength along the stripes', () => {
  const ref = C.defaultReference(); // vertical stripes (orientation 90): u = -x, v = y
  const r = semantic({ bendAmount: 0.1, bendSpacing: 1.0 }, ref);
  // Displacement d(v) = A sin(2πv/λ): the signal at (x, y) equals the identity signal at x - d(y)
  for (const y of [0.1, 0.25, 0.6]) {
    const d = 0.1 * Math.sin(2 * Math.PI * y / 1.0);
    const id = C.identityRecon(ref);
    assert.ok(Math.abs(sample(r, 0.3, y) - sample(id, 0.3 - d, y)) < 1e-9);
  }
  // Period along the stripe equals the spacing.
  assert.ok(Math.abs(sample(r, 0.37, 0.2) - sample(r, 0.37, 1.2)) < 1e-9);
  assert.notDeepEqual(render(r), render(C.identityRecon(ref)));
});

test('zigzag/stepped: shape 0 gives triangle displacement, shape 1 gives step displacement', () => {
  const ref = C.defaultReference();
  const tri = semantic({ zigAmount: 0.1, zigSpacing: 1, zigShape: 0 }, ref);
  const stp = semantic({ zigAmount: 0.1, zigSpacing: 1, zigShape: 1 }, ref);
  const id = C.identityRecon(ref);
  // triangle peak at t=0.25 -> displacement +A; step near-constant +A for t in (0.05, 0.45)
  assert.ok(Math.abs(sample(tri, 0.2, 0.25) - sample(id, 0.2 - 0.1, 0.25)) < 1e-9);
  assert.ok(Math.abs(sample(tri, 0.2, 0.125) - sample(id, 0.2 - 0.05, 0.125)) < 1e-9);
  assert.ok(Math.abs(sample(stp, 0.2, 0.125) - sample(id, 0.2 - 0.1, 0.125)) < 1e-3);
});

test('offset shifts stripes by the offset amount across a boundary at the chosen position', () => {
  const ref = C.defaultReference();
  const r = semantic({ offsetAmount: 0.1, offsetPosition: 0.4 }, ref);
  const id = C.identityRecon(ref);
  // above the boundary (v = y > 0.4) displacement +A/2, below -A/2
  assert.ok(Math.abs(sample(r, 0.3, 0.6) - sample(id, 0.3 - 0.05, 0.6)) < 1e-9);
  assert.ok(Math.abs(sample(r, 0.3, 0.2) - sample(id, 0.3 + 0.05, 0.2)) < 1e-9);
});

test('gap: size/position/residual control the missing area', () => {
  const ref = C.defaultReference();
  const r = semantic({ holeSize: 0.5, holeX: 0.3, holeY: -0.2, holeSoftness: 0, holeResidual: 0, gapFill: 1 }, ref);
  assert.equal(sample(r, 0.3, -0.2), 1);
  assert.equal(sample(r, 0.3 + 0.45, -0.2), 1);
  const xo = 0.3 + 0.55; assert.equal(sample(r, xo, -0.2), sample(C.identityRecon(ref), xo, -0.2));
  const half = semantic({ holeSize: 0.5, holeX: 0.3, holeY: -0.2, holeSoftness: 0, holeResidual: 0.5, gapFill: 1 }, ref);
  const base = sample(C.identityRecon(ref), 0.31, -0.2);
  assert.ok(Math.abs(sample(half, 0.31, -0.2) - (base + 0.5 * (1 - base))) < 1e-12);
  const band = semantic({ holeSize: 0.2, holeShape: 'band', holeAngle: 0, holeSoftness: 0 }, ref);
  assert.equal(sample(band, 1.2, 0.1), 1); assert.notEqual(sample(band, 0.0625, 0.5), 1);
  const br = semantic({ holeSize: 0.1, holeShape: 'branch', holeAngle: 90, holeSoftness: 0 }, ref);
  assert.equal(sample(br, 0, 1.0), 1);                       // up arm
  assert.equal(sample(br, Math.cos(-Math.PI / 6), Math.sin(-Math.PI / 6)), 1); // lower-right arm
  assert.notEqual(sample(br, 0.0625, -1.0), 1);                // no downward arm
});

test('fragmentation interrupts a fraction of each stripe; crossing adds a second orientation', () => {
  const ref = C.defaultReference();
  const f = semantic({ fragExtent: 0.5, fragLength: 0.5 }, ref);
  const px = render(f, 128), id = render(C.identityRecon(ref), 128);
  let white = 0, whiteId = 0;
  for (let i = 0; i < px.length; i++) { if (px[i] === 255) white++; if (id[i] === 255) whiteId++; }
  assert.ok(white > whiteId * 3, 'interrupted segments become gap fill');
  const cr = semantic({ crossStrength: 0.8, crossAngle: 90, crossSpacing: 0.5 }, ref);
  // with crossAngle 90 the extra pattern varies along y
  const a = sample(cr, 0, 0), b = sample(cr, 0, 0.25);
  assert.ok(Math.abs(a - b) > 0.5);
});

test('global frequency/orientation/phase/contrast behave like the reference grating', () => {
  const ref = { orientation: 90, frequency: 4, phase: 0, contrast: 1 };
  const r = semantic({ frequency: 8, phase: 90, contrast: 0.5, orientation: 0 }, ref);
  assert.deepEqual(render(r), render(C.referenceRecon({ orientation: 0, frequency: 8, phase: 90, contrast: 0.5 })));
});

// ------------------------------------------------------------------ undo/redo
test('undo/redo restore exact states across all kinds of action', () => {
  const s = C.newSession();
  const states = [J(s.work)];
  C.setParam(s, 'orientation', 80); states.push(J(s.work));
  C.chooseGallery(s, 'hole:mild'); states.push(J(s.work));
  C.togglePin(s, 'holeSize'); states.push(J(s.work));
  const rec = C.requestAlternatives(s, { focus: 'hole' }); C.chooseCandidate(s, rec.id, 'p0'); states.push(J(s.work));
  const combo = C.combine(s, 'bend', 'cross'); C.chooseCandidate(s, combo.id, 'p3'); states.push(J(s.work));
  C.togglePin(s, 'holeSize'); states.push(J(s.work));
  C.chooseGallery(s, 'legacy:wavy'); states.push(J(s.work));
  C.addComponent(s); states.push(J(s.work));
  C.mixLegacy(s, 'current', 'fragmented', 0.5, 1); states.push(J(s.work));
  assert.throws(() => C.mixLegacy(s, 'current', 'stepped'), /maximum is 12/);
  const n = states.length;
  for (let i = n - 2; i >= 0; i--) { assert.ok(C.undo(s)); assert.equal(J(s.work), states[i], 'undo to ' + i); }
  assert.equal(C.undo(s), false);
  for (let i = 1; i < n; i++) { assert.ok(C.redo(s)); assert.equal(J(s.work), states[i], 'redo to ' + i); }
  assert.equal(C.redo(s), false);
  C.undo(s); C.setParam(s, 'contrast', 0.5);
  assert.equal(s.redo.length, 0, 'new edit clears redo');
});

test('slider drags coalesce into one undo entry; end of drag starts a new entry', () => {
  const s = C.newSession();
  for (let i = 1; i <= 20; i++) C.setParam(s, 'bendAmount', i / 100, { coalesce: 'slider:bendAmount' });
  assert.equal(s.undo.length, 1);
  C.endCoalesce(s);
  C.setParam(s, 'bendAmount', 0.3, { coalesce: 'slider:bendAmount' });
  assert.equal(s.undo.length, 2);
  C.undo(s); assert.equal(s.work.recon.params.bendAmount, 0.2);
  C.undo(s); assert.equal(s.work.recon.params.bendAmount, 0);
  const before = s.undo.length; C.setParam(s, 'contrast', 1); assert.equal(s.undo.length, before, 'no-op edits are not recorded');
});

// ------------------------------------------------------------------ pins
test('pinned fields are never changed by proposals, gallery choices, combinations or AI operations', () => {
  const s = C.newSession();
  C.chooseGallery(s, 'bend:strong');
  const allPaths = C.paramList(s.work.recon).map((e) => e.path);
  const rng = C.util.mulberry32(99);
  for (let trial = 0; trial < 25; trial++) {
    const t = C.newSession();
    C.chooseGallery(t, ['bend:strong', 'hole:mild', 'cross:strong', 'offset:mild'][trial % 4]);
    const pins = allPaths.filter(() => rng() < 0.3);
    pins.forEach((p) => C.togglePin(t, p));
    const pinnedVals = () => J(pins.map((p) => C.getValue(t.work.recon, p)));
    const ref = pinnedVals();
    for (const focus of ['auto', 'all', 'bend', 'hole', 'global', 'cross']) {
      for (const scale of ['coarse', 'fine']) {
        const g = C.generateProposals(t.work, { seed: trial * 31 + 7, focus, scale, includeAdvanced: true });
        g.candidates.forEach((c) => pins.forEach((p) => assert.equal(J(C.getValue(c.recon, p)), J(C.getValue(t.work.recon, p)), p)));
        if (g.candidates.length) { const rec = C.recordCandidates(t, 'seeded', g.candidates); C.chooseCandidate(t, rec.id, 'p0'); }
        assert.equal(pinnedVals(), ref);
      }
    }
    for (const id of ['reference', 'zigzag:strong', 'fragment:mild', 'combo:bend:mild+hole:mild']) { C.chooseGallery(t, id); assert.equal(pinnedVals(), ref); }
    try { const c = C.combine(t, 'cross', 'fragment'); C.chooseCandidate(t, c.id, 'p1'); } catch (e) { assert.equal(e.name, 'CannotApply'); }
    assert.equal(pinnedVals(), ref);
    if (pins.length) {
      const res = C.applyOperations(t.work, [{ path: pins[0], op: 'delta', value: 0.01 }]);
      assert.equal(res.applied.length, 0); assert.match(res.rejected[0].reason, /pinned/);
      assert.throws(() => C.setParam(t, pins[0], 0.123), /pinned/);
      const before = J(t.work);
      assert.throws(() => C.chooseGallery(t, 'legacy:wavy'), (e) => e.name === 'CannotApply' && /renderer/.test(e.message));
      assert.equal(J(t.work), before, 'refused operation leaves state unchanged');
    }
  }
});

test('all-pinned focus returns an explanation instead of silent changes', () => {
  const s = C.newSession(); C.chooseGallery(s, 'bend:mild');
  C.togglePin(s, 'bendAmount'); C.togglePin(s, 'bendSpacing');
  const g = C.generateProposals(s.work, { focus: 'bend', seed: 1 });
  assert.equal(g.candidates.length, 0);
  assert.match(g.reason, /pinned/);
});

// ------------------------------------------------------------------ proposals
test('seeded proposals are deterministic and record their settings', () => {
  const s = C.newSession(); C.chooseGallery(s, 'cross:mild');
  const a = C.generateProposals(s.work, { seed: 1234 }), b = C.generateProposals(s.work, { seed: 1234 }), c = C.generateProposals(s.work, { seed: 1235 });
  assert.equal(J(a), J(b));
  assert.notEqual(J(a.candidates), J(c.candidates));
  assert.equal(a.candidates.length, 4);
  assert.ok(a.candidates.some((x) => x.changes.length === 2), 'includes coordinated two-parameter proposals');
  const rec = C.requestAlternatives(s, {});
  assert.equal(typeof rec.seed, 'number');
  assert.equal(J(C.generateProposals(rec.base, Object.assign({}, rec.settings, { revealed: rec.settings.revealed })).candidates), J(rec.candidates), 'recorded settings reproduce the set');
});

test('coarse vs fine proposal spacing and repeated smaller neighbourhoods', () => {
  const s = C.newSession(); C.chooseGallery(s, 'bend:mild');
  const meanStep = (opts) => {
    let tot = 0, n = 0;
    for (let seed = 1; seed <= 40; seed++) {
      C.generateProposals(s.work, Object.assign({ seed, focus: 'bend' }, opts)).candidates.forEach((c) => c.changes.forEach((ch) => {
        if (ch.path === 'bendAmount') { tot += Math.abs(ch.to - ch.from) / 0.04; n++; }
      }));
    }
    return tot / n;
  };
  const coarse = meanStep({ scale: 'coarse' }), fine = meanStep({ scale: 'fine' }), r2 = meanStep({ scale: 'coarse', round: 2, shrinkFactor: 0.6 });
  assert.ok(coarse > 0.8 && coarse < 1.3, 'coarse ~ 1x proposal step: ' + coarse);
  assert.ok(fine > 0.15 && fine < 0.4, 'fine ~ 0.25x: ' + fine);
  assert.ok(r2 > 0.25 && r2 < 0.5, 'round 2 ~ 0.36x: ' + r2);
  // requestAlternatives repeat increments the round around the same anchor
  const rec1 = C.requestAlternatives(s, {}); C.chooseCandidate(s, rec1.id, 'keep');
  const rec2 = C.requestAlternatives(s, { repeat: true }); assert.equal(rec2.settings.round, 1);
  C.chooseCandidate(s, rec2.id, 'p1');
  const rec3 = C.requestAlternatives(s, { repeat: true }); assert.equal(rec3.settings.round, 2);
  C.setParam(s, 'phase', 40);
  const rec4 = C.requestAlternatives(s, { repeat: true }); assert.equal(rec4.settings.round, 0, 'manual edit resets neighbourhood');
});

test('Keep current never changes the reconstruction; choosing updates it and records the choice', () => {
  const s = C.newSession(); C.chooseGallery(s, 'offset:mild');
  const before = J(s.work), undoLen = s.undo.length;
  const rec = C.requestAlternatives(s, {});
  assert.equal(C.chooseCandidate(s, rec.id, 'keep'), false);
  assert.equal(J(s.work), before); assert.equal(s.undo.length, undoLen);
  assert.equal(rec.choice, 'keep');
  // changing one's mind after Keep current is allowed (still the same base)
  C.chooseCandidate(s, rec.id, 'p0');
  assert.equal(J(s.work.recon), J(rec.candidates[0].recon));
  assert.throws(() => C.chooseCandidate(s, rec.id, 'p1'), /already chose/);
  C.undo(s);
  assert.equal(J(s.work), before, 'undo returns to the set base');
  C.chooseCandidate(s, rec.id, 'p1');
  assert.equal(J(s.work.recon), J(rec.candidates[1].recon), 'a different choice after undo');
  assert.deepEqual(rec.choices.map((c) => c.choice), ['keep', 'p0', 'p1']);
  C.undo(s);
  const rec2 = C.requestAlternatives(s, {});
  C.chooseCandidate(s, rec2.id, 'p2');
  assert.equal(J(s.work.recon), J(rec2.candidates[2].recon));
  assert.equal(s.work.origin.candidate, 'p2');
  const rec3 = C.requestAlternatives(s, {});
  C.setParam(s, 'contrast', 0.5);
  assert.throws(() => C.chooseCandidate(s, rec3.id, 'p0'), /changed after/);
});

// ------------------------------------------------------------------ gallery / combinations
test('gallery spans reference, families, combinations and the ten original forms', () => {
  const items = C.galleryItems(C.defaultReference());
  assert.ok(items.find((i) => i.id === 'reference'));
  assert.equal(items.filter((i) => i.kind === 'legacy').length, 10);
  assert.ok(items.filter((i) => i.kind === 'combination').length >= 4);
  const fams = new Set(items.filter((i) => i.kind === 'family').map((i) => i.family));
  ['misorientation', 'bend', 'zigzag', 'stepped', 'offset', 'fragment', 'cross', 'hole', 'band', 'branch'].forEach((f) => assert.ok(fams.has(f), f));
  items.forEach((i) => C.validateRecon(i.recon));
});

test('combining two feature families activates both; overlapping families explain why not', () => {
  const s = C.newSession();
  const rec = C.combine(s, 'bend', 'hole');
  assert.equal(rec.candidates.length, 4);
  rec.candidates.forEach((c) => { assert.ok(c.recon.params.bendAmount > 0); assert.ok(c.recon.params.holeSize > 0); });
  assert.ok(rec.candidates[3].recon.params.bendAmount > rec.candidates[0].recon.params.bendAmount);
  assert.throws(() => C.combine(s, 'zigzag', 'stepped'), (e) => e.name === 'CannotApply' && /same controls/.test(e.message));
  assert.throws(() => C.combine(s, 'bend', 'bend'), /two different/);
  C.chooseCandidate(s, rec.id, 'p1');
  assert.deepEqual(C.activeFamilies(s.work.recon).sort(), ['bend', 'hole']);
  C.undo(s); assert.deepEqual(C.activeFamilies(s.work.recon), [], 'revising the choice');
});

// ------------------------------------------------------------------ validation
test('malformed input is rejected', () => {
  const good = C.identityRecon(C.defaultReference());
  const bad = [
    null, [], {}, { renderer: 'nope', rendererVersion: '1.0.0', params: {} },
    Object.assign(C.util.clone(good), { rendererVersion: '9.9.9' }),
    Object.assign(C.util.clone(good), { extra: 1 }),
  ];
  const mut = (f) => { const r = C.util.clone(good); f(r.params); return r; };
  bad.push(mut((p) => { p.orientation = NaN; }), mut((p) => { p.bendAmount = 1; }), mut((p) => { p.holeShape = 'square'; }),
    mut((p) => { delete p.phase; }), mut((p) => { p.unknown = 2; }), mut((p) => { p.frequency = '4'; }), mut((p) => { p.fragSeed = 1.5; }));
  bad.forEach((b, i) => assert.throws(() => C.validateRecon(b), Error, 'case ' + i));
  const leg = C.legacyRecon(C.legacyPreset('wavy').model);
  const lm = (f) => { const r = C.util.clone(leg); f(r.params); return r; };
  [lm((p) => { p.components = []; }), lm((p) => { p.components[1].id = p.components[0].id; }), lm((p) => { p.components[0].enabled = 'yes'; }),
    lm((p) => { p.components[0].weight = 21; }), lm((p) => { p.components = Array(13).fill(p.components[0]).map((c, i) => Object.assign({}, c, { id: i + 1 })); })]
    .forEach((b, i) => assert.throws(() => C.validateRecon(b), Error, 'legacy case ' + i));
  const s = C.newSession();
  assert.throws(() => C.setParam(s, 'orientation', 'abc'), /finite/);
  assert.throws(() => C.setParam(s, 'nonsense', 1), /Unknown/);
  assert.throws(() => C.setParam(s, 'orientation', true), /finite/);
  assert.equal((C.setParam(s, 'orientation', 999), s.work.recon.params.orientation), 180, 'numeric input is clamped to UI bounds');
  assert.throws(() => C.setLayout(s, 'aperture', 'square'));
  assert.throws(() => C.setLayout(s, 'ppd', 0));
  const ss = C.util.clone(s); ss.work.pins = ['notAField'];
  assert.throws(() => C.validateSession(ss), /does not exist/);
  const s2 = C.util.clone(s); s2.schema = 'x'; assert.throws(() => C.validateSession(s2));
  const ops = C.applyOperations(s.work, [{ path: 'bendAmount', op: 'set', value: 5 }, { path: 'bendAmount', op: 'eval', value: 1 },
    { path: 'x', op: 'set', value: 1 }, { path: 'phase', op: 'set', value: 'NaN' }, { path: 'holeShape', op: 'set', value: 'band' }]);
  assert.equal(ops.applied.length, 1); assert.equal(ops.rejected.length, 4);
  assert.throws(() => C.applyOperations(s.work, new Array(7).fill({ path: 'phase', op: 'delta', value: 1 })), /At most 6/);
});

// ------------------------------------------------------------------ descriptions / outcomes / layout
test('descriptions are captured verbatim without changing the reconstruction', () => {
  const s = C.newSession(); C.chooseGallery(s, 'band:mild');
  const before = J(s.work);
  const text = '  The stripes look   bent at the top — like “waves”,\n but only on the left side!  ';
  const d = C.captureDescription(s, { text, region: { x0: -1, y0: 0.2, x1: 0, y1: 1 }, properties: ['bend'], context: 'none-close', aiStatus: 'AI off' });
  assert.equal(d.text, text);
  assert.equal(J(s.work), before);
  assert.equal(J(d.work), before);
  assert.equal(d.aiStatus, 'AI off');
  assert.throws(() => C.captureDescription(s, { text: 'x', region: { x0: 'a' } }), /region/);
  ['unmatchable', 'unstable', 'cannot-tell'].forEach((o) => { C.setOutcome(s, o); assert.equal(s.outcome.status, o); });
  assert.throws(() => C.setOutcome(s, 'success'));
  assert.equal(J(s.work), before);
});

test('eye routing metadata and optics are retained when forms change', () => {
  const s = C.newSession();
  C.setLayout(s, 'ppd', 63.5); C.setLayout(s, 'referenceSide', 'right'); C.setLayout(s, 'linked', true); C.setLayout(s, 'aperture', 'gaussian');
  assert.equal(s.layout.rightEye, 'AE'); assert.equal(s.layout.leftEye, 'FE');
  const L = J(s.layout);
  C.chooseGallery(s, 'branch:strong'); C.chooseGallery(s, 'legacy:three-branch'); C.undo(s); C.redo(s);
  const rec = C.requestAlternatives(s, {}); C.chooseCandidate(s, rec.id, 'p0');
  assert.equal(J(s.layout), L);
});

test('AI context excludes participant identity', () => {
  const s = C.newSession({ participant: 'P-SECRET', condition: 'COND-X' }); s.notes = 'private note';
  const d = C.captureDescription(s, { text: 'wavy' });
  const ctx = J(C.aiContext(s, d, 'bend'));
  assert.ok(!ctx.includes('P-SECRET') && !ctx.includes('COND-X') && !ctx.includes('private note'));
  const req = J(C.devRequest(s, d, null));
  assert.ok(!req.includes('P-SECRET') && !req.includes('private note'));
});

test('session round-trips through JSON and validates', () => {
  const s = C.newSession(); C.chooseGallery(s, 'combo:cross:mild+fragment:mild'); C.requestAlternatives(s, {}); C.captureDescription(s, { text: 'hi' }); C.accept(s, 'approximate');
  const r = C.importSession(JSON.parse(J(s)));
  assert.equal(J(r), J(s));
});

test('features can be limited to one side of the boundary line (renderer 1.1.0)', () => {
  const ref = C.defaultReference();
  const z = semantic({ zigAmount: 0.06, zigSpacing: 1, zigSide: 'lower', offsetPosition: 0.3 }, ref);
  const id = C.identityRecon(ref);
  const zAll = semantic({ zigAmount: 0.06, zigSpacing: 1 }, ref);
  // vertical stripes: v = y, boundary at y = 0.3; above unchanged, below zigzag
  for (const [x, y] of [[0.11, 0.6], [-0.4, 1.0]]) assert.equal(sample(z, x, y), sample(id, x, y), 'upper side straight');
  for (const [x, y] of [[0.11, -0.2], [-0.4, 0.1]]) assert.equal(sample(z, x, y), sample(zAll, x, y), 'lower side zigzag');
  assert.ok(C.relevantFamilies(z, []).includes('offset'), 'boundary controls shown');
  const cr = semantic({ crossStrength: 0.8, crossSide: 'upper', offsetPosition: 0 }, ref);
  assert.equal(sample(cr, 0.13, -0.5), sample(id, 0.13, -0.5));
  assert.notEqual(sample(cr, 0.13, 0.37), sample(id, 0.13, 0.37));
});

test('semantic-grating 1.0.0 reconstructions migrate to 1.1.0 with identical pixels', () => {
  const r = C.util.clone(C.galleryItem(C.defaultReference(), 'combo:cross:mild+fragment:mild').recon);
  const old = { renderer: 'semantic-grating', rendererVersion: '1.0.0', params: Object.assign({}, r.params) };
  ['bendSide', 'zigSide', 'fragSide', 'crossSide'].forEach((k) => delete old.params[k]);
  const m = C.validateRecon(old);
  assert.equal(m.rendererVersion, '1.1.0');
  assert.equal(m.params.zigSide, 'whole');
  assert.deepEqual(render(old), render(m));
});

// ------------------------------------------------------------------ nulling
test('reverse of a bend cancels the displacement; tilt and spacing are mirrored about the test grating', () => {
  const ref = C.defaultReference();  // vertical stripes: u = -x, v = y
  const m = semantic({ bendAmount: 0.1, bendSpacing: 1.0, bendPhase: 30, orientation: 100, frequency: 4.4, offsetAmount: 0.05 }, ref);
  const r = C.reverseRecon(m, ref).recon;
  assert.equal(r.params.bendPhase, 210);
  assert.equal(r.params.orientation, 80);
  assert.equal(r.params.frequency, 3.64);
  assert.equal(r.params.offsetAmount, -0.05);
  // displacement of the reverse is exactly the negative of the matched one
  const only = semantic({ bendAmount: 0.1, bendSpacing: 1.0, bendPhase: 30 }, ref), rev = C.reverseRecon(only, ref).recon, id = C.identityRecon(ref);
  for (const y of [0.1, 0.37, -0.6]) {
    const d = 0.1 * Math.sin(2 * Math.PI * y / 1.0 + 30 * Math.PI / 180);
    assert.ok(Math.abs(sample(rev, 0.21, y) - sample(id, 0.21 + d, y)) < 1e-9);
  }
});

test('breaks and gaps cannot be reversed and are reported; crossing lines are counter-phased', () => {
  const ref = C.defaultReference();
  const out = C.reverseRecon(semantic({ holeSize: 0.5, fragExtent: 0.3, crossStrength: 0.5, crossPhase: 10 }, ref), ref);
  assert.equal(out.recon.params.holeSize, 0);
  assert.equal(out.recon.params.fragExtent, 0);
  assert.equal(out.recon.params.crossPhase, 190);
  assert.ok(out.notes.some((n) => /gap cannot/.test(n)) && out.notes.some((n) => /Breaks cannot/.test(n)));
});

test('plaid reverse is the linear prediction 2S - P (before the final clip)', () => {
  const ref = C.defaultReference();
  const P = C.galleryItem(ref, 'plaid:net').recon;
  const out = C.reverseRecon(P, ref);
  const S = C.referenceRecon(ref);
  const sig = (r, x, y) => C.signalFor(r).f(x, y);
  let checked = 0;
  for (const [x, y] of [[0.1, 0.2], [0.33, -0.4], [-0.7, 0.05], [0.9, 0.9], [0, 0]]) {
    const lin = 2 * sig(S, x, y) - P.params.contrast * sig(P, x, y);
    if (Math.abs(lin) < 1) { assert.ok(Math.abs(sig(out.recon, x, y) - lin) < 1e-9); checked++; }
  }
  assert.ok(checked >= 2);
  assert.ok(out.notes.some((n) => /clipped/.test(n)));
});

test('nulling: start, record, other-eye check, repeat, end; undoable and saved in the session', () => {
  const s = C.newSession();
  C.chooseGallery(s, 'bend:strong');
  C.togglePin(s, 'bendSpacing');
  const matched = J(s.work);
  const t = C.startNulling(s, { adjEye: 'AE', standard: 'other', start: 'reverse' });
  assert.equal(t.repeat, 1);
  assert.equal(s.work.pins.length, 0, 'pins from matching do not carry into nulling');
  assert.equal(s.work.recon.params.bendPhase, 180);
  C.setParam(s, 'bendAmount', 0.12);
  const rec = C.recordNull(s, 'nulled');
  assert.equal(rec.final.params.bendAmount, 0.12);
  assert.equal(J(rec.matchWork), matched);
  C.setNullCheck(s, true); assert.equal(s.task.check, true);
  C.recordNullCheck(s, 'opposite'); assert.equal(s.nulls[0].otherEyeCheck.response, 'opposite');
  C.setNullCheck(s, false);
  const t2 = C.startNulling(s, { adjEye: 'AE', standard: 'other', start: 'straight' });
  assert.equal(t2.repeat, 2, 'repeat count for the same match');
  assert.equal(J(s.work.recon), J(C.identityRecon(s.reference)));
  C.recordNull(s, 'not-nullable');
  const t3 = C.startNulling(s, { adjEye: 'FE', standard: 'none', start: 'straight' });
  assert.equal(t3.repeat, 1, 'fellow eye, monocular criterion counts separately');
  assert.throws(() => C.recordNull(s, 'success'));
  C.validateSession(JSON.parse(J(s)));
  C.endNulling(s);
  assert.equal(s.task, null);
  assert.equal(J({ recon: s.work.recon, pins: s.work.pins }), J({ recon: JSON.parse(matched).recon, pins: JSON.parse(matched).pins }), 'back to the matched reconstruction (pins restored)');
  assert.equal(s.work.origin.type, 'null-end');
  C.undo(s);
  assert.equal(J(s.work.recon), J(C.identityRecon(s.reference)), 'end is undoable');
  assert.equal(s.nulls.length, 2);
});

test('sessions saved before the fusion-box settings load with the lab-battery defaults', () => {
  const s = C.newSession();
  const old = JSON.parse(J(s));
  ['fusionBox', 'sideBySide', 'boxSize', 'boxSepX', 'boxSepY', 'rotLeft', 'rotRight', 'calContrastLeft', 'calContrastRight', 'sideOffset', 'testSide', 'fixationStyle']
    .forEach((k) => delete old.layout[k]);
  const v = C.validateSession(old);
  assert.equal(v.layout.boxSize, 15); assert.equal(v.layout.boxSepX, 9); assert.equal(v.layout.fixationStyle, 'nonius');
  assert.equal(v.layout.fusionBox, true); assert.equal(v.layout.sideOffset, 3);
  assert.throws(() => C.setLayout(s, 'rotLeft', 90), /rotLeft/);
  assert.throws(() => C.setLayout(s, 'fixationStyle', 'dot'));
});
