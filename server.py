#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
予約導線つきAI診断LPビルダー — バックエンドサーバ
追加インストール不要（Python標準ライブラリのみ）。

起動:  python3 server.py
公開:  http://localhost:4173/

データは data/db.json に保存され、どの端末からでも公開URLで診断を受けられます。
"""
import json
import os
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# データ保存先。本番で永続ディスクを使う場合は環境変数 DATA_DIR を設定する。
DATA_DIR = os.environ.get("DATA_DIR") or os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "db.json")
# 待ち受けポート。Render等は PORT 環境変数で指定される。
PORT = int(os.environ.get("PORT", "4173"))

_lock = threading.Lock()

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
}


# ----------------------------- DB helpers -----------------------------
def load_db():
    if not os.path.exists(DB_PATH):
        return {"diagnoses": [], "events": []}
    try:
        with open(DB_PATH, "r", encoding="utf-8") as f:
            db = json.load(f)
    except Exception:
        db = {"diagnoses": [], "events": []}
    db.setdefault("diagnoses", [])
    db.setdefault("events", [])
    return db


def save_db(db):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = DB_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DB_PATH)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


def gen_id(prefix="id"):
    return prefix + "_" + uuid.uuid4().hex[:8]


def slugify(s):
    base = re.sub(r"[^a-z0-9]+", "-", (s or "").strip().lower()).strip("-")[:40]
    return base or ("d-" + uuid.uuid4().hex[:5])


def ensure_unique_slug(db, slug, exclude_id=None):
    existing = {d["slug"] for d in db["diagnoses"] if d.get("id") != exclude_id}
    if slug not in existing:
        return slug
    n = 2
    while f"{slug}-{n}" in existing:
        n += 1
    return f"{slug}-{n}"


def stats_for(db, diag_id):
    evs = [e for e in db["events"] if e.get("diagnosisId") == diag_id]
    start = sum(1 for e in evs if e.get("type") == "start")
    complete = sum(1 for e in evs if e.get("type") == "complete")
    cta = sum(1 for e in evs if e.get("type") == "cta_click")
    by_type = {}
    for e in evs:
        if e.get("type") == "complete" and e.get("resultKey"):
            by_type[e["resultKey"]] = by_type.get(e["resultKey"], 0) + 1
    by_source = {}
    for e in evs:
        if e.get("type") == "cta_click":
            src = e.get("source") or "direct"
            by_source[src] = by_source.get(src, 0) + 1
    return {
        "start": start,
        "complete": complete,
        "cta": cta,
        "compRate": round(complete / start * 100) if start else 0,
        "ctaRate": round(cta / complete * 100) if complete else 0,
        "byType": by_type,
        "bySource": by_source,
    }


# ----------------------------- HTTP handler -----------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "AIDiagnosis/1.0"

    def log_message(self, fmt, *args):
        pass  # quiet

    # -- response helpers --
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, fname, ctype):
        path = os.path.join(BASE_DIR, fname)
        if not os.path.exists(path):
            self._send_json({"error": "not found"}, 404)
            return
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    # -- routing --
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path in STATIC_FILES:
            fname, ctype = STATIC_FILES[path]
            return self._send_static(fname, ctype)

        if path == "/api/diagnoses":
            with _lock:
                db = load_db()
                out = []
                for d in db["diagnoses"]:
                    item = dict(d)
                    item["stats"] = stats_for(db, d["id"])
                    out.append(item)
            return self._send_json(out)

        m = re.match(r"^/api/diagnoses/([^/]+)$", path)
        if m:
            with _lock:
                db = load_db()
                d = next((x for x in db["diagnoses"] if x["id"] == m.group(1)), None)
            return self._send_json(d) if d else self._send_json({"error": "not found"}, 404)

        m = re.match(r"^/api/public/([^/]+)$", path)
        if m:
            from urllib.parse import unquote
            slug = unquote(m.group(1))
            with _lock:
                db = load_db()
                d = next((x for x in db["diagnoses"] if x["slug"] == slug), None)
            if not d:
                return self._send_json({"error": "not_found"}, 404)
            if d.get("status") != "published":
                return self._send_json({"error": "not_published"}, 403)
            return self._send_json(d)

        m = re.match(r"^/api/stats/([^/]+)$", path)
        if m:
            with _lock:
                db = load_db()
                exists = any(x["id"] == m.group(1) for x in db["diagnoses"])
                stats = stats_for(db, m.group(1))
            return self._send_json(stats) if exists else self._send_json({"error": "not found"}, 404)

        return self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_body()

        if path == "/api/diagnoses":
            with _lock:
                db = load_db()
                d = body or {}
                d["id"] = d.get("id") or gen_id("d")
                d["slug"] = ensure_unique_slug(db, slugify(d.get("slug") or d.get("title")), d["id"])
                d["createdAt"] = now_iso()
                d["updatedAt"] = now_iso()
                db["diagnoses"].insert(0, d)
                save_db(db)
            return self._send_json(d, 201)

        if path == "/api/events":
            with _lock:
                db = load_db()
                ev = {
                    "id": gen_id("ev"),
                    "diagnosisId": body.get("diagnosisId"),
                    "type": body.get("type"),
                    "source": body.get("source") or "direct",
                    "resultKey": body.get("resultKey"),
                    "createdAt": now_iso(),
                }
                db["events"].append(ev)
                save_db(db)
            return self._send_json({"ok": True})

        return self._send_json({"error": "not found"}, 404)

    def do_PUT(self):
        parsed = urlparse(self.path)
        m = re.match(r"^/api/diagnoses/([^/]+)$", parsed.path)
        if not m:
            return self._send_json({"error": "not found"}, 404)
        body = self._read_body()
        with _lock:
            db = load_db()
            idx = next((i for i, x in enumerate(db["diagnoses"]) if x["id"] == m.group(1)), None)
            if idx is None:
                return self._send_json({"error": "not found"}, 404)
            d = body or {}
            d["id"] = m.group(1)
            d["slug"] = ensure_unique_slug(db, slugify(d.get("slug") or d.get("title")), d["id"])
            d["createdAt"] = db["diagnoses"][idx].get("createdAt") or now_iso()
            d["updatedAt"] = now_iso()
            db["diagnoses"][idx] = d
            save_db(db)
        return self._send_json(d)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        m = re.match(r"^/api/diagnoses/([^/]+)$", parsed.path)
        if not m:
            return self._send_json({"error": "not found"}, 404)
        with _lock:
            db = load_db()
            before = len(db["diagnoses"])
            db["diagnoses"] = [x for x in db["diagnoses"] if x["id"] != m.group(1)]
            db["events"] = [e for e in db["events"] if e.get("diagnosisId") != m.group(1)]
            save_db(db)
        return self._send_json({"ok": True, "deleted": before - len(db["diagnoses"])})


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"AI診断LPビルダー 起動中  →  http://localhost:{PORT}/")
    print(f"データ保存先: {DB_PATH}")
    print("停止するには Ctrl+C")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n停止しました")


if __name__ == "__main__":
    main()
