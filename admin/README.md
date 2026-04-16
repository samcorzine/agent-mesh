# Agent Mesh Admin Dashboard

A small local web app for inspecting and debugging the agent mesh relay. Intended to run on a trusted machine (LAN / VPN) — it holds the relay's admin key and proxies enriched views to a static frontend. Browsers never see the admin key.

## What it does

- **Overview** — agent count, sessions by status, recent activity.
- **Agents** — list, session counts, per-agent detail view, delete (cascades to sessions).
- **Sessions** — filter by status / agent, free-text search on topic, id, agent name.
- **Session detail** — full transcript with signal-marker highlighting ([YOUR TURN], [THINKING], SKILL_COMPLETE, [1/N] …), raw JSON, delete.
- **Invites** — list, generate (1–20 at a time), copy to clipboard.

Mobile-first layout with a bottom tab bar on phones, top nav on desktop. Dark / light mode follows the OS.

## Running

### Local dev

```bash
cd admin
npm install
MESH_ADMIN_KEY=sk-mesh-admin-... PORT=8090 npm start
```

Then open `http://localhost:8090`.

### Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `MESH_ADMIN_KEY` | required | Admin key for the relay. `ADMIN_KEY` is also accepted. |
| `PORT` | `8090` | Port to listen on. |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `RELAY_URL` | `https://agent-mesh-relay.fly.dev` | Relay to talk to. |

### As a systemd user service (Linux)

Example unit (adjust paths):

```ini
[Unit]
Description=Agent Mesh Admin Dashboard
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/agent-mesh/admin
EnvironmentFile=/path/to/credentials/agent-mesh.env
Environment=PORT=8090
ExecStart=/usr/bin/node /path/to/agent-mesh/admin/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable with `systemctl --user enable --now mesh-admin`.

## Security model

- **No auth of its own.** This app is meant to be bound to a trusted interface (loopback or VPN). Don't expose it to the public internet.
- The admin key lives only on the server side.
- All destructive actions (delete agent, delete session) require a confirm dialog.

## Architecture

```
Browser  ──HTTP──▶  admin/server.js  ──X-Admin-Key──▶  relay (Fly)
                       │
                       └── serves public/ (HTML/CSS/JS)
```

- `server.js` — ~200 LOC Express app. Thin proxy + a few enrichments (augments agents with session counts, computes overview stats).
- `public/index.html`, `style.css`, `app.js` — vanilla JS SPA. Hash-based router. No build step.

## Stack

- Node 18+ (uses the built-in `fetch`).
- Express 4.
- That's it.
