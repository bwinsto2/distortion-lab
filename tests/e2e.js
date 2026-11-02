// Browser end-to-end test (optional; needs Node + Playwright with Chromium):
//   node tests/e2e.js            (starts its own backend on a free port with a temp data dir)
//   SCREENSHOTS=docs/screenshots node tests/e2e.js   also saves screenshots
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.log('SKIP: playwright not installed'); process.exit(0); }

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : null;
const results = [];
let failed = 0;
async function step(name, fn) {
  try { await fn(); results.push('PASS ' + name); }
  catch (e) { failed++; results.push('FAIL ' + name + ': ' + (e && e.stack || e)); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(port, p, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (resp) => { let b = ''; resp.on('data', (d) => (b += d)); resp.on('end', () => res({ status: resp.statusCode, body: JSON.parse(b) })); });
    r.on('error', rej); r.end(data);
  });
}

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-e2e-'));
  const port = 8900 + Math.floor(Math.random() * 90);
  const srv = spawn('python3', ['run.py', '--no-browser', '--port', String(port), '--data', data], { cwd: ROOT, env: Object.assign({}, process.env, { DISTORTION_LAB_AI: 'mock' }) });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  await sleep(1200);
  const URL = 'http://127.0.0.1:' + port + '/';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  const work = () => page.evaluate(() => DistortionLab.getWork());
  const sess = () => page.evaluate(() => DistortionLab.getSession());
  const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };

  await page.goto(URL);
  await page.waitForFunction(() => document.getElementById('backendStatus').textContent === 'Backend connected');

  await step('page loads, backend connected, mock AI labelled as not AI', async () => {
    assert((await page.textContent('#aiStatus')).includes('not AI'));
    await shot('01-gallery');
  });

  await step('gallery choice sets the reconstruction', async () => {
    await page.click('[data-id="bend:strong"]');
    const w = await work();
    assert(w.origin.id === 'bend:strong' && w.recon.params.bendAmount === 0.15, J(w.origin));
  });

  await step('keyboard slider steps are undoable one by one; a mouse drag is one undo entry', async () => {
    await page.click('[data-tab=adjust]');
    const sel = '#ctl-bendAmount';
    await page.focus(sel);
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    let w = await work();
    assert(Math.abs(w.recon.params.bendAmount - 0.165) < 1e-9, 'value ' + w.recon.params.bendAmount);
    const n0 = (await sess()).undo.length;
    const box = await page.locator('#ctl-bendSpacing').boundingBox();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) await page.mouse.move(box.x + box.width * (0.2 + i * 0.02), box.y + box.height / 2);
    await page.mouse.up();
    const s1 = await sess();
    assert(s1.undo.length === n0 + 1, 'drag produced ' + (s1.undo.length - n0) + ' entries');
    const num = await page.inputValue('#ctl-bendSpacing + span input, [data-path="bendSpacing"] input[type=number]');
    assert(Number(num) === s1.work.recon.params.bendSpacing, 'number box synced');
    await page.click('#undo');
    assert((await work()).recon.params.bendSpacing === 1.0, 'drag undone');
    for (let i = 0; i < 3; i++) await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    w = await work();
    assert(w.recon.params.bendAmount === 0.15, 'keyboard steps undone: ' + w.recon.params.bendAmount);
    await page.click('#redo');
    assert(Math.abs((await work()).recon.params.bendAmount - 0.155) < 1e-9);
    await shot('02-adjust');
  });

  await step('pinned slider is locked and proposals never change it; choosing updates sliders', async () => {
    await page.click('[data-path="bendAmount"] .pinbtn');
    const pinnedVal = (await work()).recon.params.bendAmount;
    assert(await page.isDisabled('#ctl-bendAmount'), 'slider disabled when pinned');
    await page.click('[data-tab=alternatives]');
    await page.selectOption('#altFocus', 'bend');
    await page.click('#showAlts');
    const s = await sess();
    const set = s.proposals[s.proposals.length - 1];
    assert(set.candidates.length > 0, 'candidates shown');
    assert(set.candidates.every((c) => c.recon.params.bendAmount === pinnedVal), 'pin respected');
    await shot('03-compare');
    await page.click('#candidates button:has-text("Choose B")');
    const w = await work();
    assert(J(w.recon) === J(set.candidates[1].recon), 'candidate applied');
    await page.click('[data-tab=adjust]');
    const changed = set.candidates[1].changes[0];
    const shown = await page.inputValue('[data-path="' + changed.path + '"] input[type=number]');
    assert(Number(shown) === changed.to, 'slider shows chosen value');
  });

  await step('Keep current leaves the reconstruction unchanged; repeat shrinks the neighbourhood', async () => {
    await page.click('[data-tab=alternatives]');
    const before = J(await work());
    await page.click('#repeatAlts');
    let s = await sess();
    assert(s.proposals[s.proposals.length - 1].settings.round === 1, 'round 1');
    await page.click('#candidates button:has-text("Keep current")');
    assert(J(await work()) === before);
    s = await sess();
    assert(s.proposals[s.proposals.length - 1].choice === 'keep');
    await page.check('input[name=propScale][value=fine]');
    await page.click('#showAlts');
    s = await sess();
    assert(s.proposals[s.proposals.length - 1].settings.scale === 'fine');
  });

  await step('preview a candidate large without choosing; choose from preview; undo and choose another', async () => {
    await page.click('[data-tab=alternatives]');
    await page.check('input[name=propScale][value=coarse]');
    await page.click('#showAlts');
    const before = J(await work());
    const s = await sess();
    const set = s.proposals[s.proposals.length - 1];
    await page.click('#candidates [data-id="p1"] canvas');
    assert((await page.textContent('#reconTitle')).includes('Previewing B'), 'preview title');
    assert(J(await work()) === before, 'preview does not change the reconstruction');
    const big = await page.evaluate(() => { const c = document.getElementById('reconCanvas'); return c.toDataURL(); });
    await page.keyboard.press('ArrowRight');
    assert((await page.textContent('#reconTitle')).includes('Previewing C'), 'arrow cycles');
    const big2 = await page.evaluate(() => document.getElementById('reconCanvas').toDataURL());
    assert(big !== big2, 'large view changes with preview');
    await page.check('#bigCands');
    assert(await page.evaluate(() => document.getElementById('candidates').classList.contains('big')));
    await shot('03b-preview');
    await page.click('#previewChoose');
    assert(J((await work()).recon) === J(set.candidates[2].recon), 'chose C from preview');
    assert((await page.textContent('#reconTitle')) === 'Current reconstruction');
    assert(await page.isVisible('#candidates [data-id="p0"]'), 'alternatives still visible after choosing');
    await page.click('#undo');
    assert(J(await work()) === before, 'undo back to the set base');
    await page.click('#candidates button:has-text("Choose A")');
    assert(J((await work()).recon) === J(set.candidates[0].recon), 'different choice after undo');
    const rec = (await sess()).proposals.find((p) => p.id === set.id);
    assert(J(rec.choices.map((c) => c.choice)) === J(['p2', 'p0']), J(rec.choices));
    await page.uncheck('#bigCands');
  });

  await step('more-than-one: combine two features; pins kept; choice revisable', async () => {
    await page.click('[data-tab=gallery]');
    await page.click('#multiSelect');
    await page.click('[data-id="cross:mild"]');
    await page.click('[data-id="fragment:mild"]');
    await page.click('#showCombos');
    await shot('04-combinations');
    const pinned = (await work()).recon.params.bendAmount;
    await page.click('#comboGrid >> text=Choose >> nth=2');
    const w = await work();
    assert(w.recon.params.crossStrength > 0 && w.recon.params.fragExtent > 0, 'both features active');
    assert(w.recon.params.bendAmount === pinned, 'pinned bend kept');
    await page.click('#undo');
    assert((await work()).recon.params.crossStrength === 0, 'revised by undo');
    await page.click('#redo');
  });

  await step('composition that cannot keep pins is refused with an explanation', async () => {
    const before = J(await work());
    await page.click('#legacyDetails summary');
    await page.click('[data-id="legacy:wavy"]');
    await sleep(100);
    assert((await page.textContent('#toast')).includes('Unpin'), 'explanation shown');
    assert(J(await work()) === before, 'unchanged');
  });

  await step('None of these: verbatim description, region and outcome captured without changing the picture', async () => {
    await page.click('[data-tab=gallery]');
    await page.click('#noneClose');
    const before = J(await work());
    const text = 'Stripes  look “bent” near the top-left…\nand fainter — not sure why. ';
    await page.fill('#descText', text);
    await page.click('#markRegion');
    const b = await page.locator('#reconCanvas').boundingBox();
    await page.mouse.move(b.x + 40, b.y + 40); await page.mouse.down(); await page.mouse.move(b.x + 150, b.y + 120); await page.mouse.up();
    await page.check('#descProps input[value=bend]');
    await shot('05-describe');
    await page.click('#saveDesc');
    const s = await sess();
    const d = s.descriptions[s.descriptions.length - 1];
    assert(d.text === text, 'verbatim');
    assert(d.region && d.region.x0 < d.region.x1, 'region');
    assert(d.context === 'none-close');
    assert(J(s.work) === before, 'picture unchanged');
    await page.click('#outcomeButtons [data-outcome=unmatchable]');
    assert((await sess()).outcome.status === 'unmatchable');
    await page.click('#outcomeButtons [data-outcome=cannot-tell]');
    assert((await sess()).outcome.status === 'cannot-tell');
  });

  await step('AI bridge (test mock): suggestions are validated, labelled, and only applied on choice', async () => {
    await page.fill('#descText', 'it looks wavy with a hole');
    const before = J(await work());
    await page.click('#aiSuggest');
    await page.waitForFunction(() => document.querySelector('[data-tab=alternatives]').classList.contains('active'));
    assert((await page.textContent('#altInfo')).includes('Test mock (not AI)'));
    assert(J(await work()) === before, 'nothing applied before choice');
    const s = await sess();
    const set = s.proposals[s.proposals.length - 1];
    assert(set.source === 'ai' && set.candidates.length >= 1);
    assert(set.candidates.every((c) => c.recon.params.bendAmount === JSON.parse(before).recon.params.bendAmount), 'pin respected by AI ops');
    assert(s.descriptions[s.descriptions.length - 1].text === 'it looks wavy with a hole', 'description captured first');
  });

  await step('dial control via backend uses the same controller (and respects pins)', async () => {
    const p0 = (await work()).recon.params.phase;
    const r = await post(port, '/api/control', { op: 'nudge', path: 'phase', steps: 5, stepMode: 'fine', source: 'test-dial' });
    assert(r.status === 200 && r.body.delivered >= 1, J(r));
    await page.waitForFunction((p) => DistortionLab.getWork().recon.params.phase !== p, p0);
    assert((await work()).recon.params.phase === (p0 + 5) % 360);
    const pinned = (await work()).recon.params.bendAmount;
    await post(port, '/api/control', { op: 'set', path: 'bendAmount', value: 0.4, source: 'test-dial' });
    await sleep(300);
    assert((await work()).recon.params.bendAmount === pinned, 'pinned field not changed by dial');
    const acts = (await sess()).actions.filter((a) => a.source === 'test-dial');
    assert(acts.length >= 1, 'dial actions logged with source');
  });

  await step('stimulus window mirrors the console and keeps optics when forms change', async () => {
    const stim = await ctx.newPage();
    await stim.goto(URL + 'stimulus.html');
    await stim.waitForFunction(() => window.DistortionLabStimulus.getState() !== null);
    await page.evaluate(() => DistortionLab.setLayout('ppd', 64));
    await page.evaluate(() => DistortionLab.setLayout('visibility', 'left'));
    await stim.waitForFunction(() => DistortionLabStimulus.getState().layout.visibility === 'left');
    const st = await stim.evaluate(() => DistortionLabStimulus.getState());
    assert(J(st.recon) === J((await work()).recon));
    assert(st.layout.ppd === 64);
    await page.evaluate(() => DistortionLab.chooseGallery('reference'));
    await page.evaluate(() => DistortionLab.unpin('bendAmount'));
    await page.evaluate(() => DistortionLab.chooseGallery('hole:strong'));
    await stim.waitForFunction(() => DistortionLabStimulus.getState().recon.params.holeSize > 0);
    assert((await stim.evaluate(() => DistortionLabStimulus.getState().layout.ppd)) === 64, 'calibration retained');
    await page.evaluate(() => DistortionLab.setLayout('visibility', 'both'));
    await page.evaluate(() => DistortionLab.setLayout('comparison', 'sequential'));
    if (SHOTS) await stim.screenshot({ path: path.join(SHOTS, '06-stimulus-window.png') });
    await page.evaluate(() => DistortionLab.setLayout('comparison', 'simultaneous'));
    await stim.close();
  });

  await step('autosave to server and browser; reload offers resume and restores exact state', async () => {
    await page.evaluate(() => DistortionLab.saveNow());
    const s = await sess();
    const fromServer = await page.evaluate((id) => fetch('api/sessions/' + id).then((r) => r.json()), s.sessionId);
    assert(fromServer.session.sessionId === s.sessionId && J(fromServer.session.work) === J(s.work), 'server copy');
    assert(fs.existsSync(path.join(data, 'sessions', s.sessionId + '.json')));
    assert(fs.existsSync(path.join(data, 'distortion-lab.sqlite')));
    await page.reload();
    await page.waitForSelector('#resumeBanner:not([hidden])');
    await shot('07-resume');
    await page.click('#resumeYes');
    const r = await sess();
    assert(J(r.work) === J(s.work) && r.undo.length === s.undo.length && r.descriptions.length === s.descriptions.length, 'restored');
    await page.click('#undo');
    assert(J((await sess()).work) === J(s.undo[s.undo.length - 1].work), 'undo history survives reload');
  });

  await step('all ten original session files import through the file chooser with provenance', async () => {
    await page.click('[data-tab=experimenter]');
    const dir = path.join(ROOT, 'existing-prototype', 'presets');
    for (const f of fs.readdirSync(dir).sort()) {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      await page.setInputFiles('#fileInput', path.join(dir, f));
      await page.waitForFunction((id) => DistortionLab.getSession().provenance.imported && DistortionLab.getSession().provenance.imported.presetOrigin === id, raw.presetOrigin);
      const s = await sess();
      assert(s.work.recon.renderer === 'legacy-rectified' && s.work.recon.params.components.length === raw.state.model.components.length, f);
    }
    await page.click('[data-tab=adjust]');
    await shot('08-legacy-components');
  });

  await step('export bundle written by the backend; in-browser checks pass', async () => {
    await page.click('[data-tab=experimenter]');
    await page.click('#serverExport');
    await page.waitForFunction(() => document.getElementById('toast').textContent.startsWith('Exported to'));
    const s = await sess();
    assert(fs.readdirSync(path.join(data, 'exports', s.sessionId)).length >= 1);
    await page.click('#runTests');
    const out = await page.textContent('#testOut');
    assert(/7\/7 checks passed/.test(out), out);
    await shot('09-experimenter');
  });

  await step('participant layout hides experimenter controls', async () => {
    await page.check('#participantMode');
    assert(!(await page.isVisible('[data-tab=experimenter]')));
    assert(!(await page.isVisible('#previewCanvas')));
    await page.uncheck('#participantMode');
  });

  await step('browser-only fallback (file://) works and states what is unavailable', async () => {
    const p2 = await ctx.newPage();
    p2.on('pageerror', (e) => errors.push('file:// ' + e.message));
    await p2.goto('file://' + path.join(ROOT, 'web', 'index.html'));
    await p2.waitForSelector('#browserOnly:not([hidden])');
    assert((await p2.textContent('#browserOnly')).includes('AI bridge'));
    await p2.click('[data-id="zigzag:mild"]');
    assert((await p2.evaluate(() => DistortionLab.getWork().origin.id)) === 'zigzag:mild');
    await p2.click('[data-tab=describe]');
    await p2.fill('#descText', 'offline description');
    await p2.click('#saveDesc');
    assert((await p2.evaluate(() => DistortionLab.getSession().descriptions.length)) === 1, 'description captured offline');
    assert(await p2.isDisabled('#aiSuggest'), 'AI button disabled offline');
    await sleep(600);
    assert((await p2.textContent('#saveStatus')).includes('browser'), 'local autosave');
    await p2.close();
  });

  await step('no uncaught page errors', async () => { assert(errors.length === 0, errors.join('\n')); });

  await browser.close();
  srv.kill();
  fs.rmSync(data, { recursive: true, force: true });
  console.log(results.join('\n'));
  console.log((results.length - failed) + '/' + results.length + ' end-to-end steps passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
