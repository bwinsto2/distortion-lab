"""Renderer parity: Python vs the original prototype PNGs and vs the browser core (via Node, if installed)."""
import glob
import json
import os
import shutil
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
from distortion_lab import model as M  # noqa: E402
from test_backend import read_png_gray  # noqa: E402

NODE_SCRIPT = r"""
const C = require(process.argv[1]);
const rng = C.util.mulberry32(777);
const items = C.galleryItems(C.defaultReference()).map(i => i.recon);
// random semantic reconstructions spanning every control
for (let k = 0; k < 25; k++) {
  const r = C.identityRecon(C.defaultReference());
  C.DATA.parameters.renderers['semantic-grating'].params.forEach(d => {
    if (d.type === 'enum') r.params[d.key] = d.choices[Math.floor(rng() * d.choices.length)];
    else if (rng() < 0.6) r.params[d.key] = C.util.quantize(d, d.min + rng() * (d.max - d.min));
  });
  r.params.frequency = Math.min(r.params.frequency, 8);
  items.push(r);
}
const geoms = [{diameter: 3.2, sigma: 0.53, aperture: 'circle'}, {diameter: 2.5, sigma: 0.6, aperture: 'gaussian'}];
const out = items.map((recon, i) => { const g = geoms[i % 2]; const px = C.renderRecon(recon, 72, g); const a = []; for (let j = 0; j < px.length; j += 4) a.push(px[j]); return {recon, g, a}; });
process.stdout.write(JSON.stringify(out));
"""


class TestParity(unittest.TestCase):
    def test_python_legacy_matches_original_prototype_pngs(self):
        for p in M.LEGACY_PRESETS["presets"]:
            f = glob.glob(os.path.join(ROOT, "existing-prototype", "images", "%02d-*.png" % p["index"]))[0]
            with open(f, "rb") as fh:
                w, h, g = read_png_gray(fh.read())
            recon = {"renderer": "legacy-rectified", "rendererVersion": "1.0.0", "params": p["model"]}
            mine = M.render_gray(recon, w, p["geometry"])
            diff = sum(1 for a, b in zip(mine, g) if a != b)
            self.assertEqual(diff, 0, "%s: %d pixels differ" % (p["id"], diff))

    @unittest.skipUnless(shutil.which("node"), "Node.js not installed")
    def test_python_matches_browser_core(self):
        out = subprocess.run(["node", "-e", NODE_SCRIPT, os.path.join(ROOT, "web", "js", "core.js")], capture_output=True, check=True, timeout=120)
        cases = json.loads(out.stdout)
        worst, total, differing = 0, 0, 0
        for c in cases:
            M.validate_recon(c["recon"])
            g = M.render_gray(c["recon"], 72, c["g"])
            for a, b in zip(g, c["a"]):
                total += 1
                if a != b:
                    differing += 1
                    worst = max(worst, abs(a - b))
        # Floating-point library differences (e.g. tanh/asin last-ulp) may flip a rare rounding boundary.
        self.assertLessEqual(worst, 1)
        self.assertLess(differing / total, 1e-3, "%d of %d pixels differ" % (differing, total))
        print("\n  parity: %d cases, %d px, %d differ (max diff %d)" % (len(cases), total, differing, worst))


if __name__ == "__main__":
    unittest.main()
