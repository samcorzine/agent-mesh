/**
 * Agent Mesh — local admin dashboard.
 *
 * A tiny Express app intended to run on a trusted machine (LAN / VPN).
 * Holds the relay's admin key and proxies enriched views of the relay
 * to a static frontend in ./public. Browsers never see the admin key.
 */

import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "8090", 10);
const HOST = process.env.HOST || "0.0.0.0";
const RELAY_URL = (process.env.RELAY_URL || "https://agent-mesh-relay.fly.dev").replace(/\/$/, "");
const ADMIN_KEY = process.env.MESH_ADMIN_KEY || process.env.ADMIN_KEY || "";

if (!ADMIN_KEY) {
  console.error("ERROR: MESH_ADMIN_KEY (or ADMIN_KEY) env var is required.");
  process.exit(1);
}

// ─── relay client ────────────────────────────────────────────────────

async function relay(path, opts = {}) {
  const url = RELAY_URL + path;
  const init = {
    method: opts.method || "GET",
    headers: {
      "X-Admin-Key": ADMIN_KEY,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  let status = 500;
  let body = {};
  try {
    const r = await fetch(url, init);
    status = r.status;
    const text = await r.text();
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text || "Invalid response" }; }
  } catch (err) {
    body = { error: `relay fetch failed: ${err.message}` };
  }
  return { status, body };
}

// ─── app setup ───────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Small request log, useful when debugging
app.use((req, _res, next) => {
  if (req.path.startsWith("/api/")) {
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  }
  next();
});

// ─── helpers ─────────────────────────────────────────────────────────

function sessionTime(s) {
  // Best timestamp we have for sorting "most recent activity".
  // The relay doesn't expose a `last_message_at`, so fall back to created_at.
  return s.last_activity || s.created_at || "";
}

async function fetchAllSessions() {
  const r = await relay("/sessions");
  return r.body.sessions || [];
}

// ─── API routes ──────────────────────────────────────────────────────

app.get("/api/status", async (_req, res) => {
  const r = await relay("/");
  res.status(r.status).json(r.body);
});

app.get("/api/overview", async (_req, res) => {
  const [agentsRes, sessions] = await Promise.all([
    relay("/agents"),
    fetchAllSessions(),
  ]);
  const agents = agentsRes.body.agents || [];

  const counts = { total: sessions.length, pending: 0, active: 0, completed: 0, rejected: 0 };
  for (const s of sessions) {
    if (counts[s.status] !== undefined) counts[s.status]++;
  }

  const recent = [...sessions]
    .sort((a, b) => sessionTime(b).localeCompare(sessionTime(a)))
    .slice(0, 10);

  res.json({
    agent_count: agents.length,
    session_counts: counts,
    recent_sessions: recent,
  });
});

app.get("/api/agents", async (_req, res) => {
  const [agentsRes, sessions] = await Promise.all([
    relay("/agents"),
    fetchAllSessions(),
  ]);
  const agents = agentsRes.body.agents || [];

  const augmented = agents.map(a => {
    const theirs = sessions.filter(s => s.from === a.name || s.to === a.name);
    const last = theirs.reduce((acc, s) => {
      const t = sessionTime(s);
      return t > acc ? t : acc;
    }, "");
    return {
      ...a,
      session_count: theirs.length,
      active_count: theirs.filter(s => s.status === "active").length,
      pending_count: theirs.filter(s => s.status === "pending").length,
      last_activity: last,
    };
  });

  augmented.sort((a, b) => (b.last_activity || "").localeCompare(a.last_activity || ""));
  res.json({ agents: augmented });
});

app.get("/api/agents/:name", async (req, res) => {
  const [agentsRes, sessions] = await Promise.all([
    relay("/agents"),
    fetchAllSessions(),
  ]);
  const agent = (agentsRes.body.agents || []).find(a => a.name === req.params.name);
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  const theirs = sessions
    .filter(s => s.from === agent.name || s.to === agent.name)
    .sort((a, b) => sessionTime(b).localeCompare(sessionTime(a)));

  res.json({ agent, sessions: theirs });
});

app.delete("/api/agents/:name", async (req, res) => {
  const r = await relay(`/agents/${encodeURIComponent(req.params.name)}`, { method: "DELETE" });
  res.status(r.status).json(r.body);
});

app.get("/api/sessions", async (req, res) => {
  let sessions = await fetchAllSessions();

  const { status, agent, q } = req.query;
  if (status) sessions = sessions.filter(s => s.status === status);
  if (agent) sessions = sessions.filter(s => s.from === agent || s.to === agent);
  if (q) {
    const lc = String(q).toLowerCase();
    sessions = sessions.filter(s =>
      (s.topic || "").toLowerCase().includes(lc) ||
      (s.id || "").toLowerCase().includes(lc) ||
      (s.from || "").toLowerCase().includes(lc) ||
      (s.to || "").toLowerCase().includes(lc)
    );
  }

  sessions.sort((a, b) => sessionTime(b).localeCompare(sessionTime(a)));
  res.json({ sessions });
});

app.get("/api/sessions/:id", async (req, res) => {
  const r = await relay(`/sessions/${encodeURIComponent(req.params.id)}/transcript`);
  res.status(r.status).json(r.body);
});

app.delete("/api/sessions/:id", async (req, res) => {
  const r = await relay(`/sessions/${encodeURIComponent(req.params.id)}`, { method: "DELETE" });
  res.status(r.status).json(r.body);
});

app.get("/api/invites", async (_req, res) => {
  const r = await relay("/invites");
  res.status(r.status).json(r.body);
});

app.post("/api/invites", async (req, res) => {
  const count = Math.max(1, Math.min(parseInt(req.body.count || "1", 10), 20));
  const r = await relay("/invites", { method: "POST", body: { count } });
  res.status(r.status).json(r.body);
});

// ─── static ──────────────────────────────────────────────────────────

app.use(express.static(join(__dirname, "public")));

// SPA fallback — anything unknown returns index.html so hash routes work
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(join(__dirname, "public", "index.html"));
});

app.listen(PORT, HOST, () => {
  console.log(`Agent Mesh admin listening on http://${HOST}:${PORT}`);
  console.log(`Proxying to relay: ${RELAY_URL}`);
});
