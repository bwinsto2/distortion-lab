"""Local HTTP backend (standard library only, Python 3.9+).

Binds to 127.0.0.1 by default. Serves the web UI from ./web and a small JSON API:

  GET  /api/status                       version, storage location, AI status
  GET  /api/sessions                     list saved sessions (index from SQLite)
  GET  /api/sessions/<id>                load a session
  PUT  /api/sessions/<id>                validate + save a session (autosave target)
  GET  /api/sessions/<id>/revisions      revision log
  POST /api/sessions/<id>/export         write JSON + Python-rendered PNG bundle
  POST /api/render                       {recon, size, geometry} -> image/png
  POST /api/validate/operations          {work, operations} -> validated result
  GET  /api/ai/status | POST /api/ai/check | POST /api/ai/propose
  POST /api/dev-request                  save a development (Codex) request
  POST /api/control                      dial / external controller message
  GET  /api/control/stream               Server-Sent Events relay of control messages
"""
from __future__ import annotations

import argparse
import errno
import hmac
import secrets
import socket
import time
import urllib.request
import json
import mimetypes
import os
import queue
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import VERSION
from .ai_bridge import Bridge, sanitize_context
from .model import ROOT, ValidationError, apply_operations, render_png, validate_recon, validate_work
from .storage import Storage

WEB = os.path.join(ROOT, "web")
MAX_BODY = 60 * 1024 * 1024
CONTROL_OPS = {"set", "nudge", "undo", "redo", "pin", "unpin", "endEdit"}


class ControlHub:
    def __init__(self):
        self.lock = threading.Lock()
        self.subscribers = []

    def subscribe(self):
        q = queue.Queue(maxsize=1000)
        with self.lock:
            self.subscribers.append(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            if q in self.subscribers:
                self.subscribers.remove(q)

    def publish(self, msg):
        with self.lock:
            subs = list(self.subscribers)
        for q in subs:
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass
        return len(subs)


def validate_control(msg):
    if not isinstance(msg, dict):
        raise ValidationError("control message must be an object")
    allowed = {"op", "path", "value", "steps", "stepMode", "source"}
    extra = set(msg) - allowed
    if extra:
        raise ValidationError("unexpected control fields: %s" % ", ".join(sorted(extra)))
    if msg.get("op") not in CONTROL_OPS:
        raise ValidationError("op must be one of %s" % ", ".join(sorted(CONTROL_OPS)))
    if msg["op"] in ("set", "nudge", "pin", "unpin"):
        if not isinstance(msg.get("path"), str) or len(msg["path"]) > 64:
            raise ValidationError("path is required")
    if msg["op"] == "nudge":
        s = msg.get("steps")
        if isinstance(s, bool) or not isinstance(s, (int, float)) or abs(s) > 1000:
            raise ValidationError("steps must be a number")
        if msg.get("stepMode", "fine") not in ("fine", "coarse"):
            raise ValidationError("stepMode must be fine or coarse")
    if msg["op"] == "set" and "value" not in msg:
        raise ValidationError("value is required")
    out = dict(msg)
    out["source"] = str(msg.get("source", "external"))[:40]
    return out


class App:
    def __init__(self, data_dir, env=None):
        self.storage = Storage(data_dir)
        self.bridge = Bridge(env)
        self.hub = ControlHub()


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "DistortionLab/" + VERSION
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # quieter console
            if os.environ.get("DISTORTION_LAB_VERBOSE"):
                sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        # ----------------------------------------------------------- helpers
        def _host_ok(self):
            host = (self.headers.get("Host") or "").split(":")[0]
            return host in ("127.0.0.1", "localhost", "[::1]", "::1") or os.environ.get("DISTORTION_LAB_ALLOW_ANY_HOST") == "1"

        def _origin_ok(self):
            origin = self.headers.get("Origin")
            if not origin or origin == "null":
                return True
            host = urlparse(origin).hostname
            return host in ("127.0.0.1", "localhost", "::1")

        def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
            if not isinstance(body, (bytes, bytearray)):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _error(self, code, msg):
            self._send(code, {"ok": False, "error": msg})

        def _json_body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise ValidationError("Request body too large")
            raw = self.rfile.read(n) if n else b""
            try:
                return json.loads(raw.decode("utf-8")) if raw else None
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                raise ValidationError("Malformed JSON: %s" % e)

        def _dispatch(self, method):
            if not self._host_ok():
                return self._error(403, "Host not allowed")
            if method != "GET" and not self._origin_ok():
                return self._error(403, "Cross-origin request refused")
            path = urlparse(self.path).path
            try:
                if path.startswith("/api/"):
                    return self._api(method, path)
                if method not in ("GET", "HEAD"):
                    return self._error(405, "Method not allowed")
                return self._static(path)
            except ValidationError as e:
                return self._error(400, str(e))
            except (BrokenPipeError, ConnectionResetError):
                return None
            except Exception as e:  # pragma: no cover - defensive
                return self._error(500, "%s: %s" % (type(e).__name__, e))

        def do_GET(self):
            self._dispatch("GET")

        def do_HEAD(self):
            self._dispatch("HEAD")

        def do_POST(self):
            self._dispatch("POST")

        def do_PUT(self):
            self._dispatch("PUT")

        # ----------------------------------------------------------- static
        def _static(self, path):
            if path in ("", "/"):
                path = "/index.html"
            full = os.path.realpath(os.path.join(WEB, path.lstrip("/")))
            if not full.startswith(os.path.realpath(WEB) + os.sep) or not os.path.isfile(full):
                return self._error(404, "Not found")
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            with open(full, "rb") as f:
                self._send(200, f.read(), ctype)

        # ----------------------------------------------------------- API
        def _api(self, method, path):
            parts = [p for p in path.split("/") if p][1:]  # drop 'api'
            st = app.storage
            if parts == ["status"] and method == "GET":
                return self._send(200, {"ok": True, "version": VERSION, "dataDir": st.dir, "ai": app.bridge.status(),
                                        "python": sys.version.split()[0]})
            if parts == ["sessions"] and method == "GET":
                return self._send(200, {"ok": True, "sessions": st.list_sessions()})
            if len(parts) >= 2 and parts[0] == "sessions":
                sid = parts[1]
                st.session_path(sid)
                if len(parts) == 2 and method == "GET":
                    s = st.load_session(sid)
                    return self._send(200, {"ok": True, "session": s}) if s else self._error(404, "No such session")
                if len(parts) == 2 and method == "PUT":
                    return self._send(200, dict(ok=True, **st.save_session(sid, self._json_body())))
                if parts[2:] == ["revisions"] and method == "GET":
                    return self._send(200, {"ok": True, "revisions": st.revisions(sid)})
                if parts[2:] == ["export"] and method == "POST":
                    body = self._json_body() or {}
                    if not isinstance(body, dict):
                        raise ValidationError("export body must be an object")
                    sess = body.get("session") or st.load_session(sid)
                    if not sess or sess.get("sessionId") != sid:
                        raise ValidationError("Session not found or id mismatch")
                    st.save_session(sid, sess)
                    return self._send(200, dict(ok=True, **st.export_bundle(sess, body.get("size", 512), body.get("browserPngs"))))
            if parts == ["render"] and method == "POST":
                body = self._json_body()
                if not isinstance(body, dict):
                    raise ValidationError("render body must be an object")
                recon = validate_recon(body.get("recon"))
                size = body.get("size", 256)
                if isinstance(size, bool) or not isinstance(size, int) or not 8 <= size <= 1024:
                    raise ValidationError("size must be an integer 8-1024")
                g = body.get("geometry") or {}
                geom = {"diameter": g.get("diameter", 3.2), "sigma": g.get("sigma", 0.53), "aperture": g.get("aperture", "circle")}
                if geom["aperture"] not in ("circle", "gaussian") or not all(isinstance(geom[k], (int, float)) and 0.05 <= geom[k] <= 10 for k in ("diameter", "sigma")):
                    raise ValidationError("invalid geometry")
                return self._send(200, render_png(recon, size, geom, {"Software": "Distortion Lab " + VERSION}), "image/png")
            if parts == ["validate", "operations"] and method == "POST":
                body = self._json_body() or {}
                work = validate_work(body.get("work"))
                return self._send(200, dict(ok=True, **apply_operations(work, body.get("operations"))))
            if parts == ["shutdown"] and method == "POST":
                body = self._json_body() or {}
                token = getattr(app, "shutdown_token", None)
                if not token or not isinstance(body, dict) or not hmac.compare_digest(str(body.get("token", "")), token):
                    return self._error(403, "Invalid shutdown token")
                self._send(200, {"ok": True, "stopping": True})
                threading.Thread(target=app.stop, daemon=True).start()
                return None
            if parts == ["ai", "status"] and method == "GET":
                return self._send(200, {"ok": True, "ai": app.bridge.status()})
            if parts == ["ai", "check"] and method == "POST":
                return self._send(200, {"ok": True, "ai": app.bridge.check()})
            if parts == ["ai", "propose"] and method == "POST":
                body = self._json_body() or {}
                if not isinstance(body, dict):
                    raise ValidationError("body must be an object")
                work = validate_work(body.get("work"))
                ctx = body.get("context")
                if not isinstance(ctx, dict) or ctx.get("renderer") != work["recon"]["renderer"]:
                    raise ValidationError("context renderer must match the work")
                ctx = sanitize_context(dict(ctx, params=work["recon"]["params"], pins=work["pins"]))
                try:
                    raw = app.bridge.propose(ctx, body.get("count", 4))
                except RuntimeError as e:
                    return self._send(503, {"ok": False, "error": str(e), "ai": app.bridge.status()})
                except Exception as e:
                    return self._send(502, {"ok": False, "error": "AI provider error: %s" % e, "ai": app.bridge.status()})
                cands = []
                for i, c in enumerate(raw.get("candidates", [])):
                    if not isinstance(c, dict):
                        continue
                    try:
                        res = apply_operations(work, c.get("operations"))
                    except ValidationError as e:
                        res = {"recon": None, "applied": [], "rejected": [{"op": c.get("operations"), "reason": str(e)}]}
                    cands.append({"label": str(c.get("label", "candidate %d" % (i + 1)))[:120],
                                  "rationale": str(c.get("rationale", ""))[:500], "operations": c.get("operations"),
                                  "applied": res["applied"], "rejected": res["rejected"],
                                  "recon": res["recon"] if res["applied"] else None})
                return self._send(200, {"ok": True, "provider": raw.get("provider"), "model": raw.get("model"),
                                        "ai": app.bridge.status(), "candidates": cands})
            if parts == ["dev-request"] and method == "POST":
                return self._send(200, dict(ok=True, **st.save_dev_request(self._json_body())))
            if parts == ["control"] and method == "POST":
                msg = validate_control(self._json_body())
                n = app.hub.publish(msg)
                return self._send(200, {"ok": True, "delivered": n})
            if parts == ["control", "stream"] and method == "GET":
                return self._stream()
            return self._error(404, "Unknown API route")

        def _stream(self):
            q = app.hub.subscribe()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                while True:
                    try:
                        msg = q.get(timeout=15)
                        self.wfile.write(("data: " + json.dumps(msg) + "\n\n").encode("utf-8"))
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                app.hub.unsubscribe(q)

    return Handler


def make_server(host="127.0.0.1", port=8765, data_dir=None, env=None):
    data_dir = data_dir or os.environ.get("DISTORTION_LAB_DATA") or os.path.join(ROOT, "data")
    app = App(data_dir, env)
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    httpd.daemon_threads = True
    httpd.app = app

    def stop():
        httpd.shutdown()        # waits for serve_forever to return
        httpd.server_close()    # release the port right away for the replacing instance
    app.stop = stop
    return httpd


def _runfile(data_dir, port):
    return os.path.join(os.path.abspath(data_dir), ".server-%d.json" % port)


def _probe(port, timeout=2):
    """Return the /api/status of a Distortion Lab already listening on this port, else None."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/status" % port, timeout=timeout) as r:
            j = json.loads(r.read().decode("utf-8"))
            return j if isinstance(j, dict) and j.get("ok") and "version" in j else None
    except Exception:
        return None


def _stop_previous(port, data_dir):
    """Ask an earlier Distortion Lab on this port to stop, using the token it left in the data folder."""
    try:
        with open(_runfile(data_dir, port), encoding="utf-8") as f:
            token = json.load(f).get("token")
        req = urllib.request.Request("http://127.0.0.1:%d/api/shutdown" % port, data=json.dumps({"token": token}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=3).read()
    except Exception:
        return False
    for _ in range(50):
        time.sleep(0.1)
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                pass
        except OSError:
            return True     # nothing listening any more
    return False


def start_server(host, port, data_dir, env=None, replace=True, tries=20):
    """Bind, replacing an earlier Distortion Lab on the port if possible, else moving to the next free port."""
    data_dir = data_dir or os.environ.get("DISTORTION_LAB_DATA") or os.path.join(ROOT, "data")
    try:
        return make_server(host, port, data_dir, env), None
    except OSError as e:
        if e.errno not in (errno.EADDRINUSE, getattr(errno, "WSAEADDRINUSE", -1)):
            raise
    note = None
    other = _probe(port)
    if other and replace and _stop_previous(port, data_dir):
        for _ in range(30):
            try:
                return make_server(host, port, data_dir, env), "Stopped an earlier Distortion Lab (%s) that was still running on port %d." % (other.get("version"), port)
            except OSError:
                time.sleep(0.1)
    if other:
        note = ("An earlier Distortion Lab (%s) is still running on port %d and could not be stopped automatically "
                "(it may be an older version). Close the Terminal window running it, or stop it with:\n"
                "    lsof -ti tcp:%d | xargs kill\n" % (other.get("version"), port, port))
    else:
        note = "Port %d is used by another program." % port
    for p in range(port + 1, port + 1 + tries):
        try:
            return make_server(host, p, data_dir, env), note + "  Using port %d instead." % p
        except OSError:
            continue
    raise SystemExit(note + "  No free port found between %d and %d." % (port + 1, port + tries))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Distortion Lab local backend")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1; keep it local)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("DISTORTION_LAB_PORT", "8765")))
    ap.add_argument("--data", default=None, help="data directory (default ./data or $DISTORTION_LAB_DATA)")
    ap.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    a = ap.parse_args(argv)
    httpd, note = start_server(a.host, a.port, a.data)
    port = httpd.server_address[1]
    httpd.app.shutdown_token = secrets.token_hex(16)
    runfile = _runfile(httpd.app.storage.dir, port)
    try:
        with open(runfile, "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(), "port": port, "version": VERSION, "token": httpd.app.shutdown_token}, f)
        os.chmod(runfile, 0o600)
    except OSError:
        pass
    if note:
        print(note)
    url = "http://%s:%d/" % ("127.0.0.1" if a.host in ("0.0.0.0", "127.0.0.1") else a.host, httpd.server_address[1])
    print("Distortion Lab %s" % VERSION)
    print("  console:  %s" % url)
    print("  stimulus: %sstimulus.html (or use 'Open stimulus window' in the console)" % url)
    print("  data:     %s" % httpd.app.storage.dir)
    print("  AI:       %s" % httpd.app.bridge.status()["label"])
    print("Press Ctrl+C to stop.")
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
        print("Stopped: a newer start of Distortion Lab took over this port.")
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
        try:
            os.remove(runfile)
        except OSError:
            pass


if __name__ == "__main__":
    main()
