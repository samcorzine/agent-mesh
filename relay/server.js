/**
 * Agent Mesh — Fly.io relay server (v4.0.0).
 *
 * DM-mode, pair-routed API. Agents send messages to each other by name.
 * No sessions, no proposals, no lifecycle ceremony.
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

  CREATE TABLE IF NOT EXISTS dm_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    sequence INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    used_by TEXT,
    created_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_messages(from_agent, to_agent);
  CREATE INDEX IF NOT EXISTS idx_dm_pair_seq ON dm_messages(from_agent, to_agent, sequence);
`);

// ─── helpers ─────────────────────────────────────────────────────────

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Canonical pair key: sorted alphabetically so (a,b) and (b,a) map
 * to the same conversation stream.
 */
function pairKey(a, b) {
  return [a, b].sort().join(":");
}

/**
 * Get the next sequence number for a pair.
 * Pair is identified by canonical ordering (both directions).
 */
function nextSequence(agent1, agent2) {
  const [a, b] = [agent1, agent2].sort();
  const row = db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) as max_seq
    FROM dm_messages
    WHERE (from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?)
  `).get(a, b, b, a);
  return row.max_seq + 1;
}

// ─── prepared statements ─────────────────────────────────────────────

const stmts = {
  getAgentByKey: db.prepare("SELECT * FROM agents WHERE api_key = ?"),
  getAgentByName: db.prepare("SELECT * FROM agents WHERE name = ?"),
  insertAgent: db.prepare("INSERT INTO agents (name, owner, api_key, registered_at) VALUES (?, ?, ?, ?)"),
  listAgents: db.prepare("SELECT name, owner, registered_at FROM agents"),
  deleteAgent: db.prepare("DELETE FROM agents WHERE name = ?"),
  deleteAgentMessages: db.prepare("DELETE FROM dm_messages WHERE from_agent = ? OR to_agent = ?"),

  insertMessage: db.prepare(`
    INSERT INTO dm_messages (from_agent, to_agent, content, timestamp, sequence)
    VALUES (?, ?, ?, ?, ?)
  `),

  // Get messages for a pair since a given sequence number
  getMessagesSince: db.prepare(`
    SELECT id, from_agent, to_agent, content, timestamp, sequence
    FROM dm_messages
    WHERE ((from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?))
      AND sequence > ?
    ORDER BY sequence
  `),

  // Get all messages for a pair
  getAllMessages: db.prepare(`
    SELECT id, from_agent, to_agent, content, timestamp, sequence
    FROM dm_messages
    WHERE (from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?)
    ORDER BY sequence
  `),

  // Delete messages for a specific pair
  deletePairMessages: db.prepare(`
    DELETE FROM dm_messages
    WHERE (from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?)
  `),

  insertInvite: db.prepare("INSERT INTO invite_codes (code, created_by, created_at) VALUES (?, ?, ?)"),
  getInvite: db.prepare("SELECT * FROM invite_codes WHERE code = ?"),
  useInvite: db.prepare("UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = ?"),
  listInvites: db.prepare("SELECT code, created_by, used_by, created_at, used_at FROM invite_codes ORDER BY created_at DESC"),
};

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

// pairKey -> Map(agentName -> ws)
const wsConnections = new Map();

function notifyPair(fromAgent, toAgent, message) {
  const key = pairKey(fromAgent, toAgent);
  const conns = wsConnections.get(key);
  if (!conns) return;
  const payload = JSON.stringify(message);
  for (const [agent, ws] of conns) {
    if (ws.readyState === 1) {
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
  res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key, X-Admin-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── landing page ────────────────────────────────────────────────────

const LANDING_PAGE_PATH = join(__dirname, "public", "index.html");
let landingPageHtml = "";
try {
  landingPageHtml = fs.readFileSync(LANDING_PAGE_PATH, "utf-8");
} catch {
  console.warn("Landing page not found at", LANDING_PAGE_PATH);
}

// ─── API router ──────────────────────────────────────────────────────

const api = express.Router();

// Health check
api.get("/", (req, res) => {
  res.json({
    service: "agent-mesh",
    status: "operational",
    version: "4.0.0",
    mode: "dm",
    features: ["websocket", "sqlite", "pair-routing"],
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

  const txn = db.transaction((agentName) => {
    stmts.deleteAgentMessages.run(agentName, agentName);
    stmts.deleteAgent.run(agentName);
  });

  txn(name);

  // Close any WS connections involving this agent
  for (const [key, conns] of wsConnections) {
    if (key.includes(name)) {
      for (const ws of conns.values()) {
        try { ws.close(); } catch {}
      }
      wsConnections.delete(key);
    }
  }

  res.json({ name, deleted: true });
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

// ─── routes: DM messaging ───────────────────────────────────────────

// POST /send — send a message to another agent
api.post("/send", (req, res) => {
  const agent = authenticateAgent(req);
  if (!agent) return res.status(401).json({ error: "Unauthorized" });

  const to = (req.body.to || "").trim().toLowerCase();
  const content = (req.body.content || "").trim();

  if (!to) return res.status(400).json({ error: "to is required (target agent name)" });
  if (!content) return res.status(400).json({ error: "content is required" });

  const target = stmts.getAgentByName.get(to);
  if (!target) return res.status(404).json({ error: `Agent '${to}' not found` });

  if (to === agent.name) return res.status(400).json({ error: "Cannot send a message to yourself" });

  const timestamp = new Date().toISOString();
  const sequence = nextSequence(agent.name, to);

  stmts.insertMessage.run(agent.name, to, content, timestamp, sequence);

  const message = {
    type: "message",
    from: agent.name,
    to,
    content,
    timestamp,
    sequence,
  };

  // Notify via WebSocket
  notifyPair(agent.name, to, message);

  res.json({
    from: agent.name,
    to,
    sequence,
    timestamp,
    status: "sent",
  });
});

// GET /messages?with=agent_name&since=N — read DM history
api.get("/messages", (req, res) => {
  const agent = authenticateAgent(req);
  const admin = isAdmin(req);
  if (!agent && !admin) return res.status(401).json({ error: "Unauthorized" });

  const withAgent = (req.query.with || "").trim().toLowerCase();
  if (!withAgent) return res.status(400).json({ error: "with query parameter is required" });

  const since = parseInt(req.query.since || "0", 10);

  // Auth scoping: agents can only read their own conversations
  const self = agent ? agent.name : null;
  if (!admin && self !== null) {
    // Agent can only read messages where they are sender or recipient
  } else if (!admin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const queryAgent = admin && !agent ? withAgent : self;
  if (!queryAgent && !admin) return res.status(400).json({ error: "Cannot determine agent identity" });

  // For admin without agent auth, we need a "from" perspective
  // Admin can specify any pair
  let agent1, agent2;
  if (admin && !agent) {
    // Admin needs to specify two agents — use "from" query param or just show the pair
    const fromAgent = (req.query.from || "").trim().toLowerCase();
    if (fromAgent) {
      agent1 = fromAgent;
      agent2 = withAgent;
    } else {
      // Default: just use alphabetical order
      [agent1, agent2] = [withAgent, withAgent]; // This doesn't make sense for admin
      return res.status(400).json({ error: "Admin must specify 'from' query param to identify the pair, or use agent auth" });
    }
  } else {
    agent1 = self;
    agent2 = withAgent;
  }

  const messages = stmts.getMessagesSince.all(agent1, agent2, agent2, agent1, since).map(m => ({
    from: m.from_agent,
    to: m.to_agent,
    content: m.content,
    timestamp: m.timestamp,
    sequence: m.sequence,
  }));

  res.json({ with: withAgent, messages, since });
});

// GET /transcript?with=agent_name — full history with an agent
api.get("/transcript", (req, res) => {
  const agent = authenticateAgent(req);
  const admin = isAdmin(req);
  if (!agent && !admin) return res.status(401).json({ error: "Unauthorized" });

  const withAgent = (req.query.with || "").trim().toLowerCase();
  if (!withAgent) return res.status(400).json({ error: "with query parameter is required" });

  let agent1, agent2;
  if (admin && !agent) {
    const fromAgent = (req.query.from || "").trim().toLowerCase();
    if (!fromAgent) return res.status(400).json({ error: "Admin must specify 'from' query param" });
    agent1 = fromAgent;
    agent2 = withAgent;
  } else {
    agent1 = agent.name;
    agent2 = withAgent;
  }

  const messages = stmts.getAllMessages.all(agent1, agent2, agent2, agent1).map(m => ({
    from: m.from_agent,
    to: m.to_agent,
    content: m.content,
    timestamp: m.timestamp,
    sequence: m.sequence,
  }));

  res.json({
    between: [agent1, agent2].sort(),
    message_count: messages.length,
    messages,
  });
});

// DELETE /messages?with=agent_name — clear history with an agent (admin only)
api.delete("/messages", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized — admin only" });

  const agent1 = (req.query.agent1 || "").trim().toLowerCase();
  const agent2 = (req.query.agent2 || req.query.with || "").trim().toLowerCase();

  if (!agent1 || !agent2) {
    return res.status(400).json({ error: "agent1 and agent2 (or with) query parameters required" });
  }

  const result = stmts.deletePairMessages.run(agent1, agent2, agent2, agent1);
  res.json({ deleted: result.changes, between: [agent1, agent2].sort() });
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

// Mount API routes at root (backward compatibility)
app.use("/", api);

// Mount API routes at /api prefix (canonical path)
app.use("/api", api);

// ─── WebSocket routes ────────────────────────────────────────────────

function handleWs(ws, req) {
  const withAgent = (req.query.with || "").trim().toLowerCase();
  const apiKey = req.query.api_key || "";

  if (!withAgent || !apiKey) {
    ws.send(JSON.stringify({ error: "with and api_key query params required" }));
    ws.close();
    return;
  }

  // Verify agent
  const agent = stmts.getAgentByKey.get(apiKey);
  if (!agent) {
    ws.send(JSON.stringify({ error: "Unauthorized" }));
    ws.close();
    return;
  }

  // Verify target exists
  const target = stmts.getAgentByName.get(withAgent);
  if (!target) {
    ws.send(JSON.stringify({ error: `Agent '${withAgent}' not found` }));
    ws.close();
    return;
  }

  const key = pairKey(agent.name, withAgent);

  // Track connection
  if (!wsConnections.has(key)) {
    wsConnections.set(key, new Map());
  }
  wsConnections.get(key).set(agent.name, ws);

  // Backfill: send full history on connect
  const messages = stmts.getAllMessages.all(agent.name, withAgent, withAgent, agent.name).map(m => ({
    from: m.from_agent,
    to: m.to_agent,
    content: m.content,
    timestamp: m.timestamp,
    sequence: m.sequence,
  }));

  ws.send(JSON.stringify({
    type: "connected",
    with: withAgent,
    you: agent.name,
    message_count: messages.length,
    messages,
  }));

  // Handle incoming messages via WebSocket
  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === "message" && data.content) {
        const content = data.content.trim();
        if (!content) return;

        const timestamp = new Date().toISOString();
        const sequence = nextSequence(agent.name, withAgent);

        stmts.insertMessage.run(agent.name, withAgent, content, timestamp, sequence);

        const message = {
          type: "message",
          from: agent.name,
          to: withAgent,
          content,
          timestamp,
          sequence,
        };

        // Notify all connected clients for this pair
        notifyPair(agent.name, withAgent, message);
      }
    } catch {}
  });

  ws.on("close", () => {
    const conns = wsConnections.get(key);
    if (conns) {
      conns.delete(agent.name);
      if (conns.size === 0) wsConnections.delete(key);
    }
  });
}

app.ws("/ws", handleWs);
app.ws("/api/ws", handleWs);

// ─── start ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Agent Mesh relay v4.0.0 (DM mode) listening on port ${PORT}`);
});
