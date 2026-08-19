#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════╗
║  PHANTOM GRID v2.0 — OOB Collaborator Server                    ║
║  Out-of-Band Interaction Capture Server                          ║
║                                                                  ║
║  Features:                                                       ║
║  • HTTP/HTTPS callback capture (all methods)                     ║
║  • DNS callback capture with exfil data reassembly               ║
║  • SQLite persistence — survives restarts                        ║
║  • Auto-generated self-signed TLS certs                          ║
║  • Real-time polling API for the dashboard                       ║
║  • Token management with stats                                   ║
║  • Full request logging (headers, body, IP, method)              ║
║                                                                  ║
║  Usage:                                                          ║
║    pip install flask flask-cors                                   ║
║    python server.py                         # HTTP only           ║
║    python server.py --https                 # HTTP + HTTPS        ║
║    sudo python server.py --dns --https      # Full stack          ║
║                                                                  ║
║  For labs:                                                       ║
║    ngrok http 9090                                               ║
╚══════════════════════════════════════════════════════════════════╝
"""

import argparse
import json
import os
import socket
import sqlite3
import ssl
import struct
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, request, jsonify, Response, g
from flask_cors import CORS


# ═══════════════════════════════════════════════════════════════
#  CONFIGURATION
# ═══════════════════════════════════════════════════════════════

HTTP_PORT = 9090
HTTPS_PORT = 9443
DNS_PORT = 53
DB_PATH = "phantom_grid.db"
CERT_DIR = "certs"
MAX_BODY_SIZE = 8192
MAX_EXFIL_CHUNKS = 100


# ═══════════════════════════════════════════════════════════════
#  DATABASE (SQLite)
# ═══════════════════════════════════════════════════════════════

def get_db():
    """Get thread-local database connection (Flask request context)."""
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA busy_timeout=5000")
    return g.db


def init_db():
    """Initialize database schema."""
    conn = sqlite3.connect(DB_PATH)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS tokens (
            id          TEXT PRIMARY KEY,
            label       TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            notes       TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS interactions (
            id          TEXT PRIMARY KEY,
            token_id    TEXT NOT NULL,
            type        TEXT NOT NULL,
            time        TEXT NOT NULL DEFAULT (datetime('now')),
            source_ip   TEXT,
            method      TEXT,
            path        TEXT,
            query       TEXT,
            headers     TEXT,
            body        TEXT,
            content_type TEXT,
            query_name  TEXT,
            query_type  TEXT,
            exfil_data  TEXT,
            raw_labels  TEXT,
            FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS dns_exfil_sessions (
            id          TEXT PRIMARY KEY,
            token_id    TEXT NOT NULL,
            session_tag TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            completed   INTEGER DEFAULT 0,
            FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS dns_exfil_chunks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            data        TEXT NOT NULL,
            received_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (session_id) REFERENCES dns_exfil_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ix_token ON interactions(token_id);
        CREATE INDEX IF NOT EXISTS idx_ix_time ON interactions(time);
        CREATE INDEX IF NOT EXISTS idx_exfil_session ON dns_exfil_chunks(session_id);
    """)
    conn.commit()
    conn.close()


# Thread-safe DB for background threads (DNS server)
_bg_db_lock = threading.Lock()

def bg_db_execute(query, params=(), fetch=False, fetchone=False):
    """Thread-safe DB execute for non-request threads."""
    with _bg_db_lock:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cur = conn.execute(query, params)
        if fetchone:
            result = cur.fetchone()
        elif fetch:
            result = cur.fetchall()
        else:
            conn.commit()
            result = cur.lastrowid
        conn.close()
        return result


# ═══════════════════════════════════════════════════════════════
#  FLASK APP
# ═══════════════════════════════════════════════════════════════

app = Flask(__name__)
CORS(app)


@app.teardown_appcontext
def close_db(exception):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def _parse_json_fields(row_dict):
    """Parse JSON string fields back to objects."""
    for field in ("headers", "raw_labels"):
        if row_dict.get(field):
            try:
                row_dict[field] = json.loads(row_dict[field])
            except (json.JSONDecodeError, TypeError):
                pass
    return row_dict


# ─── Token Management ────────────────────────────────────────

@app.route("/api/tokens", methods=["GET"])
def list_tokens():
    db = get_db()
    tokens = db.execute("""
        SELECT t.id, t.label, t.created_at, t.notes,
               COUNT(i.id) as interaction_count,
               MAX(i.time) as last_hit
        FROM tokens t
        LEFT JOIN interactions i ON i.token_id = t.id
        GROUP BY t.id
        ORDER BY t.created_at DESC
    """).fetchall()
    return jsonify([dict(t) for t in tokens])


@app.route("/api/tokens", methods=["POST"])
def create_token():
    body = request.get_json(silent=True) or {}
    tid = uuid.uuid4().hex[:12]
    label = body.get("label", "").strip() or f"tkn-{tid[:6]}"
    notes = body.get("notes", "")
    db = get_db()
    db.execute("INSERT INTO tokens (id, label, notes) VALUES (?, ?, ?)", (tid, label, notes))
    db.commit()
    return jsonify({"id": tid, "label": label}), 201


@app.route("/api/tokens/<tid>", methods=["DELETE"])
def delete_token(tid):
    db = get_db()
    # CASCADE deletes interactions and exfil data
    db.execute("PRAGMA foreign_keys = ON")
    cur = db.execute("DELETE FROM tokens WHERE id = ?", (tid,))
    db.commit()
    if cur.rowcount:
        return jsonify({"deleted": True})
    return jsonify({"error": "not found"}), 404


@app.route("/api/tokens/<tid>", methods=["PATCH"])
def update_token(tid):
    body = request.get_json(silent=True) or {}
    db = get_db()
    sets, params = [], []
    for k in ("label", "notes"):
        if k in body:
            sets.append(f"{k} = ?")
            params.append(body[k])
    if not sets:
        return jsonify({"error": "nothing to update"}), 400
    params.append(tid)
    db.execute(f"UPDATE tokens SET {', '.join(sets)} WHERE id = ?", params)
    db.commit()
    return jsonify({"updated": True})


# ─── Interactions ─────────────────────────────────────────────

@app.route("/api/tokens/<tid>/interactions", methods=["GET"])
def get_interactions(tid):
    db = get_db()
    limit = request.args.get("limit", 200, type=int)
    offset = request.args.get("offset", 0, type=int)
    rows = db.execute(
        "SELECT * FROM interactions WHERE token_id = ? ORDER BY time DESC LIMIT ? OFFSET ?",
        (tid, limit, offset),
    ).fetchall()
    return jsonify([_parse_json_fields(dict(r)) for r in rows])


@app.route("/api/tokens/<tid>/interactions", methods=["DELETE"])
def clear_interactions(tid):
    db = get_db()
    db.execute("DELETE FROM interactions WHERE token_id = ?", (tid,))
    db.commit()
    return jsonify({"cleared": True})


@app.route("/api/log", methods=["GET"])
def get_global_log():
    db = get_db()
    limit = request.args.get("limit", 200, type=int)
    rows = db.execute(
        "SELECT * FROM interactions ORDER BY time DESC LIMIT ?", (limit,)
    ).fetchall()
    return jsonify([_parse_json_fields(dict(r)) for r in rows])


@app.route("/api/poll", methods=["GET"])
def poll():
    since = request.args.get("since", "")
    db = get_db()
    if since:
        rows = db.execute(
            "SELECT * FROM interactions WHERE time > ? ORDER BY time ASC", (since,)
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT * FROM interactions ORDER BY time DESC LIMIT 50"
        ).fetchall()
    result = {}
    for r in rows:
        d = _parse_json_fields(dict(r))
        result.setdefault(d["token_id"], []).append(d)
    return jsonify(result)


# ─── DNS Exfiltration API ────────────────────────────────────

@app.route("/api/tokens/<tid>/exfil", methods=["GET"])
def get_exfil_sessions(tid):
    db = get_db()
    sessions = db.execute(
        "SELECT * FROM dns_exfil_sessions WHERE token_id = ? ORDER BY created_at DESC", (tid,)
    ).fetchall()
    result = []
    for s in sessions:
        sd = dict(s)
        chunks = db.execute(
            "SELECT chunk_index, data, received_at FROM dns_exfil_chunks WHERE session_id = ? ORDER BY chunk_index",
            (s["id"],),
        ).fetchall()
        sd["chunks"] = [dict(c) for c in chunks]
        sd["reassembled"] = "".join(c["data"] for c in chunks)
        sd["chunk_count"] = len(chunks)
        result.append(sd)
    return jsonify(result)


@app.route("/api/stats", methods=["GET"])
def get_stats():
    db = get_db()
    return jsonify({
        "tokens": db.execute("SELECT COUNT(*) as c FROM tokens").fetchone()["c"],
        "interactions": db.execute("SELECT COUNT(*) as c FROM interactions").fetchone()["c"],
        "http": db.execute("SELECT COUNT(*) as c FROM interactions WHERE type='HTTP'").fetchone()["c"],
        "dns": db.execute("SELECT COUNT(*) as c FROM interactions WHERE type='DNS'").fetchone()["c"],
        "exfil_sessions": db.execute("SELECT COUNT(*) as c FROM dns_exfil_sessions").fetchone()["c"],
        "db_size_mb": round(os.path.getsize(DB_PATH) / 1048576, 2) if os.path.exists(DB_PATH) else 0,
    })


# ═══════════════════════════════════════════════════════════════
#  HTTP(S) CALLBACK CAPTURE
# ═══════════════════════════════════════════════════════════════

@app.route("/c/<tid>", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
@app.route("/c/<tid>/<path:extra>", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
def capture_http(tid, extra=""):
    ix_id = uuid.uuid4().hex[:8]
    now = datetime.now(timezone.utc).isoformat()
    source_ip = request.headers.get("X-Forwarded-For", request.remote_addr)

    db = get_db()
    token = db.execute("SELECT id FROM tokens WHERE id = ?", (tid,)).fetchone()

    proto = "HTTPS" if request.is_secure else "HTTP"

    if token:
        db.execute(
            """INSERT INTO interactions
               (id, token_id, type, time, source_ip, method, path, query, headers, body, content_type)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (ix_id, tid, proto, now, source_ip, request.method,
             f"/{extra}" if extra else "/",
             request.query_string.decode("utf-8", errors="replace"),
             json.dumps(dict(request.headers)),
             request.get_data(as_text=True)[:MAX_BODY_SIZE],
             request.content_type or ""),
        )
        db.commit()
        print(f"  [{proto}] ← {request.method} from {source_ip} → token {tid}")
    else:
        print(f"  [{proto}] ← {request.method} from {source_ip} → unknown token {tid}")

    return Response("ok", status=200)


# ═══════════════════════════════════════════════════════════════
#  DNS EXFILTRATION REASSEMBLY
# ═══════════════════════════════════════════════════════════════

class DNSExfilReassembler:
    """
    Reassembles chunked DNS exfiltration data.

    Supported formats:
        <data>.<token>.<domain>                       → single chunk
        <index>.<data>.<token>.<domain>               → auto-session indexed
        <session>.<index>.<data>.<token>.<domain>     → named session indexed
        end.<session>.<token>.<domain>                → mark session complete
    """

    @staticmethod
    def process(token_id, labels, token_idx):
        prefix = labels[:token_idx]
        if not prefix:
            return None, None

        # Single label → simple exfil
        if len(prefix) == 1:
            data = prefix[0]
            sid = DNSExfilReassembler._store_simple(token_id, data)
            return data, {"session_id": sid, "type": "simple"}

        # "end" signal
        if prefix[0].lower() == "end" and len(prefix) >= 2:
            tag = prefix[1]
            DNSExfilReassembler._complete(token_id, tag)
            return f"[END:{tag}]", {"session_tag": tag, "type": "end_signal"}

        # <index>.<data>... → auto-session
        if prefix[0].isdigit():
            idx = int(prefix[0])
            data = ".".join(prefix[1:])
            tag = f"auto-{token_id}"
            sid = DNSExfilReassembler._store_chunk(token_id, tag, idx, data)
            return data, {"session_id": sid, "session_tag": tag, "chunk_index": idx, "type": "indexed"}

        # <session>.<index>.<data>... → named session
        if len(prefix) >= 3 and prefix[1].isdigit():
            tag = prefix[0]
            idx = int(prefix[1])
            data = ".".join(prefix[2:])
            sid = DNSExfilReassembler._store_chunk(token_id, tag, idx, data)
            return data, {"session_id": sid, "session_tag": tag, "chunk_index": idx, "type": "tagged"}

        # Fallback
        data = ".".join(prefix)
        sid = DNSExfilReassembler._store_simple(token_id, data)
        return data, {"session_id": sid, "type": "simple"}

    @staticmethod
    def _get_or_create_session(token_id, tag):
        row = bg_db_execute(
            "SELECT id FROM dns_exfil_sessions WHERE token_id = ? AND session_tag = ?",
            (token_id, tag), fetchone=True,
        )
        if row:
            return row["id"]
        sid = uuid.uuid4().hex[:10]
        bg_db_execute(
            "INSERT INTO dns_exfil_sessions (id, token_id, session_tag) VALUES (?, ?, ?)",
            (sid, token_id, tag),
        )
        return sid

    @staticmethod
    def _store_simple(token_id, data):
        tag = f"single-{uuid.uuid4().hex[:6]}"
        sid = DNSExfilReassembler._get_or_create_session(token_id, tag)
        bg_db_execute("INSERT INTO dns_exfil_chunks (session_id, chunk_index, data) VALUES (?, 0, ?)", (sid, data))
        bg_db_execute("UPDATE dns_exfil_sessions SET completed = 1 WHERE id = ?", (sid,))
        return sid

    @staticmethod
    def _store_chunk(token_id, tag, idx, data):
        sid = DNSExfilReassembler._get_or_create_session(token_id, tag)
        exists = bg_db_execute(
            "SELECT id FROM dns_exfil_chunks WHERE session_id = ? AND chunk_index = ?",
            (sid, idx), fetchone=True,
        )
        if not exists:
            bg_db_execute(
                "INSERT INTO dns_exfil_chunks (session_id, chunk_index, data) VALUES (?, ?, ?)",
                (sid, idx, data),
            )
        return sid

    @staticmethod
    def _complete(token_id, tag):
        bg_db_execute(
            "UPDATE dns_exfil_sessions SET completed = 1 WHERE token_id = ? AND session_tag = ?",
            (token_id, tag),
        )


# ═══════════════════════════════════════════════════════════════
#  DNS SERVER
# ═══════════════════════════════════════════════════════════════

class DNSServer(threading.Thread):
    def __init__(self, port=DNS_PORT, response_ip="127.0.0.1"):
        super().__init__(daemon=True)
        self.port = port
        self.response_ip = response_ip
        self._token_cache = set()
        self._cache_lock = threading.Lock()
        self._refresh_cache()

    def _refresh_cache(self):
        rows = bg_db_execute("SELECT id FROM tokens", fetch=True)
        with self._cache_lock:
            self._token_cache = {r["id"] for r in rows} if rows else set()

    def run(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("0.0.0.0", self.port))
        except PermissionError:
            print(f"  [DNS] ✗ Cannot bind :{self.port} — run with sudo")
            return
        except OSError as e:
            print(f"  [DNS] ✗ {e}")
            return

        print(f"  [DNS] ✓ Listening on UDP :{self.port}")

        def cache_loop():
            while True:
                time.sleep(10)
                self._refresh_cache()

        threading.Thread(target=cache_loop, daemon=True).start()

        while True:
            try:
                data, addr = sock.recvfrom(1024)
                threading.Thread(target=self._handle, args=(sock, data, addr), daemon=True).start()
            except Exception as e:
                print(f"  [DNS] Error: {e}")

    def _handle(self, sock, data, addr):
        if len(data) < 12:
            return

        tx_id = data[:2]
        pos = 12
        labels = []
        while pos < len(data):
            length = data[pos]
            if length == 0:
                pos += 1
                break
            pos += 1
            labels.append(data[pos:pos + length].decode("ascii", errors="replace"))
            pos += length

        qname = ".".join(labels)
        qtype = struct.unpack("!H", data[pos:pos + 2])[0] if pos + 4 <= len(data) else 1
        qtype_str = {1: "A", 28: "AAAA", 16: "TXT", 15: "MX", 2: "NS", 5: "CNAME"}.get(qtype, str(qtype))

        # Match token
        matched = None
        token_idx = None
        with self._cache_lock:
            cached = self._token_cache.copy()
        for tid in cached:
            for i, lbl in enumerate(labels):
                if lbl == tid:
                    matched = tid
                    token_idx = i
                    break
            if matched:
                break

        if matched:
            exfil_data, exfil_info = (None, None)
            if token_idx and token_idx > 0:
                exfil_data, exfil_info = DNSExfilReassembler.process(matched, labels, token_idx)

            ix_id = uuid.uuid4().hex[:8]
            now = datetime.now(timezone.utc).isoformat()
            bg_db_execute(
                """INSERT INTO interactions
                   (id, token_id, type, time, source_ip, query_name, query_type, exfil_data, raw_labels)
                   VALUES (?, ?, 'DNS', ?, ?, ?, ?, ?, ?)""",
                (ix_id, matched, now, addr[0], qname, qtype_str, exfil_data, json.dumps(labels)),
            )

            msg = f"  [DNS] ← {qname} from {addr[0]} → {matched}"
            if exfil_data:
                msg += f" | exfil: {exfil_data}"
                if exfil_info and exfil_info.get("type") == "tagged":
                    msg += f" [session:{exfil_info['session_tag']} #{exfil_info['chunk_index']}]"
            print(msg)

        # Respond
        resp = self._response(tx_id, data[12:pos + 4], qtype)
        sock.sendto(resp, addr)

    def _response(self, tx_id, question, qtype):
        flags = b"\x81\x80"
        counts = struct.pack("!HHHH", 1, 1, 0, 0)
        ans = b"\xc0\x0c"
        if qtype == 28:
            ans += struct.pack("!HHI", 28, 1, 60) + struct.pack("!H", 16)
            ans += socket.inet_pton(socket.AF_INET6, "::1")
        else:
            ans += struct.pack("!HHI", 1, 1, 60) + struct.pack("!H", 4)
            ans += socket.inet_aton(self.response_ip)
        return tx_id + flags + counts + question + ans


# ═══════════════════════════════════════════════════════════════
#  HTTPS / TLS
# ═══════════════════════════════════════════════════════════════

def generate_self_signed_cert(cert_dir=CERT_DIR, cn="phantom-grid.local"):
    path = Path(cert_dir)
    path.mkdir(parents=True, exist_ok=True)
    cert_f = path / "server.pem"
    key_f = path / "server.key"

    if cert_f.exists() and key_f.exists():
        print(f"  [TLS] ✓ Existing cert: {cert_f}")
        return str(cert_f), str(key_f)

    print("  [TLS] ◎ Generating self-signed certificate...")
    try:
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", str(key_f), "-out", str(cert_f),
            "-days", "365", "-nodes",
            "-subj", f"/CN={cn}/O=PhantomGrid/C=XX",
            "-addext", f"subjectAltName=DNS:{cn},DNS:*.{cn},IP:127.0.0.1",
        ], check=True, capture_output=True)
        print(f"  [TLS] ✓ Generated: {cert_f}")
        return str(cert_f), str(key_f)
    except FileNotFoundError:
        print("  [TLS] ✗ openssl not found. Install it or provide --cert/--key.")
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(f"  [TLS] ✗ Failed: {e.stderr.decode()}")
        sys.exit(1)


def run_https(app, port, cert, key):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    from werkzeug.serving import make_server
    srv = make_server("0.0.0.0", port, app, ssl_context=ctx, threaded=True)
    print(f"  [HTTPS] ✓ https://0.0.0.0:{port}")
    srv.serve_forever()


# ═══════════════════════════════════════════════════════════════
#  INFO ROUTES
# ═══════════════════════════════════════════════════════════════

@app.route("/", methods=["GET"])
def index():
    return jsonify({
        "service": "Phantom Grid — OOB Collaborator",
        "version": "2.0.0",
        "features": ["HTTP", "HTTPS", "DNS", "DNS exfil reassembly", "SQLite"],
        "endpoints": {
            "tokens": "/api/tokens",
            "capture_http": "/c/<token>",
            "capture_dns": "<token>.yourdomain.com",
            "poll": "/api/poll?since=<ISO>",
            "log": "/api/log",
            "stats": "/api/stats",
            "exfil": "/api/tokens/<id>/exfil",
        },
    })


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "db": os.path.exists(DB_PATH)})


# ═══════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════

def banner(a):
    print(r"""
    ╔═══════════════════════════════════════════════════╗
    ║                                                   ║
    ║   ▄▄▄▄▄  ▄  ▄  ▄▄▄  ▄   ▄ ▄▄▄▄▄ ▄▄▄  ▄   ▄     ║
    ║   █   █  █▄▄█  █▄▄█ █▄  █   █   █   █ ██ ██     ║
    ║   █▄▄▄█  █  █  █  █ █ ▀▄█   █   █   █ █ █ █     ║
    ║   █      █  █  █  █ █  ▀█   █   █▄▄▄█ █   █     ║
    ║                                                   ║
    ║       ┌─ G R I D  v2.0 ─────────────────┐        ║
    ║       │  SQLite · HTTPS · DNS Reassembly │        ║
    ║       └──────────────────────────────────┘        ║
    ║                                                   ║
    ╚═══════════════════════════════════════════════════╝
    """)
    print(f"  [DB]    ✓ {os.path.abspath(DB_PATH)}")
    print(f"  [HTTP]  ✓ http://0.0.0.0:{a.port}")
    if a.https:
        print(f"  [HTTPS] ✓ https://0.0.0.0:{a.https_port}")
    if a.dns:
        print(f"  [DNS]   ◎ UDP :{a.dns_port}")
    else:
        print(f"  [DNS]   ✗ off (use --dns)")
    print()
    print(f"  Callbacks:")
    print(f"    HTTP  → http://<IP>:{a.port}/c/<TOKEN>")
    if a.https:
        print(f"    HTTPS → https://<IP>:{a.https_port}/c/<TOKEN>")
    print(f"    DNS   → <TOKEN>.yourdomain.com")
    print()
    print(f"  DNS Exfil formats:")
    print(f"    Simple    → <data>.<TOKEN>.domain")
    print(f"    Indexed   → <N>.<data>.<TOKEN>.domain")
    print(f"    Session   → <tag>.<N>.<data>.<TOKEN>.domain")
    print(f"    End       → end.<tag>.<TOKEN>.domain")
    print()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Phantom Grid v2.0")
    p.add_argument("--port", type=int, default=HTTP_PORT)
    p.add_argument("--https", action="store_true", help="Enable HTTPS")
    p.add_argument("--https-port", type=int, default=HTTPS_PORT)
    p.add_argument("--cert", type=str, default=None, help="TLS cert PEM")
    p.add_argument("--key", type=str, default=None, help="TLS key file")
    p.add_argument("--dns", action="store_true", help="Enable DNS server")
    p.add_argument("--dns-port", type=int, default=DNS_PORT)
    p.add_argument("--dns-ip", type=str, default="127.0.0.1", help="IP in DNS responses")
    p.add_argument("--db", type=str, default=DB_PATH, help="SQLite path")
    a = p.parse_args()

    DB_PATH = a.db
    init_db()
    banner(a)

    if a.dns:
        DNSServer(port=a.dns_port, response_ip=a.dns_ip).start()

    if a.https:
        cert, key = (a.cert, a.key) if a.cert and a.key else generate_self_signed_cert()
        threading.Thread(target=run_https, args=(app, a.https_port, cert, key), daemon=True).start()

    app.run(host="0.0.0.0", port=a.port, debug=False, threaded=True)
