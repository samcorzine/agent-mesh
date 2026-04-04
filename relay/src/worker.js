/**
 * Agent Mesh — Cloudflare Worker relay server.
 *
 * A lightweight store-and-forward chat server for peer-to-peer agent
 * skill-sharing sessions.  Agents register, propose sessions, exchange
 * messages by polling, and close sessions — all over plain HTTPS + JSON.
 *
 * Storage: Cloudflare KV (three namespaces: AGENTS, SESSIONS, MESSAGES).
 */

// ─── helpers ───────────────────────────────────────────────────────────

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

function randomHex(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// ─── auth ──────────────────────────────────────────────────────────────

function isAdmin(request, env) {
  const key = request.headers.get("X-Admin-Key") || "";
  return key === env.ADMIN_KEY;
}

async function authenticateAgent(request, env) {
  const apiKey = request.headers.get("X-API-Key") || "";
  if (!apiKey) return null;

  // Walk all agents to find one with a matching key.
  // KV list is cheap and we'll have <100 agents for a long time.
  const list = await env.AGENTS.list({ prefix: "agent:" });
  for (const key of list.keys) {
    const agent = JSON.parse(await env.AGENTS.get(key.name));
    if (agent && agent.api_key === apiKey) return agent;
  }
  return null;
}

function authenticateSession(request, session) {
  const token = request.headers.get("X-Session-Token") || "";
  return token === session.token;
}

// ─── routes ────────────────────────────────────────────────────────────

// POST /agents/register  (admin only)
async function handleRegister(request, env) {
  if (!isAdmin(request, env)) return err("Unauthorized", 401);
  const body = await readBody(request);
  const name = (body.name || "").trim().toLowerCase();
  const owner = body.owner || "";
  const publicKey = body.public_key || "";

  if (!name) return err("name is required");
  if (!name.match(/^[a-z0-9_-]{1,32}$/))
    return err("name must be 1-32 chars, lowercase alphanumeric / - / _");

  const existing = await env.AGENTS.get(`agent:${name}`);
  if (existing) return err(`Agent '${name}' already exists`, 409);

  const apiKey = `sk-mesh-${randomHex(20)}`;
  const agent = {
    name,
    owner,
    public_key: publicKey,
    api_key: apiKey,
    registered_at: new Date().toISOString(),
  };

  await env.AGENTS.put(`agent:${name}`, JSON.stringify(agent));
  return json({ name, api_key: apiKey, registered_at: agent.registered_at }, 201);
}

// GET /agents  (any authenticated agent or admin)
async function handleListAgents(request, env) {
  const agent = await authenticateAgent(request, env);
  if (!agent && !isAdmin(request, env)) return err("Unauthorized", 401);

  const list = await env.AGENTS.list({ prefix: "agent:" });
  const agents = [];
  for (const key of list.keys) {
    const a = JSON.parse(await env.AGENTS.get(key.name));
    agents.push({ name: a.name, owner: a.owner, registered_at: a.registered_at });
  }
  return json({ agents });
}

// POST /sessions/propose  (authenticated agent)
async function handlePropose(request, env) {
  const agent = await authenticateAgent(request, env);
  if (!agent) return err("Unauthorized", 401);

  const body = await readBody(request);
  const to = (body.to || "").trim().toLowerCase();
  const topic = (body.topic || "").trim();
  const description = body.description || "";

  if (!to) return err("to is required (target agent name)");
  if (!topic) return err("topic is required");

  // Check target exists
  const target = await env.AGENTS.get(`agent:${to}`);
  if (!target) return err(`Agent '${to}' not found`, 404);

  const sessionId = randomHex(8);
  const token = randomHex(16);
  const session = {
    id: sessionId,
    token,
    from: agent.name,
    to,
    topic,
    description,
    status: "pending", // pending → active → completed / rejected
    created_at: new Date().toISOString(),
    accepted_at: null,
    completed_at: null,
    turn_count: 0,
    max_turns: 50,
  };

  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(session));

  // Also store a pending pointer so the target can discover it quickly
  await env.SESSIONS.put(
    `pending:${to}:${sessionId}`,
    JSON.stringify({ session_id: sessionId, from: agent.name, topic, created_at: session.created_at })
  );

  return json(
    { session_id: sessionId, token, status: "pending", message: `Proposal sent to ${to}` },
    201
  );
}

// GET /sessions/pending?agent=X  (authenticated — the target agent polls this)
async function handlePending(request, env) {
  const agent = await authenticateAgent(request, env);
  if (!agent) return err("Unauthorized", 401);

  const url = new URL(request.url);
  const agentName = url.searchParams.get("agent") || agent.name;

  // Only let you see your own pending proposals (or admin)
  if (agentName !== agent.name && !isAdmin(request, env))
    return err("Can only check your own pending sessions", 403);

  const list = await env.SESSIONS.list({ prefix: `pending:${agentName}:` });
  const proposals = [];
  for (const key of list.keys) {
    const p = JSON.parse(await env.SESSIONS.get(key.name));
    proposals.push(p);
  }
  return json({ proposals });
}

// POST /sessions/:id/accept  (the target agent)
async function handleAccept(request, env) {
  const agent = await authenticateAgent(request, env);
  if (!agent) return err("Unauthorized", 401);

  const sessionId = request.params.sessionId;
  const raw = await env.SESSIONS.get(`session:${sessionId}`);
  if (!raw) return err("Session not found", 404);

  const session = JSON.parse(raw);
  if (session.to !== agent.name)
    return err("This session is not addressed to you", 403);
  if (session.status !== "pending")
    return err(`Session is ${session.status}, not pending`);

  session.status = "active";
  session.accepted_at = new Date().toISOString();
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(session));

  // Clean up pending pointer
  await env.SESSIONS.delete(`pending:${agent.name}:${sessionId}`);

  return json({
    session_id: sessionId,
    token: session.token,
    status: "active",
    message: `Session accepted. Topic: ${session.topic}`,
  });
}

// POST /sessions/:id/reject  (the target agent)
async function handleReject(request, env) {
  const agent = await authenticateAgent(request, env);
  if (!agent) return err("Unauthorized", 401);

  const sessionId = request.params.sessionId;
  const raw = await env.SESSIONS.get(`session:${sessionId}`);
  if (!raw) return err("Session not found", 404);

  const session = JSON.parse(raw);
  if (session.to !== agent.name)
    return err("This session is not addressed to you", 403);
  if (session.status !== "pending")
    return err(`Session is ${session.status}, not pending`);

  session.status = "rejected";
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(session));
  await env.SESSIONS.delete(`pending:${agent.name}:${sessionId}`);

  return json({ session_id: sessionId, status: "rejected" });
}

// POST /sessions/:id/message  (either participant)
async function handleMessage(request, env) {
  const agent = await authenticateAgent(request, env);
  if (!agent) return err("Unauthorized", 401);

  const sessionId = request.params.sessionId;
  const raw = await env.SESSIONS.get(`session:${sessionId}`);
  if (!raw) return err("Session not found", 404);

  const session = JSON.parse(raw);

  // Must be a participant
  if (session.from !== agent.name && session.to !== agent.name)
    return err("You are not a participant in this session", 403);

  if (session.status !== "active")
    return err(`Session is ${session.status}, not active`);

  if (session.turn_count >= session.max_turns)
    return err("Max turns reached");

  const body = await readBody(request);
  const content = (body.content || "").trim();
  if (!content) return err("content is required");

  session.turn_count += 1;
  const turn = session.turn_count;

  const message = {
    turn,
    from: agent.name,
    content,
    timestamp: new Date().toISOString(),
  };

  // Store message
  const msgKey = `msg:${sessionId}:${String(turn).padStart(4, "0")}`;
  await env.MESSAGES.put(msgKey, JSON.stringify(message));

  // Update session
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(session));

  return json({ session_id: sessionId, turn, status: "sent" });
}

// GET /sessions/:id/poll?since=N  (either participant)
async function handlePoll(request, env) {
  const agent = await authenticateAgent(request, env);
  if (!agent) return err("Unauthorized", 401);

  const sessionId = request.params.sessionId;
  const raw = await env.SESSIONS.get(`session:${sessionId}`);
  if (!raw) return err("Session not found", 404);

  const session = JSON.parse(raw);
  if (session.from !== agent.name && session.to !== agent.name)
    return err("You are not a participant in this session", 403);

  const url = new URL(request.url);
  const since = parseInt(url.searchParams.get("since") || "0", 10);

  // List all messages in this session after `since`
  const prefix = `msg:${sessionId}:`;
  const list = await env.MESSAGES.list({ prefix });
  const messages = [];
  for (const key of list.keys) {
    const msg = JSON.parse(await env.MESSAGES.get(key.name));
    if (msg.turn > since) {
      messages.push(msg);
    }
  }

  return json({
    session_id: sessionId,
    status: session.status,
    messages,
    turn_count: session.turn_count,
  });
}

// POST /sessions/:id/complete  (either participant)
async function handleComplete(request, env) {
  const agent = await authenticateAgent(request, env);
  if (!agent) return err("Unauthorized", 401);

  const sessionId = request.params.sessionId;
  const raw = await env.SESSIONS.get(`session:${sessionId}`);
  if (!raw) return err("Session not found", 404);

  const session = JSON.parse(raw);
  if (session.from !== agent.name && session.to !== agent.name)
    return err("You are not a participant in this session", 403);

  if (session.status === "completed")
    return json({ session_id: sessionId, status: "completed", message: "Already completed" });

  session.status = "completed";
  session.completed_at = new Date().toISOString();
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(session));

  return json({
    session_id: sessionId,
    status: "completed",
    turn_count: session.turn_count,
    completed_by: agent.name,
  });
}

// DELETE /sessions/:id  (admin only — purges session + messages from KV)
async function handleDelete(request, env) {
  if (!isAdmin(request, env)) return err("Unauthorized — admin only", 401);

  const sessionId = request.params.sessionId;
  const raw = await env.SESSIONS.get(`session:${sessionId}`);
  if (!raw) return err("Session not found", 404);

  const session = JSON.parse(raw);

  // Delete all messages
  const msgList = await env.MESSAGES.list({ prefix: `msg:${sessionId}:` });
  for (const key of msgList.keys) {
    await env.MESSAGES.delete(key.name);
  }

  // Delete any pending pointer
  await env.SESSIONS.delete(`pending:${session.to}:${sessionId}`);

  // Delete the session itself
  await env.SESSIONS.delete(`session:${sessionId}`);

  return json({
    session_id: sessionId,
    deleted: true,
    messages_deleted: msgList.keys.length,
  });
}

// GET /sessions/:id/transcript  (either participant or admin)
async function handleTranscript(request, env) {
  const agent = await authenticateAgent(request, env);
  const admin = isAdmin(request, env);
  if (!agent && !admin) return err("Unauthorized", 401);

  const sessionId = request.params.sessionId;
  const raw = await env.SESSIONS.get(`session:${sessionId}`);
  if (!raw) return err("Session not found", 404);

  const session = JSON.parse(raw);
  if (!admin && session.from !== agent.name && session.to !== agent.name)
    return err("You are not a participant in this session", 403);

  // Gather all messages
  const prefix = `msg:${sessionId}:`;
  const list = await env.MESSAGES.list({ prefix });
  const messages = [];
  for (const key of list.keys) {
    messages.push(JSON.parse(await env.MESSAGES.get(key.name)));
  }
  messages.sort((a, b) => a.turn - b.turn);

  return json({
    session_id: sessionId,
    topic: session.topic,
    description: session.description,
    from: session.from,
    to: session.to,
    status: session.status,
    created_at: session.created_at,
    completed_at: session.completed_at,
    turn_count: session.turn_count,
    messages,
  });
}

// GET /sessions  (list your sessions — admin sees all)
async function handleListSessions(request, env) {
  const agent = await authenticateAgent(request, env);
  const admin = isAdmin(request, env);
  if (!agent && !admin) return err("Unauthorized", 401);

  const list = await env.SESSIONS.list({ prefix: "session:" });
  const sessions = [];
  for (const key of list.keys) {
    const s = JSON.parse(await env.SESSIONS.get(key.name));
    if (admin || s.from === agent.name || s.to === agent.name) {
      sessions.push({
        id: s.id,
        from: s.from,
        to: s.to,
        topic: s.topic,
        status: s.status,
        created_at: s.created_at,
        turn_count: s.turn_count,
      });
    }
  }
  return json({ sessions });
}

// GET /  (health check)
function handleHealth() {
  return json({
    service: "agent-mesh",
    status: "operational",
    version: "1.0.0",
  });
}

// ─── router ────────────────────────────────────────────────────────────

function matchRoute(method, pathname) {
  // Static routes
  const staticRoutes = {
    "GET /": "health",
    "POST /agents/register": "register",
    "GET /agents": "listAgents",
    "POST /sessions/propose": "propose",
    "GET /sessions/pending": "pending",
    "GET /sessions": "listSessions",
  };

  const key = `${method} ${pathname}`;
  if (staticRoutes[key]) return { handler: staticRoutes[key], params: {} };

  // Dynamic routes: /sessions/:id/...
  const sessionMatch = pathname.match(
    /^\/sessions\/([a-f0-9]+)\/(accept|reject|message|poll|complete|transcript)$/
  );
  if (sessionMatch) {
    const [, sessionId, action] = sessionMatch;
    const methodMap = {
      "POST accept": "accept",
      "POST reject": "reject",
      "POST message": "message",
      "GET poll": "poll",
      "POST complete": "complete",
      "GET transcript": "transcript",
    };
    const handler = methodMap[`${method} ${action}`];
    if (handler) return { handler, params: { sessionId } };
  }

  // DELETE /sessions/:id  (admin only)
  const deleteMatch = pathname.match(/^\/sessions\/([a-f0-9]+)$/);
  if (deleteMatch && method === "DELETE") {
    return { handler: "delete", params: { sessionId: deleteMatch[1] } };
  }

  return null;
}

// ─── entrypoint ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-API-Key, X-Admin-Key, X-Session-Token",
        },
      });
    }

    const url = new URL(request.url);
    const route = matchRoute(request.method, url.pathname);

    if (!route) return err("Not found", 404);

    // Attach params to request for handler access
    request.params = route.params;

    const handlers = {
      health: () => handleHealth(),
      register: () => handleRegister(request, env),
      listAgents: () => handleListAgents(request, env),
      propose: () => handlePropose(request, env),
      pending: () => handlePending(request, env),
      listSessions: () => handleListSessions(request, env),
      accept: () => handleAccept(request, env),
      reject: () => handleReject(request, env),
      message: () => handleMessage(request, env),
      poll: () => handlePoll(request, env),
      complete: () => handleComplete(request, env),
      delete: () => handleDelete(request, env),
      transcript: () => handleTranscript(request, env),
    };

    try {
      return await handlers[route.handler]();
    } catch (e) {
      return err(`Internal error: ${e.message}`, 500);
    }
  },
};
