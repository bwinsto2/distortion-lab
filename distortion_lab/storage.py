"""Local persistence: one JSON file per session plus an SQLite index and revision log.

Layout of the data directory (default ./data, override with DISTORTION_LAB_DATA):

    data/distortion-lab.sqlite        session index + revision log
    data/sessions/<id>.json           latest validated session document
    data/sessions/<id>.prev.json      previous revision (one-step backup)
    data/exports/<id>/<stamp>/        JSON + PNG export bundles
    data/dev-requests/<stamp>.json    development (Codex) requests

Nothing is sent anywhere; everything stays on the laboratory computer.
"""
from __future__ import annotations

import contextlib
import datetime
import hashlib
import json
import os
import sqlite3
import threading

from . import VERSION
from .model import validate_session, render_png, reference_recon, ValidationError

_LOCK = threading.RLock()


def _now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _stamp():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def _atomic_write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class Storage:
    def __init__(self, data_dir):
        self.dir = os.path.abspath(data_dir)
        for sub in ("sessions", "exports", "dev-requests"):
            os.makedirs(os.path.join(self.dir, sub), exist_ok=True)
        self.db_path = os.path.join(self.dir, "distortion-lab.sqlite")
        with self._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY, participant TEXT, condition TEXT, created_at TEXT,
                    updated_at TEXT, saved_at TEXT, outcome TEXT, renderer TEXT, revision INTEGER, path TEXT);
                CREATE TABLE IF NOT EXISTS revisions (
                    session_id TEXT, revision INTEGER, saved_at TEXT, sha256 TEXT, bytes INTEGER,
                    actions INTEGER, PRIMARY KEY (session_id, revision));
                CREATE TABLE IF NOT EXISTS exports (
                    session_id TEXT, saved_at TEXT, path TEXT);
            """)

    @contextlib.contextmanager
    def _db(self):
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def session_path(self, sid):
        if not sid or not all(c.isalnum() or c in "-_." for c in sid) or sid.startswith("."):
            raise ValidationError("Invalid session id")
        return os.path.join(self.dir, "sessions", sid + ".json")

    # ------------------------------------------------------------------ sessions
    def save_session(self, sid, session):
        validate_session(session)
        if session["sessionId"] != sid:
            raise ValidationError("Session id in URL and document differ")
        data = json.dumps(session, ensure_ascii=False).encode("utf-8")
        digest = hashlib.sha256(data).hexdigest()
        path = self.session_path(sid)
        with _LOCK:
            with self._db() as db:
                row = db.execute("SELECT revision FROM sessions WHERE id=?", (sid,)).fetchone()
                last = db.execute("SELECT sha256 FROM revisions WHERE session_id=? ORDER BY revision DESC LIMIT 1", (sid,)).fetchone()
                if last is not None and last["sha256"] == digest:
                    return {"revision": row["revision"], "sha256": digest, "unchanged": True, "path": path}
                rev = (row["revision"] if row else 0) + 1
                if os.path.exists(path):
                    os.replace(path, path[:-5] + ".prev.json")
                _atomic_write(path, data)
                saved = _now()
                outcome = (session.get("outcome") or {}).get("status")
                db.execute("""INSERT INTO sessions (id, participant, condition, created_at, updated_at, saved_at, outcome, renderer, revision, path)
                              VALUES (?,?,?,?,?,?,?,?,?,?)
                              ON CONFLICT(id) DO UPDATE SET participant=excluded.participant, condition=excluded.condition,
                              updated_at=excluded.updated_at, saved_at=excluded.saved_at, outcome=excluded.outcome,
                              renderer=excluded.renderer, revision=excluded.revision, path=excluded.path""",
                           (sid, session["participant"], session["condition"], session["createdAt"], session["updatedAt"],
                            saved, outcome, session["work"]["recon"]["renderer"], rev, path))
                db.execute("INSERT INTO revisions VALUES (?,?,?,?,?,?)", (sid, rev, saved, digest, len(data), len(session["actions"])))
        return {"revision": rev, "sha256": digest, "unchanged": False, "path": path, "savedAt": saved}

    def load_session(self, sid):
        path = self.session_path(sid)
        if not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def list_sessions(self, limit=100):
        with self._db() as db:
            rows = db.execute("SELECT * FROM sessions ORDER BY saved_at DESC LIMIT ?", (int(limit),)).fetchall()
        return [dict(r) for r in rows]

    def revisions(self, sid):
        with self._db() as db:
            rows = db.execute("SELECT * FROM revisions WHERE session_id=? ORDER BY revision", (sid,)).fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------------ exports
    def export_bundle(self, session, size=512, client_pngs=None):
        """Write session JSON plus Python-rendered PNGs of reference, current and accepted reconstructions."""
        validate_session(session)
        sid = session["sessionId"]
        self.session_path(sid)
        size = int(size)
        if not 16 <= size <= 2048:
            raise ValidationError("size must be 16-2048")
        out = os.path.join(self.dir, "exports", sid, _stamp())
        os.makedirs(out, exist_ok=True)
        lay = session["layout"]
        geom = {"diameter": lay["diameter"], "sigma": lay["sigma"], "aperture": lay["aperture"]}
        meta = {"Software": "Distortion Lab " + VERSION, "Session": sid}
        files = {}

        def png(name, recon, extra):
            m = dict(meta)
            m.update(extra)
            m["Renderer"] = recon["renderer"] + "/" + recon["rendererVersion"]
            _atomic_write(os.path.join(out, name), render_png(recon, size, geom, m))
            files[name] = {"renderer": recon["renderer"], "rendererVersion": recon["rendererVersion"], "size": size, "geometry": geom}

        png("reference.png", reference_recon(session["reference"]), {"Role": "reference"})
        png("reconstruction-current.png", session["work"]["recon"], {"Role": "current reconstruction"})
        for a in session["accepted"]:
            png("accepted-%03d.png" % a["index"], a["work"]["recon"], {"Role": "accepted %s" % a.get("status")})
        if client_pngs:
            # Browser-rendered PNGs are stored alongside for cross-checking (not trusted as canonical).
            import base64
            for name, url in client_pngs.items():
                if not isinstance(name, str) or not name.replace("-", "").isalnum() or not isinstance(url, str):
                    continue
                if url.startswith("data:image/png;base64,") and len(url) < 30_000_000:
                    _atomic_write(os.path.join(out, "browser-" + name + ".png"), base64.b64decode(url.split(",", 1)[1]))
        manifest = {"schema": "distortion-lab/export/1", "softwareVersion": VERSION, "exportedAt": _now(), "sessionId": sid,
                    "files": files, "note": "PNGs rendered by the Python reference renderer from the saved parameters; "
                    "pixel values are the encoded grey levels before any display gamma."}
        _atomic_write(os.path.join(out, "session.json"), json.dumps(session, ensure_ascii=False, indent=1).encode("utf-8"))
        _atomic_write(os.path.join(out, "manifest.json"), json.dumps(manifest, indent=1).encode("utf-8"))
        with _LOCK, self._db() as db:
            db.execute("INSERT INTO exports VALUES (?,?,?)", (sid, _now(), out))
        return {"path": out, "files": sorted(os.listdir(out))}

    def save_dev_request(self, request):
        if not isinstance(request, dict) or request.get("schema") != "distortion-lab/dev-request/1":
            raise ValidationError("Not a development request")
        data = json.dumps(request, ensure_ascii=False, indent=1).encode("utf-8")
        if len(data) > 40_000_000:
            raise ValidationError("Development request too large")
        path = os.path.join(self.dir, "dev-requests", _stamp() + ".json")
        _atomic_write(path, data)
        return {"path": path}
