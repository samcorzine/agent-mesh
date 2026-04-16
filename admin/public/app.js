/* Agent Mesh Admin — vanilla JS SPA. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ─── utilities ────────────────────────────────────────────

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function timeAgo(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (isNaN(secs)) return iso;
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  if (secs < 86400 * 7) return `${Math.round(secs / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function statusBadge(status) {
  return `<span class="badge ${esc(status)}">${esc(status)}</span>`;
}

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 0.25s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 250);
  }, 2500);
}

async function confirmAction(message) {
  return new Promise(resolve => {
    // Use native confirm — simple, keyboard-safe, mobile-compatible
    resolve(window.confirm(message));
  });
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body = {};
  try { body = await r.json(); } catch {}
  if (!r.ok) {
    const err = body.error || `HTTP ${r.status}`;
    throw new Error(err);
  }
  return body;
}

// Highlight mesh protocol signals inside message bodies
function renderMessageBody(text) {
  if (!text) return "";
  const escaped = esc(text);
  return escaped.replace(
    /\[(YOUR TURN|THINKING|ERROR[^\]]*|SKILL_COMPLETE|[0-9]+\/[0-9]+)\]|SKILL_COMPLETE/g,
    (match, inner) => {
      const content = inner || match;
      let cls = "signal";
      if (/SKILL_COMPLETE/.test(content)) cls += " complete";
      else if (/ERROR/.test(content)) cls += " error";
      else if (/THINKING/.test(content)) cls += " thinking";
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

// ─── router ───────────────────────────────────────────────

const routes = [
  { pattern: /^#?\/?$/, handler: renderOverview, tab: "overview" },
  { pattern: /^#\/agents$/, handler: renderAgents, tab: "agents" },
  { pattern: /^#\/agents\/(.+)$/, handler: renderAgentDetail, tab: "agents" },
  { pattern: /^#\/sessions$/, handler: renderSessions, tab: "sessions" },
  { pattern: /^#\/sessions\/(.+)$/, handler: renderSessionDetail, tab: "sessions" },
  { pattern: /^#\/invites$/, handler: renderInvites, tab: "invites" },
];

let currentPollTimer = null;

function route() {
  if (currentPollTimer) { clearInterval(currentPollTimer); currentPollTimer = null; }

  const hash = window.location.hash || "#/";
  for (const r of routes) {
    const m = hash.match(r.pattern);
    if (m) {
      $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === r.tab));
      $("#main").innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
      r.handler(...m.slice(1)).catch(err => {
        $("#main").innerHTML = `<div class="card"><p style="color: var(--red)">Error: ${esc(err.message)}</p></div>`;
      });
      window.scrollTo(0, 0);
      return;
    }
  }
  $("#main").innerHTML = `<div class="empty-state">Page not found. <a href="#/">Go home</a></div>`;
}

window.addEventListener("hashchange", route);

// ─── relay status in topbar ───────────────────────────────

async function updateRelayStatus() {
  const el = $("#relay-status");
  try {
    const s = await api("/api/status");
    el.className = "relay-status ok";
    el.querySelector(".txt").textContent = `relay ${s.version || "online"}`;
  } catch (e) {
    el.className = "relay-status err";
    el.querySelector(".txt").textContent = "relay offline";
  }
}

// ─── overview ─────────────────────────────────────────────

async function renderOverview() {
  const data = await api("/api/overview");
  const c = data.session_counts;

  const stats = `
    <div class="stat-grid">
      <div class="stat">
        <div class="label">Agents</div>
        <div class="value">${c.total === undefined ? "—" : data.agent_count}</div>
      </div>
      <div class="stat">
        <div class="label">Active</div>
        <div class="value active">${c.active}</div>
      </div>
      <div class="stat">
        <div class="label">Pending</div>
        <div class="value pending">${c.pending}</div>
      </div>
      <div class="stat">
        <div class="label">Sessions</div>
        <div class="value">${c.total}</div>
      </div>
    </div>`;

  const recent = data.recent_sessions.length
    ? data.recent_sessions.map(sessionItem).join("")
    : `<div class="empty-state">No sessions yet.</div>`;

  $("#main").innerHTML = `
    <div class="page-header">
      <div>
        <h2>Overview</h2>
        <div class="subtitle">Auto-refreshes every 10 seconds.</div>
      </div>
      <div class="page-actions">
        <button class="ghost" onclick="renderOverview()">Refresh</button>
      </div>
    </div>
    ${stats}
    <div class="card">
      <h3>Recent sessions</h3>
      <div class="list">${recent}</div>
    </div>
  `;

  currentPollTimer = setInterval(async () => {
    try {
      const fresh = await api("/api/overview");
      const main = $("#main");
      if (!main) return;
      // Only do a cheap re-render if still on this page
      if (!window.location.hash || window.location.hash === "#/") {
        renderOverviewUpdate(fresh);
      }
    } catch {}
  }, 10000);
}

function renderOverviewUpdate(data) {
  const values = $$(".stat .value");
  if (values.length < 4) return;
  const c = data.session_counts;
  values[0].textContent = data.agent_count;
  values[1].textContent = c.active;
  values[2].textContent = c.pending;
  values[3].textContent = c.total;

  const list = $(".list");
  if (list) {
    list.innerHTML = data.recent_sessions.length
      ? data.recent_sessions.map(sessionItem).join("")
      : `<div class="empty-state">No sessions yet.</div>`;
  }
}

function sessionItem(s) {
  return `
    <a class="list-item" href="#/sessions/${esc(s.id)}">
      <div class="row">
        <div class="title">${esc(s.topic || "(no topic)")}</div>
        ${statusBadge(s.status)}
      </div>
      <div class="meta">
        <span>${esc(s.from)} → ${esc(s.to)}</span>
        <span>·</span>
        <span>${s.turn_count} turn${s.turn_count === 1 ? "" : "s"}</span>
        <span>·</span>
        <span>${timeAgo(s.last_activity || s.created_at)}</span>
        <span class="mono-id" style="margin-left:auto">${esc(s.id)}</span>
      </div>
    </a>`;
}

// ─── agents ───────────────────────────────────────────────

async function renderAgents() {
  const data = await api("/api/agents");
  const items = data.agents.map(a => `
    <a class="list-item" href="#/agents/${esc(a.name)}">
      <div class="row">
        <div class="title">${esc(a.name)}</div>
        ${a.active_count ? `<span class="badge active">${a.active_count} active</span>` : ""}
      </div>
      <div class="meta">
        ${a.owner ? `<span>owner: <strong>${esc(a.owner)}</strong></span><span>·</span>` : ""}
        <span>${a.session_count} session${a.session_count === 1 ? "" : "s"}</span>
        <span>·</span>
        <span>registered ${timeAgo(a.registered_at)}</span>
      </div>
    </a>`).join("");

  $("#main").innerHTML = `
    <div class="page-header">
      <div>
        <h2>Agents</h2>
        <div class="subtitle">${data.agents.length} registered</div>
      </div>
      <div class="page-actions">
        <button class="ghost" onclick="route()">Refresh</button>
      </div>
    </div>
    <div class="list">${items || `<div class="empty-state">No agents registered.</div>`}</div>
  `;
}

async function renderAgentDetail(name) {
  const data = await api(`/api/agents/${encodeURIComponent(name)}`);
  const a = data.agent;
  const sessions = data.sessions.map(sessionItem).join("") ||
    `<div class="empty-state">This agent has no sessions.</div>`;

  $("#main").innerHTML = `
    <a href="#/agents" class="back-link">← Agents</a>
    <div class="page-header">
      <div>
        <h2>${esc(a.name)}</h2>
        <div class="subtitle">${a.owner ? `Owned by <strong>${esc(a.owner)}</strong>` : "No owner"} · Registered ${fmtTime(a.registered_at)}</div>
      </div>
      <div class="page-actions">
        <button class="danger" id="del-agent">Delete agent</button>
      </div>
    </div>
    <div class="card">
      <h3>Sessions (${data.sessions.length})</h3>
      <div class="list">${sessions}</div>
    </div>
  `;

  $("#del-agent").addEventListener("click", async () => {
    if (!(await confirmAction(`Delete agent '${a.name}' and all of its sessions + messages? This cannot be undone.`))) return;
    try {
      const r = await api(`/api/agents/${encodeURIComponent(a.name)}`, { method: "DELETE" });
      toast(`Deleted ${a.name} (${r.sessions_deleted || 0} sessions removed)`);
      window.location.hash = "#/agents";
    } catch (e) {
      toast(`Failed: ${e.message}`, "err");
    }
  });
}

// ─── sessions ─────────────────────────────────────────────

let sessionsState = { status: "", agent: "", q: "" };

async function renderSessions() {
  // Preserve filter state across renders
  const params = new URLSearchParams();
  if (sessionsState.status) params.set("status", sessionsState.status);
  if (sessionsState.agent) params.set("agent", sessionsState.agent);
  if (sessionsState.q) params.set("q", sessionsState.q);

  const [data, agentsRes] = await Promise.all([
    api(`/api/sessions?${params.toString()}`),
    api("/api/agents"),
  ]);

  const agentOptions = agentsRes.agents
    .map(a => `<option value="${esc(a.name)}" ${sessionsState.agent === a.name ? "selected" : ""}>${esc(a.name)}</option>`)
    .join("");

  const items = data.sessions.map(sessionItem).join("") ||
    `<div class="empty-state">No sessions match these filters.</div>`;

  $("#main").innerHTML = `
    <div class="page-header">
      <div>
        <h2>Sessions</h2>
        <div class="subtitle">${data.sessions.length} session${data.sessions.length === 1 ? "" : "s"}</div>
      </div>
      <div class="page-actions">
        <button class="ghost" onclick="route()">Refresh</button>
      </div>
    </div>
    <div class="filters">
      <input type="search" id="f-q" placeholder="Search topic, id, agent…" value="${esc(sessionsState.q)}">
      <select id="f-status">
        <option value="">All statuses</option>
        <option value="pending" ${sessionsState.status === "pending" ? "selected" : ""}>Pending</option>
        <option value="active" ${sessionsState.status === "active" ? "selected" : ""}>Active</option>
        <option value="completed" ${sessionsState.status === "completed" ? "selected" : ""}>Completed</option>
        <option value="rejected" ${sessionsState.status === "rejected" ? "selected" : ""}>Rejected</option>
      </select>
      <select id="f-agent">
        <option value="">All agents</option>
        ${agentOptions}
      </select>
      <button class="ghost" id="f-clear">Clear</button>
    </div>
    <div class="list">${items}</div>
  `;

  $("#f-q").addEventListener("input", debounce(e => { sessionsState.q = e.target.value; renderSessions(); }, 300));
  $("#f-status").addEventListener("change", e => { sessionsState.status = e.target.value; renderSessions(); });
  $("#f-agent").addEventListener("change", e => { sessionsState.agent = e.target.value; renderSessions(); });
  $("#f-clear").addEventListener("click", () => { sessionsState = { status: "", agent: "", q: "" }; renderSessions(); });
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function renderSessionDetail(id) {
  const data = await api(`/api/sessions/${encodeURIComponent(id)}`);

  const messages = (data.messages || []).map(m => `
    <div class="message">
      <div class="head">
        <div><span class="turn">#${m.turn}</span><span class="from">${esc(m.from)}</span></div>
        <div class="ts" title="${esc(m.timestamp)}">${fmtTime(m.timestamp)}</div>
      </div>
      <div class="body">${renderMessageBody(m.content)}</div>
    </div>`).join("") || `<div class="empty-state">No messages yet.</div>`;

  $("#main").innerHTML = `
    <a href="#/sessions" class="back-link">← Sessions</a>
    <div class="page-header">
      <div>
        <h2>${esc(data.topic || "(no topic)")}</h2>
        <div class="subtitle">
          <span class="mono-id">${esc(data.session_id)}</span> · ${statusBadge(data.status)}
        </div>
      </div>
      <div class="page-actions">
        <button class="ghost" onclick="route()">Refresh</button>
        <button class="ghost" id="show-raw">Raw JSON</button>
        <button class="danger" id="del-session">Delete</button>
      </div>
    </div>
    <div class="card">
      <div class="meta-grid">
        <div class="kv"><span class="k">From</span><span class="v">${esc(data.from)}</span></div>
        <div class="kv"><span class="k">To</span><span class="v">${esc(data.to)}</span></div>
        <div class="kv"><span class="k">Turns</span><span class="v">${data.turn_count}</span></div>
        <div class="kv"><span class="k">Created</span><span class="v">${fmtTime(data.created_at)}</span></div>
        ${data.completed_at ? `<div class="kv"><span class="k">Completed</span><span class="v">${fmtTime(data.completed_at)}</span></div>` : ""}
        ${data.description ? `<div class="kv" style="grid-column: 1 / -1"><span class="k">Description</span><span class="v">${esc(data.description)}</span></div>` : ""}
      </div>
    </div>
    <div class="card" style="margin-top: 12px">
      <h3>Transcript</h3>
      <div class="transcript">${messages}</div>
    </div>
    <div class="card" id="raw-card" style="margin-top: 12px; display: none">
      <h3>Raw JSON</h3>
      <pre style="white-space: pre-wrap; font-size: 12px; color: var(--text-muted)">${esc(JSON.stringify(data, null, 2))}</pre>
    </div>
  `;

  $("#show-raw").addEventListener("click", () => {
    const card = $("#raw-card");
    card.style.display = card.style.display === "none" ? "block" : "none";
  });

  $("#del-session").addEventListener("click", async () => {
    if (!(await confirmAction(`Delete session '${data.session_id}' and its messages?`))) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(data.session_id)}`, { method: "DELETE" });
      toast("Session deleted");
      window.location.hash = "#/sessions";
    } catch (e) {
      toast(`Failed: ${e.message}`, "err");
    }
  });
}

// ─── invites ──────────────────────────────────────────────

async function renderInvites() {
  const data = await api("/api/invites");
  const invites = data.invites || [];

  const unused = invites.filter(i => !i.used_by);
  const used = invites.filter(i => i.used_by);

  const inviteRow = i => `
    <div class="list-item" style="cursor: default">
      <div class="row">
        <code class="mono">${esc(i.code)}</code>
        ${i.used_by ? `<span class="badge completed">used</span>` : `<span class="badge active">unused</span>`}
      </div>
      <div class="meta">
        <span>created ${timeAgo(i.created_at)}</span>
        ${i.used_by ? `<span>·</span><span>used by <strong>${esc(i.used_by)}</strong> ${timeAgo(i.used_at)}</span>` : ""}
        <button class="ghost" style="margin-left:auto; min-height: 32px; padding: 4px 10px" onclick="navigator.clipboard.writeText('${esc(i.code)}'); toast('Copied')">Copy</button>
      </div>
    </div>`;

  $("#main").innerHTML = `
    <div class="page-header">
      <div>
        <h2>Invites</h2>
        <div class="subtitle">${unused.length} unused · ${used.length} used</div>
      </div>
      <div class="page-actions">
        <button class="ghost" onclick="route()">Refresh</button>
      </div>
    </div>
    <div class="card">
      <h3>Generate new</h3>
      <form id="gen-form" class="flex gap-8 wrap" style="align-items: center">
        <input type="number" id="gen-count" min="1" max="20" value="1" style="max-width: 100px">
        <button type="submit" class="primary">Generate</button>
        <span class="muted" style="font-size: 13px">Max 20 at a time.</span>
      </form>
    </div>
    <div class="card" style="margin-top: 12px">
      <h3>Unused (${unused.length})</h3>
      <div class="list">${unused.map(inviteRow).join("") || `<div class="empty-state">No unused invites.</div>`}</div>
    </div>
    <div class="card" style="margin-top: 12px">
      <h3>Used (${used.length})</h3>
      <div class="list">${used.map(inviteRow).join("") || `<div class="empty-state">No used invites.</div>`}</div>
    </div>
  `;

  $("#gen-form").addEventListener("submit", async e => {
    e.preventDefault();
    const count = parseInt($("#gen-count").value, 10) || 1;
    try {
      const r = await api("/api/invites", { method: "POST", body: { count } });
      const codes = (r.codes || []).join(", ");
      toast(`Generated ${r.count || count} invite${r.count === 1 ? "" : "s"}`);
      renderInvites();
      if (r.codes && r.codes.length === 1) {
        navigator.clipboard.writeText(r.codes[0]).catch(() => {});
      }
    } catch (err) {
      toast(`Failed: ${err.message}`, "err");
    }
  });
}

// ─── kick off ─────────────────────────────────────────────

window.route = route; // expose for inline handlers
window.toast = toast;
window.renderOverview = renderOverview;

route();
updateRelayStatus();
setInterval(updateRelayStatus, 30000);
