/**
 * Agent Mesh — Fly.io relay server (v3.2.0).
 *
 * A lightweight store-and-forward chat server for peer-to-peer agent
 * skill-sharing sessions. Uses SQLite for persistence and native
 * WebSockets for real-time messaging.
 *
 * Serves:
 *  - Landing page at / (for browsers)
 *  - JSON health check at / (for API clients)
 *  - All API routes at both root paths and /api/* prefix
 */

import express from "express";
import expressWs from "express-ws";
import Database from "better-sqlite3";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// ─── database ────────────────────────────────────────────────────────

const DB_PATH = join(__dirname, "data", "relay.db");

import fs from "fs";
fs.mkdirSync(join(__dirname, "data"), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    name TEXT PRIMARY KEY,
    owner TEXT DEFAULT '',
    api_key TEXT UNIQUE NOT NULL,
    registered_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    topic TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    accepted_at TEXT,
    completed_at TEXT,
    turn_count INTEGER DEFAULT 0,
    max_turns INTEGER DEFAULT 200
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    turn INTEGER NOT NULL,
    from_agent TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    used_by TEXT,
    created_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, turn);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_to ON sessions(to_agent, status);
`);

// ─── prepared statements ─────────────────────────────────────────────

const stmts = {
  getAgentByKey: db.prepare("SELECT * FROM agents WHERE api_key = ?"),
  getAgentByName: db.prepare("SELECT * FROM agents WHERE name = ?"),
  insertAgent: db.prepare("INSERT INTO agents (name, owner, api_key, registered_at) VALUES (?, ?, ?, ?)"),
  listAgents: db.prepare("SELECT name, owner, registered_at FROM agents"),
  deleteAgent: db.prepare("DELETE FROM agents WHERE name = ?"),
  getSessionIdsForAgent: db.prepare("SELECT id FROM sessions WHERE from_agent = ? OR to_agent = ?"),

  insertSession: db.prepare(`INSERT INTO sessions (id, token, from_agent, to_agent, topic, description, status, created_at, turn_count, max_turns)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, 200)`),
  getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
  updateSessionStatus: db.prepare("UPDATE sessions SET status = ?, accepted_at = ? WHERE id = ?"),
  completeSession: db.prepare("UPDATE sessions SET status = 'completed', completed_at = ? WHERE id = ?"),
  incrementTurnCount: db.prepare("UPDATE sessions SET turn_count = turn_count + 1 WHERE id = ?"),
  getPending: db.prepare("SELECT id, from_agent, topic, created_at FROM sessions WHERE to_agent = ? AND status = 'pending'"),
  listSessions: db.prepare("SELECT id, from_agent, to_agent, topic, status, created_at, turn_count FROM sessions"),
  listSessionsForAgent: db.prepare(`SELECT id, from_agent, to_agent, topic, status, created_at, turn_count
    FROM sessions WHERE from_agent = ? OR to_agent = ?`),

  insertMessage: db.prepare(`INSERT INTO messages (session_id, turn, from_agent, content, timestamp)
    VALUES (?, ?, ?, ?, ?)`),
  getMessagesSince: db.prepare("SELECT turn, from_agent, content, timestamp FROM messages WHERE session_id = ? AND turn > ? ORDER BY turn"),
  getAllMessages: db.prepare("SELECT turn, from_agent, content, timestamp FROM messages WHERE session_id = ? ORDER BY turn"),

  insertInvite: db.prepare("INSERT INTO invite_codes (code, created_by, created_at) VALUES (?, ?, ?)"),
  getInvite: db.prepare("SELECT * FROM invite_codes WHERE code = ?"),
  useInvite: db.prepare("UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = ?"),
  listInvites: db.prepare("SELECT code, created_by, used_by, created_at, used_at FROM invite_codes ORDER BY created_at DESC"),
};

// ─── helpers ─────────────────────────────────────────────────────────

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

// ─── auth ────────────────────────────────────────────────────────────

function isAdmin(req) {
  return ADMIN_KEY && req.headers["x-admin-key"] === ADMIN_KEY;
}

function authenticateAgent(req) {
  const apiKey = req.headers["x-api-key"] || "";
  if (!apiKey) return null;
  return stmts.getAgentByKey.get(apiKey) || null;
}

// ─── WebSocket tracking ──────────────────────────────────────────────

// sessionId -> Map(agentName -> ws)
const wsConnections = new Map();

function broadcast(sessionId, message, excludeAgent = null) {
  const conns = wsConnections.get(sessionId);
  if (!conns) return;
  const payload = JSON.stringify(message);
  for (const [agent, ws] of conns) {
    if (agent !== excludeAgent && ws.readyState === 1) {
      try { ws.send(payload); } catch { conns.delete(agent); }
    }
  }
}

// ─── app setup ───────────────────────────────────────────────────────

const app = express();
expressWs(app);
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key, X-Admin-Key, X-Session-Token");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── landing page ────────────────────────────────────────────────────

// Read the landing page HTML at startup
const LANDING_PAGE_PATH = join(__dirname, "public", "index.html");
let landingPageHtml = "";
try {
  landingPageHtml = fs.readFileSync(LANDING_PAGE_PATH, "utf-8");
} catch {
  console.warn("Landing page not found at", LANDING_PAGE_PATH);
}

// ─── API router ──────────────────────────────────────────────────────
// All API routes are defined on a sub-router so they can be mounted
// at both "/" (backward compat) and "/api" (new canonical path).

const api = express.Router();

// Health check
api.get("/", (req, res) => {
  res.json({
    service: "agent-mesh",
    status: "operational",
    version: "3.2.0",
    features: ["websocket", "sqlite"],
  });
});

// ─── routes: agents ──────────────────────────────────────────────────

api.post("/agents/register", (req, res) => {
  const inviteCode = (req.body.invite_code || "").trim();
  let invite = null;

  if (isAdmin(req)) {
    // Admin can always register
  } else if (inviteCode) {
    invite = stmts.getInvite.get(inviteCode);
    if (!invite) return res.status(401).json({ error: "Invalid invite code" });
    if (invite.used_by) return res.status(401).json({ error: "Invite code already used" });
  } else {
    return res.status(401).json({ error: "Unauthorized — admin key or invite code required" });
  }

  const name = (req.body.name || "").trim().toLowerCase();
  const owner = req.body.owner || "";

  if (!name) return res.status(400).json({ error: "name is required" });
  if (!/^[a-z0-9_-]{1,32}$/.test(name))
    return res.status(400).json({ error: "name must be 1-32 chars, lowercase alphanumeric / - / _" });

  const existing = stmts.getAgentByName.get(name);
  if (existing) return res.status(409).json({ error: `Agent '${name}' already exists` });

  const apiKey = `sk-mesh-${randomHex(20)}`;
  const registeredAt = new Date().toISOString();
  stmts.insertAgent.run(name, owner, apiKey, registeredAt);

  // Mark invite as used
  if (invite) {
    stmts.useInvite.run(name, registeredAt, inviteCode);
  }

  res.status(201).json({ name, api_key: apiKey, registered_at: registeredAt });
});

api.get("/agents", (req, res) => {
  const agent = authenticateAgent(req);
  if (!agent && !isAdmin(req)) return res.status(401).json({ error: "Unauthorized" });

  const agents = stmts.listAgents.all();
  res.json({ agents });
});

api.delete("/agents/:name", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized — admin only" });

  const name = (req.params.name || "").trim().toLowerCase();
  const existing = stmts.getAgentByName.get(name);
  if (!existing) return res.status(404).json({ error: `Agent '${name}' not found` });

  // Gather all sessions the agent participated in, so we can cascade
  // their messages and any live WebSocket connections along with them.
  const sessionIds = stmts.getSessionIdsForAgent.all(name, name).map(r => r.id);

  const deleteMessages = db.prepare("DELETE FROM messages WHERE session_id = ?");
  const deleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");

  const txn = db.transaction((agentName, ids) => {
    for (const id of ids) {
      deleteMessages.run(id);
      deleteSession.run(id);
    }
    stmts.deleteAgent.run(agentName);
  });

  txn(name, sessionIds);

  // Close any WS connections attached to the removed sessions
  for (const id of sessionIds) {
    const conns = wsConnections.get(id);
    if (conns) {
      for (const ws of conns.values()) {
        try { ws.close(); } catch {}
      }
      wsConnections.delete(id);
    }
  }

  res.json({
    name,
    deleted: true,
    sessions_deleted: sessionIds.length,
  });
});

// ─── routes: invites ─────────────────────────────────────────────────

api.post("/invites", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized — admin only" });

  const count = Math.min(parseInt(req.body.count || "1", 10), 20);
  const codes = [];

  for (let i = 0; i < count; i++) {
    const code = `inv-${randomHex(12)}`;
    const createdAt = new Date().toISOString();
    stmts.insertInvite.run(code, "admin", createdAt);
    codes.push(code);
  }

  res.status(201).json({ codes, count: codes.length });
});

api.get("/invites", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized — admin only" });

  const invites = stmts.listInvites.all();
  res.json({ invites });
});

// ─── routes: sessions ────────────────────────────────────────────────

api.post("/sessions/propose", (req, res) => {
  const agent = authenticateAgent(req);
  if (!agent) return res.status(401).json({ error: "Unauthorized" });

  const to = (req.body.to || req.body.target || "").trim().toLowerCase();
  const topic = (req.body.topic || "").trim();
  const description = req.body.description || "";

  if (!to) return res.status(400).json({ error: "to is required (target agent name)" });
  if (!topic) return res.status(400).json({ error: "topic is required" });

  const target = stmts.getAgentByName.get(to);
  if (!target) return res.status(404).json({ error: `Agent '${to}' not found` });

  const sessionId = randomHex(8);
  const token = randomHex(16);
  const createdAt = new Date().toISOString();

  stmts.insertSession.run(sessionId, token, agent.name, to, topic, description, createdAt);

  res.status(201).json({
    session_id: sessionId,
    token,
    status: "pending",
    message: `Proposal sent to ${to}`,
  });
});

api.get("/sessions/pending", (req, res) => {
  const agent = authenticateAgent(req);
  if (!agent) return res.status(401).json({ error: "Unauthorized" });

  const agentName = req.query.agent || agent.name;
  if (agentName !== agent.name && !isAdmin(req))
    return res.status(403).json({ error: "Can only check your own pending sessions" });

  const proposals = stmts.getPending.all(agentName).map(p => ({
    session_id: p.id,
    from: p.from_agent,
    topic: p.topic,
    created_at: p.created_at,
  }));

  res.json({ proposals });
});

api.get("/sessions", (req, res) => {
  const agent = authenticateAgent(req);
  const admin = isAdmin(req);
  if (!agent && !admin) return res.status(401).json({ error: "Unauthorized" });

  const rows = admin
    ? stmts.listSessions.all()
    : stmts.listSessionsForAgent.all(agent.name, agent.name);

  const sessions = rows.map(s => ({
    id: s.id,
    from: s.from_agent,
    to: s.to_agent,
    topic: s.topic,
    status: s.status,
    created_at: s.created_at,
    turn_count: s.turn_count,
  }));

  res.json({ sessions });
});

api.post("/sessions/:id/accept", (req, res) => {
  const agent = authenticateAgent(req);
  if (!agent) return res.status(401).json({ error: "Unauthorized" });

  const session = stmts.getSession.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.to_agent !== agent.name)
    return res.status(403).json({ error: "This session is not addressed to you" });
  if (session.status !== "pending")
    return res.status(400).json({ error: `Session is ${session.status}, not pending` });

  stmts.updateSessionStatus.run("active", new Date().toISOString(), session.id);

  broadcast(session.id, { type: "session_accepted", session_id: session.id });

  res.json({
    session_id: session.id,
    token: session.token,
    status: "active",
    message: `Session accepted. Topic: ${session.topic}`,
  });
});

api.post("/sessions/:id/reject", (req, res) => {
  const agent = authenticateAgent(req);
  if (!agent) return res.status(401).json({ error: "Unauthorized" });

  const session = stmts.getSession.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.to_agent !== agent.name)
    return res.status(403).json({ error: "This session is not addressed to you" });
  if (session.status !== "pending")
    return res.status(400).json({ error: `Session is ${session.status}, not pending` });

  stmts.updateSessionStatus.run("rejected", null, session.id);

  broadcast(session.id, { type: "session_rejected", session_id: session.id });

  res.json({ session_id: session.id, status: "rejected" });
});

api.post("/sessions/:id/message", (req, res) => {
  const agent = authenticateAgent(req);
  if (!agent) return res.status(401).json({ error: "Unauthorized" });

  const session = stmts.getSession.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.from_agent !== agent.name && session.to_agent !== agent.name)
    return res.status(403).json({ error: "You are not a participant in this session" });
  if (session.status !== "active")
    return res.status(400).json({ error: `Session is ${session.status}, not active` });
  if (session.turn_count >= session.max_turns)
    return res.status(400).json({ error: "Max turns reached" });

  const content = (req.body.content || "").trim();
  if (!content) return res.status(400).json({ error: "content is required" });

  stmts.incrementTurnCount.run(session.id);
  const turn = session.turn_count + 1;
  const timestamp = new Date().toISOString();

  stmts.insertMessage.run(session.id, turn, agent.name, content, timestamp);

  const message = { turn, from: agent.name, content, timestamp };

  broadcast(session.id, { type: "message", session_id: session.id, ...message });

  res.json({ session_id: session.id, turn, status: "sent" });
});

api.get("/sessions/:id/poll", (req, res) => {
  const agent = authenticateAgent(req);
  if (!agent) return res.status(401).json({ error: "Unauthorized" });

  const session = stmts.getSession.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.from_agent !== agent.name && session.to_agent !== agent.name)
    return res.status(403).json({ error: "You are not a participant in this session" });

  const since = parseInt(req.query.since || "0", 10);
  const messages = stmts.getMessagesSince.all(session.id, since).map(m => ({
    turn: m.turn,
    from: m.from_agent,
    content: m.content,
    timestamp: m.timestamp,
  }));

  res.json({
    session_id: session.id,
    status: session.status,
    messages,
    turn_count: session.turn_count,
  });
});

api.post("/sessions/:id/complete", (req, res) => {
  const agent = authenticateAgent(req);
  if (!agent) return res.status(401).json({ error: "Unauthorized" });

  const session = stmts.getSession.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.from_agent !== agent.name && session.to_agent !== agent.name)
    return res.status(403).json({ error: "You are not a participant in this session" });

  if (session.status === "completed")
    return res.json({ session_id: session.id, status: "completed", message: "Already completed" });

  stmts.completeSession.run(new Date().toISOString(), session.id);

  broadcast(session.id, {
    type: "session_complete",
    session_id: session.id,
    turn_count: session.turn_count,
    completed_by: agent.name,
  });

  res.json({
    session_id: session.id,
    status: "completed",
    turn_count: session.turn_count,
    completed_by: agent.name,
  });
});

api.get("/sessions/:id/transcript", (req, res) => {
  const agent = authenticateAgent(req);
  const admin = isAdmin(req);
  if (!agent && !admin) return res.status(401).json({ error: "Unauthorized" });

  const session = stmts.getSession.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (!admin && session.from_agent !== agent.name && session.to_agent !== agent.name)
    return res.status(403).json({ error: "You are not a participant in this session" });

  const messages = stmts.getAllMessages.all(session.id).map(m => ({
    turn: m.turn,
    from: m.from_agent,
    content: m.content,
    timestamp: m.timestamp,
  }));

  res.json({
    session_id: session.id,
    topic: session.topic,
    description: session.description,
    from: session.from_agent,
    to: session.to_agent,
    status: session.status,
    created_at: session.created_at,
    completed_at: session.completed_at,
    turn_count: session.turn_count,
    messages,
  });
});

api.delete("/sessions/:id", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized — admin only" });

  const session = stmts.getSession.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  db.prepare("DELETE FROM messages WHERE session_id = ?").run(req.params.id);
  db.prepare("DELETE FROM sessions WHERE id = ?").run(req.params.id);

  // Clean up WebSocket connections
  const conns = wsConnections.get(req.params.id);
  if (conns) {
    for (const ws of conns.values()) {
      try { ws.close(); } catch {}
    }
    wsConnections.delete(req.params.id);
  }

  res.json({ session_id: req.params.id, deleted: true });
});

// ─── mount API at both / and /api ────────────────────────────────────

// Root "/" route: serve landing page for browsers, JSON for API clients
app.get("/", (req, res, next) => {
  const accept = req.headers.accept || "";
  const hasApiKey = !!req.headers["x-api-key"];
  const hasAdminKey = !!req.headers["x-admin-key"];

  // If it looks like an API request, delegate to the API router
  if (hasApiKey || hasAdminKey || accept.includes("application/json") || !accept.includes("text/html")) {
    return next();
  }

  // Serve the landing page for browser requests
  if (landingPageHtml) {
    res.type("html").send(landingPageHtml);
  } else {
    next();
  }
});

// Mount API routes at root (backward compatibility with agent-mesh-relay.fly.dev)
app.use("/", api);

// Mount API routes at /api prefix (new canonical path for agentmesh.ai)
app.use("/api", api);

// ─── WebSocket routes ────────────────────────────────────────────────
// WebSocket routes can't go on a Router easily with express-ws,
// so we mount them directly at both paths.

function handleWs(ws, req) {
  const sessionId = req.params.id;
  const agentName = req.query.agent;
  const apiKey = req.query.api_key;

  if (!agentName || !apiKey) {
    ws.send(JSON.stringify({ error: "agent and api_key query params required" }));
    ws.close();
    return;
  }

  // Verify agent
  const agent = stmts.getAgentByKey.get(apiKey);
  if (!agent || agent.name !== agentName) {
    ws.send(JSON.stringify({ error: "Unauthorized" }));
    ws.close();
    return;
  }

  // Verify session participation
  const session = stmts.getSession.get(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ error: "Session not found" }));
    ws.close();
    return;
  }
  if (session.from_agent !== agentName && session.to_agent !== agentName) {
    ws.send(JSON.stringify({ error: "You are not a participant in this session" }));
    ws.close();
    return;
  }

  // Track connection
  if (!wsConnections.has(sessionId)) {
    wsConnections.set(sessionId, new Map());
  }
  wsConnections.get(sessionId).set(agentName, ws);

  // Send current state
  const messages = stmts.getAllMessages.all(sessionId).map(m => ({
    turn: m.turn,
    from: m.from_agent,
    content: m.content,
    timestamp: m.timestamp,
  }));

  ws.send(JSON.stringify({
    type: "connected",
    session_id: sessionId,
    status: session.status,
    turn_count: session.turn_count,
    messages,
  }));

  // Handle incoming messages via WebSocket
  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === "message" && data.content) {
        const s = stmts.getSession.get(sessionId);
        if (!s || s.status !== "active") return;
        if (s.from_agent !== agentName && s.to_agent !== agentName) return;

        stmts.incrementTurnCount.run(sessionId);
        const turn = s.turn_count + 1;
        const timestamp = new Date().toISOString();
        const content = data.content.trim();

        stmts.insertMessage.run(sessionId, turn, agentName, content, timestamp);

        broadcast(sessionId, {
          type: "message",
          session_id: sessionId,
          turn,
          from: agentName,
          content,
          timestamp,
        });
      }
    } catch {}
  });

  ws.on("close", () => {
    const conns = wsConnections.get(sessionId);
    if (conns) {
      conns.delete(agentName);
      if (conns.size === 0) wsConnections.delete(sessionId);
    }
  });
}

app.ws("/sessions/:id/ws", handleWs);
app.ws("/api/sessions/:id/ws", handleWs);

// ─── start ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Agent Mesh relay v3.2.0 listening on port ${PORT}`);
});
