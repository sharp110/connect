const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const selfsigned = require("selfsigned");
const { WebSocketServer } = require("ws");

// ---- config ----
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "2020";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const LOGIN_WINDOW_MS = 60 * 1000; // rate limit window
const LOGIN_MAX_ATTEMPTS = 5; // per ip per window
const AUDIT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB rotate

const isHosted = !!(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RENDER ||
  process.env.FLY_APP_NAME ||
  process.env.DYNO ||
  process.env.K_SERVICE ||
  process.env.WEBSITE_HOSTNAME
);
const USE_HTTPS =
  process.env.USE_HTTPS === "1" || (!isHosted && process.env.USE_HTTPS !== "0");

// ---- paths ----
const DATA_FILE = path.join(__dirname, "data.json");
const AUDIT_FILE = path.join(__dirname, "audit.log");
const LOG_DIR = path.join(__dirname, "logs");

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {}
const APP_LOG_FILE = path.join(LOG_DIR, "app.log");

// ---- loggers ----
function ts() {
  return new Date().toISOString();
}
function appLog(level, msg, extra) {
  const line = `[${ts()}] ${level} ${msg}${extra ? " " + JSON.stringify(extra) : ""}\n`;
  try {
    fs.appendFileSync(APP_LOG_FILE, line);
  } catch {}
  if (process.env.NODE_ENV !== "production") {
    if (level === "error") console.error(line.trim());
    else console.log(line.trim());
  }
}
function rotateAuditIfNeeded() {
  try {
    const st = fs.statSync(AUDIT_FILE);
    if (st.size > AUDIT_MAX_BYTES) {
      const old = AUDIT_FILE + ".1";
      try {
        fs.unlinkSync(old);
      } catch {}
      fs.renameSync(AUDIT_FILE, old);
    }
  } catch {}
}
function audit(action, extra) {
  rotateAuditIfNeeded();
  const line = `[${ts()}] ${action}${extra ? " " + JSON.stringify(extra) : ""}\n`;
  try {
    fs.appendFileSync(AUDIT_FILE, line);
  } catch {}
}

// ---- app ----
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'self'",
    ].join("; "),
  );
  next();
});

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.redirect("/visitor.html"));

// ---- admin auth ----
// token -> { expiresAt }
const adminSessions = new Map();
// ip -> [timestamps]
const loginAttempts = new Map();

function clientIp(req) {
  return (
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function rateLimitOk(ip) {
  const now = Date.now();
  const arr = loginAttempts.get(ip) || [];
  const recent = arr.filter((t) => now - t < LOGIN_WINDOW_MS);
  if (recent.length >= LOGIN_MAX_ATTEMPTS) {
    loginAttempts.set(ip, recent);
    return false;
  }
  recent.push(now);
  loginAttempts.set(ip, recent);
  return true;
}

app.post("/api/login", (req, res) => {
  const ip = clientIp(req);
  if (!rateLimitOk(ip)) {
    audit("login.rate_limited", { ip });
    return res.status(429).json({ error: "too many attempts, wait a minute" });
  }
  const { password } = req.body || {};
  if (typeof password !== "string" || password.length === 0) {
    return res.status(400).json({ error: "password required" });
  }
  const a = Buffer.from(password);
  const b = Buffer.from(ADMIN_PASSWORD);
  const same = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!same) {
    audit("login.failed", { ip });
    return res.status(401).json({ error: "wrong password" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  audit("login.success", { ip });
  res.json({ token, expiresAt: Date.now() + SESSION_TTL_MS });
});

function verifyToken(token) {
  const s = adminSessions.get(token);
  if (!s) return false;
  if (s.expiresAt < Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  // extend on use
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  return true;
}

// periodic session cleanup
setInterval(
  () => {
    const now = Date.now();
    for (const [t, s] of adminSessions)
      if (s.expiresAt < now) adminSessions.delete(t);
  },
  5 * 60 * 1000,
);

app.get("/api/visitors", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (!verifyToken(token))
    return res.status(401).json({ error: "unauthorized" });
  res.json({ visitors: [...visitors.values()].map(serializeVisitor) });
});

app.get("/api/health", (req, res) => {
  const mem = process.memoryUsage();
  let online = 0;
  for (const v of visitors.values()) if (v.online) online++;
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    visitors: visitors.size,
    online,
    memoryMB: Math.round(mem.rss / 1024 / 1024),
  });
});

app.get("/api/metrics", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (!verifyToken(token))
    return res.status(401).json({ error: "unauthorized" });
  res.json(computeMetrics());
});

// ---- http/https ----
let server;
if (USE_HTTPS) {
  const CERT_PATH = path.join(__dirname, "cert.pem");
  const KEY_PATH = path.join(__dirname, "key.pem");
  if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
    const pems = selfsigned.generate(
      [{ name: "commonName", value: "localhost" }],
      { days: 365, keySize: 2048 },
    );
    fs.writeFileSync(CERT_PATH, pems.cert);
    fs.writeFileSync(KEY_PATH, pems.private);
    appLog("info", "https cert generated");
  }
  server = https.createServer(
    {
      key: fs.readFileSync(KEY_PATH),
      cert: fs.readFileSync(CERT_PATH),
    },
    app,
  );
} else {
  server = http.createServer(app);
}

// ---- websocket ----
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 4 * 1024 * 1024,
});

const visitors = new Map();
const adminSockets = new Set();
const fpToId = new Map();

// events ring buffer for metrics
const events = [];
function pushEvent(type, extra) {
  events.push({ ts: Date.now(), type, ...(extra || {}) });
  if (events.length > 5000) events.splice(0, events.length - 5000);
}

function serializeVisitor(v) {
  return {
    id: v.id,
    fp: v.fp,
    ua: v.ua,
    ip: v.ip,
    connectedAt: v.connectedAt,
    online: !!v.online,
    lastFrame: v.lastFrame || null,
  };
}

// ---- persistence ----
function loadVisitors() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    for (const v of arr) {
      if (!v || typeof v.id !== "string") continue;
      visitors.set(v.id, {
        id: v.id,
        fp: v.fp || null,
        ua: v.ua || "unknown",
        ip: v.ip || "",
        connectedAt: v.connectedAt || Date.now(),
        online: false,
        ws: null,
        lastFrame: v.lastFrame || null,
      });
      if (v.fp) fpToId.set(v.fp, v.id);
    }
    appLog("info", `persistence loaded ${visitors.size}`);
  } catch (e) {
    appLog("error", "persistence load failed", { err: e.message });
  }
}

let saveTimer = null;
function saveVisitorsSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveVisitors();
  }, 500);
}

function saveVisitors() {
  try {
    const arr = [...visitors.values()].map((v) => ({
      id: v.id,
      fp: v.fp,
      ua: v.ua,
      ip: v.ip,
      connectedAt: v.connectedAt,
      lastFrame: v.lastFrame || null,
    }));
    fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {
    appLog("error", "persistence save failed", { err: e.message });
  }
}

loadVisitors();

// ---- metrics ----
function computeMetrics() {
  const now = Date.now();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const today = events.filter((e) => e.ts >= dayStart.getTime());

  let peakConcurrent = 0;
  let currentConcurrent = 0;
  for (const e of today) {
    if (e.type === "visitor.join") {
      currentConcurrent++;
      peakConcurrent = Math.max(peakConcurrent, currentConcurrent);
    } else if (e.type === "visitor.leave")
      currentConcurrent = Math.max(0, currentConcurrent - 1);
  }

  const joins = today.filter((e) => e.type === "visitor.join");
  const leaves = today.filter((e) => e.type === "visitor.leave");
  const messages = today.filter((e) => e.type === "message.sent").length;

  // session durations
  let totalDuration = 0,
    durationCount = 0;
  const joinByFp = new Map();
  for (const e of events) {
    if (e.type === "visitor.join" && e.fp) joinByFp.set(e.fp, e.ts);
    else if (e.type === "visitor.leave" && e.fp && joinByFp.has(e.fp)) {
      totalDuration += e.ts - joinByFp.get(e.fp);
      durationCount++;
      joinByFp.delete(e.fp);
    }
  }

  return {
    today: {
      joins: joins.length,
      leaves: leaves.length,
      uniqueVisitors: new Set(joins.map((j) => j.fp || j.id)).size,
      messages,
    },
    concurrent: {
      current: [...visitors.values()].filter((v) => v.online).length,
      peakToday: peakConcurrent,
    },
    sessions: {
      avgDurationSec:
        durationCount > 0
          ? Math.round(totalDuration / durationCount / 1000)
          : 0,
      completedToday: durationCount,
    },
    eventsToday: today.length,
    recentEvents: events.slice(-50).reverse(),
  };
}

// ---- heartbeat ----
function heartbeatLoop() {
  for (const ws of adminSockets) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
  for (const v of visitors.values()) {
    if (!v.ws) continue;
    if (v.ws.isAlive === false) {
      try {
        v.ws.terminate();
      } catch {}
      continue;
    }
    v.ws.isAlive = false;
    try {
      v.ws.ping();
    } catch {}
  }
}
const heartbeatHandle = setInterval(heartbeatLoop, 30000);

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const role = url.searchParams.get("role");
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress;

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  if (role === "admin") {
    const token = url.searchParams.get("token");
    if (!verifyToken(token)) {
      ws.close(4001, "unauthorized");
      return;
    }
    adminSockets.add(ws);
    ws.send(
      JSON.stringify({
        type: "visitors",
        visitors: [...visitors.values()].map(serializeVisitor),
      }),
    );

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "delete-visitor" && typeof msg.id === "string") {
        const v = visitors.get(msg.id);
        if (v) {
          if (v.ws) {
            try {
              v.ws.close(4004, "deleted");
            } catch {}
          }
          visitors.delete(msg.id);
          if (v.fp) fpToId.delete(v.fp);
          saveVisitorsSoon();
          audit("visitor.delete", { id: msg.id, fp: v.fp, ip: v.ip });
          pushEvent("visitor.delete", { id: msg.id, fp: v.fp });
          broadcastAdmins({ type: "visitor-deleted", id: msg.id });
        }
        return;
      }

      if (
        msg.type === "send-message" &&
        typeof msg.id === "string" &&
        typeof msg.text === "string"
      ) {
        let v = visitors.get(msg.id);
        let resolvedId = msg.id;
        if (!v && msg.fp) {
          for (const [vid, vv] of visitors) {
            if (vv.fp === msg.fp && vv.ws) {
              v = vv;
              resolvedId = vid;
              break;
            }
          }
        }
        if (!v || !v.ws || v.ws.readyState !== 1) {
          try {
            ws.send(
              JSON.stringify({
                type: "send-message-failed",
                id: msg.id,
                reason: "visitor offline",
              }),
            );
          } catch {}
          return;
        }
        const payload = {
          type: "admin-message",
          text: msg.text.slice(0, 1000),
          ts: Date.now(),
        };
        try {
          v.ws.send(JSON.stringify(payload));
          audit("message.sent", { to: resolvedId, len: payload.text.length });
          pushEvent("message.sent", { id: resolvedId, fp: v.fp });
          try {
            ws.send(JSON.stringify({ type: "send-message-ok", id: msg.id }));
          } catch {}
        } catch (e) {
          try {
            ws.send(
              JSON.stringify({
                type: "send-message-failed",
                id: msg.id,
                reason: "send error",
              }),
            );
          } catch {}
        }
        v.pendingMessage = payload;
        return;
      }
    });

    ws.on("close", () => adminSockets.delete(ws));
    return;
  }

  if (role === "visitor") {
    const fp = url.searchParams.get("fp");
    let id = null;
    let isRejoin = false;
    if (fp && fpToId.has(fp)) {
      const existingId = fpToId.get(fp);
      if (visitors.has(existingId)) {
        id = existingId;
        isRejoin = true;
      }
    }
    if (!id) id = crypto.randomBytes(8).toString("hex");

    const prev = visitors.get(id);
    if (prev && prev.ws && prev.ws !== ws) {
      try {
        prev.ws.close(4003, "replaced");
      } catch {}
    }

    const visitor = {
      id,
      fp: fp || null,
      ua: req.headers["user-agent"] || "unknown",
      ip,
      connectedAt: prev ? prev.connectedAt : Date.now(),
      online: true,
      ws,
      lastFrame: prev ? prev.lastFrame : null,
      pendingMessage: prev ? prev.pendingMessage : null,
    };
    visitors.set(id, visitor);
    if (fp) fpToId.set(fp, id);
    saveVisitorsSoon();
    ws.send(JSON.stringify({ type: "welcome", id, isRejoin }));

    broadcastAdmins({
      type: "visitor-joined",
      visitor: serializeVisitor(visitor),
      isRejoin,
    });

    audit("visitor.join", { id, fp, ip, isRejoin });
    pushEvent("visitor.join", { id, fp });

    if (visitor.pendingMessage) {
      try {
        ws.send(JSON.stringify(visitor.pendingMessage));
      } catch {}
      visitor.pendingMessage = null;
    }

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== "string") return;
      msg.from = id;
      if (msg.type === "frame" && typeof msg.data === "string") {
        const v = visitors.get(id);
        if (v) {
          v.lastFrame = msg.data;
          saveVisitorsSoon();
        }
      }
      broadcastAdmins(msg);
    });

    ws.on("close", () => {
      const v = visitors.get(id);
      if (v && v.ws === ws) {
        v.online = false;
        v.ws = null;
      }
      saveVisitorsSoon();
      audit("visitor.leave", { id, fp });
      pushEvent("visitor.leave", { id, fp });
      broadcastAdmins({ type: "visitor-offline", id });
    });
    return;
  }

  ws.close(4002, "bad role");
});

function broadcastAdmins(obj) {
  const payload = JSON.stringify(obj);
  for (const ws of adminSockets) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

server.listen(PORT, () => {
  const proto = USE_HTTPS ? "https" : "http";
  appLog("info", `listening on ${proto}://0.0.0.0:${PORT}`);
  console.log(`[screenshare-admin] ${proto}://0.0.0.0:${PORT}`);
  console.log(
    `[screenshare-admin] admin:   ${proto}://localhost:${PORT}/admin.html`,
  );
  console.log(
    `[screenshare-admin] visitor: ${proto}://localhost:${PORT}/visitor.html`,
  );
  console.log(
    `[screenshare-admin] metrics: ${proto}://localhost:${PORT}/metrics.html`,
  );
  console.log(
    `[screenshare-admin] password: ${ADMIN_PASSWORD === "change-me-now" ? "DEFAULT — CHANGE IT" : "custom"}`,
  );
  console.log(`[screenshare-admin] data:    ${DATA_FILE}`);
  console.log(`[screenshare-admin] audit:   ${AUDIT_FILE}`);
  console.log(`[screenshare-admin] applog:  ${APP_LOG_FILE}`);
});

// ---- graceful shutdown ----
function shutdown(sig) {
  appLog("info", `shutting down (${sig})`);
  console.log(`[screenshare-admin] ${sig}, saving state…`);
  clearInterval(heartbeatHandle);
  saveVisitors();
  for (const ws of adminSockets) {
    try {
      ws.close(1001, "shutdown");
    } catch {}
  }
  for (const v of visitors.values()) {
    if (v.ws) {
      try {
        v.ws.close(1001, "shutdown");
      } catch {}
    }
  }
  server.close(() => {
    console.log("[screenshare-admin] closed cleanly");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
