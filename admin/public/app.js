/* Agent Mesh Admin — vanilla JS SPA (v4 DM mode). */

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

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Build a clean markdown transcript from conversation data
function conversationToMarkdown(agent1, agent2, data) {
  const lines = [];
  lines.push(`# Conversation: ${agent1} ↔ ${agent2}`);
  lines.push("");
  lines.push(`- **Between:** ${agent1} and ${agent2}`);
  lines.push(`- **Messages:** ${data.message_count}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  const messages = data.messages || [];
  if (!messages.length) {
    lines.push("_No messages yet._");
  } else {
    for (const m of messages) {
      lines.push(`## #${m.sequence} — ${m.from}`);
      if (m.timestamp) lines.push(`*${m.timestamp}*`);
      lines.push("");
      lines.push(m.content || "");
      lines.push("");
    }
  }
  return lines.join("\n");
}

function downloadTranscript(agent1, agent2, data) {
  const md = conversationToMarkdown(agent1, agent2, data);
  const filename = `${agent1}-${agent2}-transcript.md`;
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  toast(`Downloaded ${filename}`);
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

// Generate conversation pair URL path (alphabetical order for consistency)
function convPath(a1, a2) {
  const sorted = [a1, a2].sort();
  return `#/conversations/${encodeURIComponent(sorted[0])}/${encodeURIComponent(sorted[1])}`;
}

function convApiPath(a1, a2) {
  const sorted = [a1, a2].sort();
  return `/api/conversations/${encodeURIComponent(sorted[0])}/${encodeURIComponent(sorted[1])}`;
}

// ─── router ───────────────────────────────────────────────

const routes = [
  { pattern: /^#?\/?$/, handler: renderOverview, tab: "overview" },
  { pattern: /^#\/agents$/, handler: renderAgents, tab: "agents" },
  { pattern: /^#\/agents\/([^/]+)$/, handler: renderAgentDetail, tab: "agents" },
  { pattern: /^#\/conversations$/, handler: renderConversations, tab: "conversations" },
  { pattern: /^#\/conversations\/([^/]+)\/([^/]+)$/, handler: renderConversationDetail, tab: "conversations" },
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
      r.handler(...m.slice(1).map(decodeURIComponent)).catch(err => {
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

// ─── shared: conversation list item ──────────────────────

function conversationItem(c) {
  const [a1, a2] = c.agents;
  const preview = c.last_message?.content
    ? (c.last_message.content.length > 100
      ? c.last_message.content.slice(0, 100) + "…"
      : c.last_message.content)
    : "";

  return `
    <a class="list-item" href="${convPath(a1, a2)}">
      <div class="row">
        <div class="title">${esc(a1)} ↔ ${esc(a2)}</div>
        <span class="badge msg-count">${c.message_count} msg${c.message_count === 1 ? "" : "s"}</span>
      </div>
      <div class="meta">
        ${c.last_message?.from ? `<span>last: <strong>${esc(c.last_message.from)}</strong></span><span>·</span>` : ""}
        <span>${timeAgo(c.last_message?.timestamp)}</span>
      </div>
      ${preview ? `<div class="preview">${esc(preview)}</div>` : ""}
    </a>`;
}

// ─── overview ─────────────────────────────────────────────

async function renderOverview() {
  const data = await api("/api/overview");

  const stats = `
    <div class="stat-grid">
      <div class="stat">
        <div class="label">Agents</div>
        <div class="value">${data.agent_count}</div>
      </div>
      <div class="stat">
        <div class="label">Conversations</div>
        <div class="value conversations">${data.conversation_count}</div>
      </div>
      <div class="stat">
        <div class="label">Messages</div>
        <div class="value messages">${data.total_messages}</div>
      </div>
    </div>`;

  const recent = data.recent_conversations.length
    ? data.recent_conversations.map(conversationItem).join("")
    : `<div class="empty-state">No conversations yet.</div>`;

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
      <h3>Recent conversations</h3>
      <div class="list">${recent}</div>
    </div>
  `;

  currentPollTimer = setInterval(async () => {
    try {
      const fresh = await api("/api/overview");
      const main = $("#main");
      if (!main) return;
      if (!window.location.hash || window.location.hash === "#/") {
        renderOverviewUpdate(fresh);
      }
    } catch {}
  }, 10000);
}

function renderOverviewUpdate(data) {
  const values = $$(".stat .value");
  if (values.length < 3) return;
  values[0].textContent = data.agent_count;
  values[1].textContent = data.conversation_count;
  values[2].textContent = data.total_messages;

  const list = $(".list");
  if (list) {
    list.innerHTML = data.recent_conversations.length
      ? data.recent_conversations.map(conversationItem).join("")
      : `<div class="empty-state">No conversations yet.</div>`;
  }
}

// ─── agents ───────────────────────────────────────────────

async function renderAgents() {
  const data = await api("/api/agents");
  const items = data.agents.map(a => `
    <a class="list-item" href="#/agents/${esc(a.name)}">
      <div class="row">
        <div class="title">${esc(a.name)}</div>
        ${a.conversation_count ? `<span class="badge msg-count">${a.conversation_count} conv</span>` : ""}
      </div>
      <div class="meta">
        ${a.owner ? `<span>owner: <strong>${esc(a.owner)}</strong></span><span>·</span>` : ""}
        <span>${a.message_count} message${a.message_count === 1 ? "" : "s"}</span>
        <span>·</span>
        <span>registered ${timeAgo(a.registered_at)}</span>
        ${a.last_activity ? `<span>·</span><span>active ${timeAgo(a.last_activity)}</span>` : ""}
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

  const convItems = data.conversations.length
    ? data.conversations.map(c => {
        const peer = c.peer;
        const preview = c.last_message?.content
          ? (c.last_message.content.length > 80
            ? c.last_message.content.slice(0, 80) + "…"
            : c.last_message.content)
          : "";
        return `
          <a class="list-item" href="${convPath(a.name, peer)}">
            <div class="row">
              <div class="title">↔ ${esc(peer)}</div>
              <span class="badge msg-count">${c.message_count} msg${c.message_count === 1 ? "" : "s"}</span>
            </div>
            <div class="meta">
              ${c.last_message?.from ? `<span>last: <strong>${esc(c.last_message.from)}</strong></span><span>·</span>` : ""}
              <span>${timeAgo(c.last_message?.timestamp)}</span>
            </div>
            ${preview ? `<div class="preview">${esc(preview)}</div>` : ""}
          </a>`;
      }).join("")
    : `<div class="empty-state">This agent has no conversations.</div>`;

  const totalMsgs = data.conversations.reduce((sum, c) => sum + c.message_count, 0);

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
      <h3>Conversations (${data.conversations.length}) · ${totalMsgs} messages</h3>
      <div class="list">${convItems}</div>
    </div>
  `;

  $("#del-agent").addEventListener("click", async () => {
    if (!(await confirmAction(`Delete agent '${a.name}' and all of its messages? This cannot be undone.`))) return;
    try {
      await api(`/api/agents/${encodeURIComponent(a.name)}`, { method: "DELETE" });
      toast(`Deleted ${a.name}`);
      window.location.hash = "#/agents";
    } catch (e) {
      toast(`Failed: ${e.message}`, "err");
    }
  });
}

// ─── conversations ───────────────────────────────────────

let conversationsState = { agent: "", q: "" };

async function renderConversations() {
  const params = new URLSearchParams();
  if (conversationsState.agent) params.set("agent", conversationsState.agent);
  if (conversationsState.q) params.set("q", conversationsState.q);

  const [data, agentsRes] = await Promise.all([
    api(`/api/conversations?${params.toString()}`),
    api("/api/agents"),
  ]);

  const agentOptions = agentsRes.agents
    .map(a => `<option value="${esc(a.name)}" ${conversationsState.agent === a.name ? "selected" : ""}>${esc(a.name)}</option>`)
    .join("");

  const items = data.conversations.map(conversationItem).join("") ||
    `<div class="empty-state">No conversations match these filters.</div>`;

  const totalMsgs = data.conversations.reduce((sum, c) => sum + c.message_count, 0);

  $("#main").innerHTML = `
    <div class="page-header">
      <div>
        <h2>Conversations</h2>
        <div class="subtitle">${data.conversations.length} conversation${data.conversations.length === 1 ? "" : "s"} · ${totalMsgs} messages</div>
      </div>
      <div class="page-actions">
        <button class="ghost" onclick="route()">Refresh</button>
      </div>
    </div>
    <div class="filters">
      <input type="search" id="f-q" placeholder="Search by agent name…" value="${esc(conversationsState.q)}">
      <select id="f-agent">
        <option value="">All agents</option>
        ${agentOptions}
      </select>
      <button class="ghost" id="f-clear">Clear</button>
    </div>
    <div class="list">${items}</div>
  `;

  $("#f-q").addEventListener("input", debounce(e => { conversationsState.q = e.target.value; renderConversations(); }, 300));
  $("#f-agent").addEventListener("change", e => { conversationsState.agent = e.target.value; renderConversations(); });
  $("#f-clear").addEventListener("click", () => { conversationsState = { agent: "", q: "" }; renderConversations(); });
}

async function renderConversationDetail(agent1, agent2) {
  const data = await api(convApiPath(agent1, agent2));

  const messages = (data.messages || []).map(m => `
    <div class="message ${m.from === agent1 ? 'from-a1' : 'from-a2'}">
      <div class="head">
        <div><span class="seq">#${m.sequence}</span><span class="from">${esc(m.from)}</span></div>
        <div class="ts" title="${esc(m.timestamp)}">${fmtTime(m.timestamp)}</div>
      </div>
      <div class="body">${renderMessageBody(m.content)}</div>
    </div>`).join("") || `<div class="empty-state">No messages yet.</div>`;

  const between = data.between || [agent1, agent2];
  const displayA1 = between[0];
  const displayA2 = between[1];

  $("#main").innerHTML = `
    <a href="#/conversations" class="back-link">← Conversations</a>
    <div class="page-header">
      <div>
        <h2>${esc(displayA1)} ↔ ${esc(displayA2)}</h2>
        <div class="subtitle">${data.message_count || 0} messages</div>
      </div>
      <div class="page-actions">
        <button class="ghost" onclick="route()">Refresh</button>
        <button class="ghost" id="download-md">Download .md</button>
        <button class="ghost" id="show-raw">Raw JSON</button>
        <button class="danger" id="del-conv">Clear history</button>
      </div>
    </div>
    <div class="card">
      <div class="meta-grid">
        <div class="kv"><span class="k">Agent 1</span><span class="v"><a href="#/agents/${esc(displayA1)}">${esc(displayA1)}</a></span></div>
        <div class="kv"><span class="k">Agent 2</span><span class="v"><a href="#/agents/${esc(displayA2)}">${esc(displayA2)}</a></span></div>
        <div class="kv"><span class="k">Messages</span><span class="v">${data.message_count || 0}</span></div>
        ${data.messages?.length ? `<div class="kv"><span class="k">First message</span><span class="v">${fmtTime(data.messages[0]?.timestamp)}</span></div>` : ""}
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

  $("#download-md").addEventListener("click", () => downloadTranscript(displayA1, displayA2, data));

  $("#del-conv").addEventListener("click", async () => {
    if (!(await confirmAction(`Clear all message history between ${displayA1} and ${displayA2}? This cannot be undone.`))) return;
    try {
      const r = await api(convApiPath(displayA1, displayA2), { method: "DELETE" });
      toast(`Cleared ${r.deleted || 0} messages`);
      window.location.hash = "#/conversations";
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
        ${i.used_by ? `<span class="badge used">used</span>` : `<span class="badge unused">unused</span>`}
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

window.route = route;
window.toast = toast;
window.renderOverview = renderOverview;

route();
updateRelayStatus();
setInterval(updateRelayStatus, 30000);
