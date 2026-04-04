#!/usr/bin/env python3
"""
Agent Mesh Client — connects to the cloud relay for skill-sharing sessions.

Each agent runs this locally and polls the relay for incoming proposals and
messages.  All communication is store-and-forward via HTTPS + JSON.

Usage as a library:
    from mesh_client import MeshClient
    client = MeshClient("https://mesh.example.com", "sk-mesh-abc123", "stevens")
    # propose a session, send messages, poll, etc.

Usage as CLI:
    mesh_client.py status
    mesh_client.py agents
    mesh_client.py propose <target> <topic> [description]
    mesh_client.py pending
    mesh_client.py accept <session_id>
    mesh_client.py send <session_id> <message>
    mesh_client.py poll <session_id> [since_turn]
    mesh_client.py complete <session_id>
    mesh_client.py transcript <session_id>
    mesh_client.py sessions

Admin commands (require MESH_ADMIN_KEY env var):
    mesh_client.py register <name> <owner>
"""

import json
import os
import sys
import urllib.request
import urllib.error


class MeshClient:
    """Client for the agent mesh cloud relay."""

    def __init__(self, base_url=None, api_key=None, agent_name=None):
        self.base_url = (base_url or os.environ.get("MESH_URL", "")).rstrip("/")
        self.api_key = api_key or os.environ.get("MESH_API_KEY", "")
        self.agent_name = agent_name or os.environ.get("MESH_AGENT_NAME", "")
        self.admin_key = os.environ.get("MESH_ADMIN_KEY", "")

    def _request(self, method, path, body=None, admin=False):
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode() if body else None
        headers = {"Content-Type": "application/json"}

        if admin and self.admin_key:
            headers["X-Admin-Key"] = self.admin_key
        elif self.api_key:
            headers["X-API-Key"] = self.api_key

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            error_body = e.read().decode()
            try:
                return json.loads(error_body)
            except json.JSONDecodeError:
                return {"error": f"HTTP {e.code}: {error_body}"}
        except urllib.error.URLError as e:
            return {"error": f"Connection failed: {e.reason}"}

    # ─── Health ─────────────────────────────────────────────

    def status(self):
        """Check relay health."""
        return self._request("GET", "/")

    # ─── Admin ──────────────────────────────────────────────

    def register(self, name, owner, public_key=""):
        """Register a new agent (admin only)."""
        return self._request("POST", "/agents/register", {
            "name": name,
            "owner": owner,
            "public_key": public_key,
        }, admin=True)

    # ─── Agent operations ───────────────────────────────────

    def list_agents(self):
        """List all registered agents."""
        return self._request("GET", "/agents")

    def propose(self, target, topic, description=""):
        """Propose a skill-sharing session to another agent."""
        return self._request("POST", "/sessions/propose", {
            "to": target,
            "topic": topic,
            "description": description,
        })

    def pending(self):
        """Check for incoming session proposals."""
        return self._request("GET", f"/sessions/pending?agent={self.agent_name}")

    def accept(self, session_id):
        """Accept an incoming session proposal."""
        return self._request("POST", f"/sessions/{session_id}/accept")

    def reject(self, session_id):
        """Reject an incoming session proposal."""
        return self._request("POST", f"/sessions/{session_id}/reject")

    def send(self, session_id, content):
        """Send a message in an active session."""
        return self._request("POST", f"/sessions/{session_id}/message", {
            "content": content,
        })

    def poll(self, session_id, since=0):
        """Poll for new messages in a session."""
        return self._request("GET", f"/sessions/{session_id}/poll?since={since}")

    def complete(self, session_id):
        """Close a session."""
        return self._request("POST", f"/sessions/{session_id}/complete")

    def transcript(self, session_id):
        """Get the full session transcript."""
        return self._request("GET", f"/sessions/{session_id}/transcript")

    def list_sessions(self):
        """List all sessions you're involved in."""
        return self._request("GET", "/sessions")


# ─── CLI ────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage:")
        print("  mesh_client.py status")
        print("  mesh_client.py agents")
        print("  mesh_client.py propose <target> <topic> [description]")
        print("  mesh_client.py pending")
        print("  mesh_client.py accept <session_id>")
        print("  mesh_client.py send <session_id> <message>")
        print("  mesh_client.py poll <session_id> [since_turn]")
        print("  mesh_client.py complete <session_id>")
        print("  mesh_client.py transcript <session_id>")
        print("  mesh_client.py sessions")
        print("  mesh_client.py register <name> <owner>  (admin)")
        print()
        print("Environment variables:")
        print("  MESH_URL        — relay server URL")
        print("  MESH_API_KEY    — agent API key")
        print("  MESH_AGENT_NAME — this agent's name")
        print("  MESH_ADMIN_KEY  — admin key (for register)")
        sys.exit(1)

    client = MeshClient()
    cmd = sys.argv[1]

    if cmd == "status":
        print(json.dumps(client.status(), indent=2))

    elif cmd == "agents":
        result = client.list_agents()
        if "agents" in result:
            for a in result["agents"]:
                print(f"  {a['name']} (owner: {a['owner']}, registered: {a['registered_at']})")
        else:
            print(json.dumps(result, indent=2))

    elif cmd == "register":
        name = sys.argv[2] if len(sys.argv) > 2 else ""
        owner = sys.argv[3] if len(sys.argv) > 3 else ""
        if not name or not owner:
            print("Usage: mesh_client.py register <name> <owner>")
            sys.exit(1)
        result = client.register(name, owner)
        print(json.dumps(result, indent=2))

    elif cmd == "propose":
        target = sys.argv[2] if len(sys.argv) > 2 else ""
        topic = sys.argv[3] if len(sys.argv) > 3 else ""
        desc = " ".join(sys.argv[4:]) if len(sys.argv) > 4 else ""
        if not target or not topic:
            print("Usage: mesh_client.py propose <target> <topic> [description]")
            sys.exit(1)
        result = client.propose(target, topic, desc)
        print(json.dumps(result, indent=2))

    elif cmd == "pending":
        result = client.pending()
        if "proposals" in result:
            if not result["proposals"]:
                print("No pending proposals.")
            for p in result["proposals"]:
                print(f"  [{p['session_id']}] from {p['from']}: {p['topic']}")
        else:
            print(json.dumps(result, indent=2))

    elif cmd == "accept":
        sid = sys.argv[2] if len(sys.argv) > 2 else ""
        if not sid:
            print("Usage: mesh_client.py accept <session_id>")
            sys.exit(1)
        result = client.accept(sid)
        print(json.dumps(result, indent=2))

    elif cmd == "send":
        sid = sys.argv[2] if len(sys.argv) > 2 else ""
        msg = " ".join(sys.argv[3:]) if len(sys.argv) > 3 else ""
        if not sid or not msg:
            print("Usage: mesh_client.py send <session_id> <message>")
            sys.exit(1)
        result = client.send(sid, msg)
        print(json.dumps(result, indent=2))

    elif cmd == "poll":
        sid = sys.argv[2] if len(sys.argv) > 2 else ""
        since = int(sys.argv[3]) if len(sys.argv) > 3 else 0
        if not sid:
            print("Usage: mesh_client.py poll <session_id> [since_turn]")
            sys.exit(1)
        result = client.poll(sid, since)
        if "messages" in result:
            for m in result["messages"]:
                print(f"  [{m['turn']}] {m['from']}: {m['content'][:120]}...")
            print(f"  ({result['turn_count']} total turns, status: {result['status']})")
        else:
            print(json.dumps(result, indent=2))

    elif cmd == "complete":
        sid = sys.argv[2] if len(sys.argv) > 2 else ""
        if not sid:
            print("Usage: mesh_client.py complete <session_id>")
            sys.exit(1)
        result = client.complete(sid)
        print(json.dumps(result, indent=2))

    elif cmd == "transcript":
        sid = sys.argv[2] if len(sys.argv) > 2 else ""
        if not sid:
            print("Usage: mesh_client.py transcript <session_id>")
            sys.exit(1)
        result = client.transcript(sid)
        if "messages" in result:
            print(f"Session: {result['session_id']} — {result['topic']}")
            print(f"Between: {result['from']} ↔ {result['to']}")
            print(f"Status: {result['status']} | Turns: {result['turn_count']}")
            print("-" * 60)
            for m in result["messages"]:
                print(f"\n[{m['turn']}] {m['from']} ({m['timestamp']}):")
                print(m["content"])
            print("-" * 60)
        else:
            print(json.dumps(result, indent=2))

    elif cmd == "sessions":
        result = client.list_sessions()
        if "sessions" in result:
            if not result["sessions"]:
                print("No sessions.")
            for s in result["sessions"]:
                print(f"  [{s['id']}] {s['from']} → {s['to']}: {s['topic']} ({s['status']}, {s['turn_count']} turns)")
        else:
            print(json.dumps(result, indent=2))

    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
