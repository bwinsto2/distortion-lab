"""Backend tests (standard library only):  python3 -m unittest discover -s tests -v"""
import copy
import json
import os
import shutil
import struct
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from distortion_lab import model as M  # noqa: E402
from distortion_lab.server import make_server  # noqa: E402
from distortion_lab.ai_bridge import Bridge, sanitize_context  # noqa: E402

EXAMPLE = os.path.join(ROOT, "examples", "synthetic-session.json")


def read_png_gray(data):
    """Tiny PNG decoder for 8-bit greyscale/RGB/RGBA non-interlaced files (test helper)."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w = 8, b"", None
    while pos < len(data):
        n = struct.unpack(">I", data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + n]
        if tag == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", body[:10])
            assert depth == 8 and body[12] == 0
        elif tag == b"IDAT":
            idat += body
        pos += 12 + n
    bpp = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    raw = zlib.decompress(idat)
    stride = w * bpp
    out, prev = bytearray(), bytearray(stride)
    for r in range(h):
        f = raw[r * (stride + 1)]
        line = bytearray(raw[r * (stride + 1) + 1:(r + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 255
            elif f == 2:
                line[i] = (line[i] + b) & 255
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else (b if pb <= pc else c))) & 255
        out.extend(line[::bpp])
        prev = line
    return w, h, bytes(out)


class ServerCase(unittest.TestCase):
    env = {}

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="dl-test-")
        cls.httpd = make_server("127.0.0.1", 0, cls.tmp, env=cls.env)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def req(self, method, path, body=None, raw=None, headers=None):
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        r = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path), data=data, method=method,
                                   headers=dict({"Content-Type": "application/json"}, **(headers or {})))
        try:
            with urllib.request.urlopen(r, timeout=20) as resp:
                payload = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                return resp.status, (json.loads(payload) if "json" in ctype else payload)
        except urllib.error.HTTPError as e:
            payload = e.read()
            try:
                return e.code, json.loads(payload)
            except ValueError:
                return e.code, payload

    def example(self):
        with open(EXAMPLE, encoding="utf-8") as f:
            return json.load(f)


class TestBackend(ServerCase):
    def test_status_and_static(self):
        code, j = self.req("GET", "/api/status")
        self.assertEqual(code, 200)
        self.assertEqual(j["version"], M.VERSION)
        self.assertEqual(j["ai"]["provider"], "none")
        self.assertFalse(j["ai"]["connected"])
        code, page = self.req("GET", "/")
        self.assertEqual(code, 200)
        self.assertIn(b"Distortion Lab", page)
        code, _ = self.req("GET", "/../distortion_lab/server.py")
        self.assertEqual(code, 404)
        code, _ = self.req("GET", "/%2e%2e/run.py")
        self.assertEqual(code, 404)

    def test_host_and_origin_checks(self):
        code, _ = self.req("GET", "/api/status", headers={"Host": "evil.example"})
        self.assertEqual(code, 403)
        code, _ = self.req("PUT", "/api/sessions/x", body={}, headers={"Origin": "http://evil.example"})
        self.assertEqual(code, 403)

    def test_session_persistence_revisions_and_reload(self):
        s = self.example()
        s["sessionId"] = "t-persist"
        code, j = self.req("PUT", "/api/sessions/t-persist", s)
        self.assertEqual(code, 200, j)
        self.assertEqual(j["revision"], 1)
        code, j = self.req("PUT", "/api/sessions/t-persist", s)
        self.assertTrue(j["unchanged"])
        s2 = copy.deepcopy(s)
        s2["notes"] = "changed"
        code, j = self.req("PUT", "/api/sessions/t-persist", s2)
        self.assertEqual(j["revision"], 2)
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "sessions", "t-persist.prev.json")))
        code, j = self.req("GET", "/api/sessions/t-persist")
        self.assertEqual(j["session"], s2)
        code, j = self.req("GET", "/api/sessions")
        self.assertIn("t-persist", [r["id"] for r in j["sessions"]])
        code, j = self.req("GET", "/api/sessions/t-persist/revisions")
        self.assertEqual([r["revision"] for r in j["revisions"]], [1, 2])
        # A fresh server process over the same data directory sees the same session (restart/restore).
        httpd2 = make_server("127.0.0.1", 0, self.tmp)
        try:
            self.assertEqual(httpd2.app.storage.load_session("t-persist"), s2)
        finally:
            httpd2.server_close()

    def test_malformed_input_rejected(self):
        s = self.example()
        cases = []
        cases.append(("/api/sessions/a", None, b"{not json"))
        bad = copy.deepcopy(s); bad["schema"] = "distortion-lab/session/9"; cases.append(("/api/sessions/" + bad["sessionId"], bad, None))
        bad = copy.deepcopy(s); bad["work"]["recon"]["params"]["bendAmount"] = 7; cases.append(("/api/sessions/" + bad["sessionId"], bad, None))
        bad = copy.deepcopy(s); bad["work"]["recon"]["params"]["orientation"] = "90"; cases.append(("/api/sessions/" + bad["sessionId"], bad, None))
        bad = copy.deepcopy(s); bad["work"]["pins"] = ["nonexistent"]; cases.append(("/api/sessions/" + bad["sessionId"], bad, None))
        bad = copy.deepcopy(s); bad["layout"]["aperture"] = "square"; cases.append(("/api/sessions/" + bad["sessionId"], bad, None))
        bad = copy.deepcopy(s); bad["undo"][0]["work"]["recon"]["renderer"] = "evil"; cases.append(("/api/sessions/" + bad["sessionId"], bad, None))
        bad = copy.deepcopy(s); bad["outcome"]["status"] = "success"; cases.append(("/api/sessions/" + bad["sessionId"], bad, None))
        cases.append(("/api/sessions/other-id", s, None))  # id mismatch
        cases.append(("/api/sessions/..%2Fescape", s, None))
        cases.append(("/api/sessions/a", [1, 2, 3], None))
        for path, body, raw in cases:
            code, j = self.req("PUT", path, body, raw=raw)
            self.assertIn(code, (400, 404), (path, j))
            self.assertFalse(j["ok"])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "sessions", "other-id.json")))

    def test_export_bundle_pngs_match_renderer(self):
        s = self.example()
        code, j = self.req("POST", "/api/sessions/%s/export" % s["sessionId"], {"session": s, "size": 96})
        self.assertEqual(code, 200, j)
        for f in ("session.json", "manifest.json", "reference.png", "reconstruction-current.png", "accepted-001.png"):
            self.assertIn(f, j["files"])
        with open(os.path.join(j["path"], "reconstruction-current.png"), "rb") as f:
            w, h, g = read_png_gray(f.read())
        lay = s["layout"]
        self.assertEqual((w, h), (96, 96))
        self.assertEqual(g, M.render_gray(s["work"]["recon"], 96, {"diameter": lay["diameter"], "sigma": lay["sigma"], "aperture": lay["aperture"]}))
        with open(os.path.join(j["path"], "session.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), s)

    def test_render_endpoint(self):
        recon = self.example()["work"]["recon"]
        code, png = self.req("POST", "/api/render", {"recon": recon, "size": 32, "geometry": {"diameter": 3.2, "sigma": 0.5, "aperture": "gaussian"}})
        self.assertEqual(code, 200)
        w, h, g = read_png_gray(png)
        self.assertEqual(len(g), 32 * 32)
        code, j = self.req("POST", "/api/render", {"recon": recon, "size": 5000})
        self.assertEqual(code, 400)

    def test_operations_validation_endpoint(self):
        s = self.example()
        ops = [{"path": "holeSize", "op": "set", "value": 0.1},       # pinned in the example
               {"path": "bendAmount", "op": "set", "value": 0.2},
               {"path": "bendAmount", "op": "set", "value": 3},
               {"path": "__import__", "op": "set", "value": 1},
               {"path": "phase", "op": "delta", "value": 10}]
        code, j = self.req("POST", "/api/validate/operations", {"work": s["work"], "operations": ops})
        self.assertEqual(code, 200)
        self.assertEqual([a["path"] for a in j["applied"]], ["bendAmount", "phase"])
        self.assertEqual(len(j["rejected"]), 3)
        self.assertEqual(j["recon"]["params"]["holeSize"], s["work"]["recon"]["params"]["holeSize"])

    def test_ai_disconnected(self):
        s = self.example()
        ctx = {"renderer": s["work"]["recon"]["renderer"], "description": {"text": "wavy"}}
        code, j = self.req("POST", "/api/ai/propose", {"work": s["work"], "context": ctx})
        self.assertEqual(code, 503)
        self.assertIn("not connected", j["error"])

    def test_control_relay(self):
        import socket
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        sock.sendall(b"GET /api/control/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        buf = b""
        while b": connected" not in buf:
            buf += sock.recv(4096)
        code, j = self.req("POST", "/api/control", {"op": "nudge", "path": "bendAmount", "steps": 2, "source": "dial-1"})
        self.assertEqual(code, 200)
        self.assertGreaterEqual(j["delivered"], 1)
        while b"data:" not in buf:
            buf += sock.recv(4096)
        sock.close()
        line = [l for l in buf.split(b"\n") if l.startswith(b"data:")][0]
        self.assertEqual(json.loads(line[5:])["path"], "bendAmount")
        for bad in ({"op": "exec", "path": "x"}, {"op": "nudge", "path": "x", "steps": "2"}, {"op": "set", "path": "x"}, {"op": "set", "path": "x", "value": 1, "code": "x"}):
            code, j = self.req("POST", "/api/control", bad)
            self.assertEqual(code, 400, bad)

    def test_dev_request(self):
        code, j = self.req("POST", "/api/dev-request", {"schema": "distortion-lab/dev-request/1", "description": {"text": "x"}})
        self.assertEqual(code, 200)
        self.assertTrue(os.path.exists(j["path"]))
        code, j = self.req("POST", "/api/dev-request", {"schema": "other"})
        self.assertEqual(code, 400)


class TestMockAI(ServerCase):
    env = {"DISTORTION_LAB_AI": "mock"}

    def test_mock_is_labelled_not_ai_and_operations_are_validated(self):
        code, j = self.req("GET", "/api/ai/status")
        self.assertFalse(j["ai"]["isAI"])
        self.assertIn("not AI", j["ai"]["label"])
        s = self.example()
        ctx = {"softwareVersion": M.VERSION, "renderer": "semantic-grating", "rendererVersion": "1.0.0", "reference": s["reference"],
               "params": s["work"]["recon"]["params"], "pins": s["work"]["pins"], "focus": "auto",
               "description": {"text": "the stripes look wavy and there is a hole", "region": None, "properties": []}}
        code, j = self.req("POST", "/api/ai/propose", {"work": s["work"], "context": ctx, "count": 6})
        self.assertEqual(code, 200, j)
        by_label = {c["label"]: c for c in j["candidates"]}
        # holeSize is pinned in the example: the mock's holeSize proposal must be rejected
        hole = [c for c in j["candidates"] if any(o["path"] == "holeSize" for o in c["operations"])][0]
        self.assertIsNone(hole["recon"])
        self.assertIn("pinned", hole["rejected"][0]["reason"])
        oob = [c for c in j["candidates"] if any(o["path"] == "bendAmount" and o["value"] == 9 for o in c["operations"])][0]
        self.assertIsNone(oob["recon"])
        good = [c for c in j["candidates"] if c["recon"]]
        self.assertTrue(good)
        for c in good:
            self.assertEqual(c["recon"]["params"]["holeSize"], s["work"]["recon"]["params"]["holeSize"])
            M.validate_recon(c["recon"])
        self.assertTrue(by_label)

    def test_context_with_identity_fields_is_refused(self):
        s = self.example()
        ctx = {"renderer": "semantic-grating", "description": {"text": "x"}, "participant": "P-01"}
        code, j = self.req("POST", "/api/ai/propose", {"work": s["work"], "context": ctx})
        self.assertEqual(code, 400)


class TestBridgeUnit(unittest.TestCase):
    def test_statuses(self):
        self.assertEqual(Bridge({}).status()["connected"], False)
        st = Bridge({"DISTORTION_LAB_AI": "openai"}).status()
        self.assertFalse(st["connected"])
        self.assertIn("OPENAI_API_KEY", st["detail"])
        st = Bridge({"DISTORTION_LAB_AI": "openai", "OPENAI_API_KEY": "sk-test"}).status()
        self.assertIsNone(st["connected"])
        self.assertIn("not yet verified", st["label"])
        with self.assertRaises(RuntimeError):
            Bridge({}).propose({"renderer": "semantic-grating", "params": {}, "description": {"text": "x"}})

    def test_sanitize(self):
        with self.assertRaises(M.ValidationError):
            sanitize_context({"renderer": "x", "condition": "c"})
        with self.assertRaises(M.ValidationError):
            sanitize_context({"renderer": "x", "description": {"text": "a" * 5000}})


class TestModel(unittest.TestCase):
    def test_example_session_validates(self):
        with open(EXAMPLE, encoding="utf-8") as f:
            M.validate_session(json.load(f))

    def test_legacy_presets_validate(self):
        self.assertEqual(len(M.LEGACY_PRESETS["presets"]), 10)
        for p in M.LEGACY_PRESETS["presets"]:
            M.validate_recon({"renderer": "legacy-rectified", "rendererVersion": "1.0.0", "params": p["model"]})

    def test_hash_and_quantize(self):
        self.assertAlmostEqual(M.hash01(0, 0), 0.0)
        self.assertTrue(0 <= M.hash01(-5, 7) < 1)
        d = M.SEM_DEFS["bendAmount"]
        self.assertEqual(M.quantize(d, 0.1234), 0.125)
        self.assertEqual(M.quantize(d, 9), 0.5)

    def test_png_encoder_roundtrip(self):
        g = bytes(range(256)) * 4
        w, h, out = read_png_gray(M.encode_png_gray(g, 64, 16, {"A": "b"}))
        self.assertEqual((w, h, out), (64, 16, g))


if __name__ == "__main__":
    unittest.main()
