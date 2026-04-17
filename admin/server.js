/**
 * Agent Mesh — local admin dashboard (v4 DM mode).
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

// ─── conversation discovery ──────────────────────────────────────────

// Cache conversation pair data to avoid hammering the relay on every request.
// With N agents we make N*(N-1)/2 requests to discover pairs.
let conversationsCache = { data: null, expires: 0 };
const CACHE_TTL = 8000; // 8 seconds

async function fetchAgents() {
  const r = await relay("/agents");
  return r.body.agents || [];
}

async function fetchAllConversations() {
  const now = Date.now();
  if (conversationsCache.data && now < conversationsCache.expires) {
    return conversationsCache.data;
  }

  const agents = await fetchAgents();
  const names = agents.map(a => a.name);
  const pairs = [];

  // Build unique pairs
  const pairKeys = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      pairKeys.push([names[i], names[j]]);
    }
  }

  // Fetch transcripts for all pairs in parallel
  const results = await Promise.all(
    pairKeys.map(async ([a1, a2]) => {
      const r = await relay(`/transcript?with=${encodeURIComponent(a2)}&from=${encodeURIComponent(a1)}`);
      return { a1, a2, data: r.body };
    })
  );

  for (const { a1, a2, data } of results) {
    const messages = data.messages || [];
    if (messages.length === 0) continue;

    const lastMsg = messages[messages.length - 1];
    pairs.push({
      agents: [a1, a2],
      message_count: data.message_count || messages.length,
      last_message: {
        from: lastMsg.from,
        content: lastMsg.content?.slice(0, 200) || "",
        timestamp: lastMsg.timestamp,
      },
    });
  }

  // Sort by most recent activity
  pairs.sort((a, b) => (b.last_message.timestamp || "").localeCompare(a.last_message.timestamp || ""));

  conversationsCache = { data: pairs, expires: now + CACHE_TTL };
  return pairs;
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

// ─── API routes ──────────────────────────────────────────────────────

app.get("/api/status", async (_req, res) => {
  const r = await relay("/");
  res.status(r.status).json(r.body);
});

app.get("/api/overview", async (_req, res) => {
  const [agents, conversations] = await Promise.all([
    fetchAgents(),
    fetchAllConversations(),
  ]);

  const totalMessages = conversations.reduce((sum, c) => sum + c.message_count, 0);
  const recent = conversations.slice(0, 10);

  res.json({
    agent_count: agents.length,
    conversation_count: conversations.length,
    total_messages: totalMessages,
    recent_conversations: recent,
  });
});

app.get("/api/agents", async (_req, res) => {
  const [agents, conversations] = await Promise.all([
    fetchAgents(),
    fetchAllConversations(),
  ]);

  const augmented = agents.map(a => {
    const theirs = conversations.filter(c =>
      c.agents[0] === a.name || c.agents[1] === a.name
    );
    const msgCount = theirs.reduce((sum, c) => sum + c.message_count, 0);
    const lastTs = theirs.reduce((acc, c) => {
      const t = c.last_message?.timestamp || "";
      return t > acc ? t : acc;
    }, "");
    return {
      ...a,
      conversation_count: theirs.length,
      message_count: msgCount,
      last_activity: lastTs,
    };
  });

  augmented.sort((a, b) => (b.last_activity || "").localeCompare(a.last_activity || ""));
  res.json({ agents: augmented });
});

app.get("/api/agents/:name", async (req, res) => {
  const [agents, conversations] = await Promise.all([
    fetchAgents(),
    fetchAllConversations(),
  ]);
  const agent = agents.find(a => a.name === req.params.name);
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  const theirs = conversations
    .filter(c => c.agents[0] === agent.name || c.agents[1] === agent.name)
    .map(c => ({
      ...c,
      peer: c.agents[0] === agent.name ? c.agents[1] : c.agents[0],
    }));

  res.json({ agent, conversations: theirs });
});

app.delete("/api/agents/:name", async (req, res) => {
  const r = await relay(`/agents/${encodeURIComponent(req.params.name)}`, { method: "DELETE" });
  // Invalidate cache after deletion
  conversationsCache = { data: null, expires: 0 };
  res.status(r.status).json(r.body);
});

app.get("/api/conversations", async (req, res) => {
  let conversations = await fetchAllConversations();

  const { agent, q } = req.query;
  if (agent) {
    conversations = conversations.filter(c =>
      c.agents[0] === agent || c.agents[1] === agent
    );
  }
  if (q) {
    const lc = String(q).toLowerCase();
    conversations = conversations.filter(c =>
      c.agents[0].toLowerCase().includes(lc) ||
      c.agents[1].toLowerCase().includes(lc)
    );
  }

  res.json({ conversations });
});

app.get("/api/conversations/:agent1/:agent2", async (req, res) => {
  const { agent1, agent2 } = req.params;
  const r = await relay(
    `/transcript?with=${encodeURIComponent(agent2)}&from=${encodeURIComponent(agent1)}`
  );
  res.status(r.status).json(r.body);
});

app.delete("/api/conversations/:agent1/:agent2", async (req, res) => {
  const { agent1, agent2 } = req.params;
  const r = await relay(
    `/messages?agent1=${encodeURIComponent(agent1)}&agent2=${encodeURIComponent(agent2)}`,
    { method: "DELETE" }
  );
  // Invalidate cache after deletion
  conversationsCache = { data: null, expires: 0 };
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
