#!/usr/bin/env python3
"""
Mesh Agent — a polling agent that connects to the cloud relay.

This is the agent-side daemon.  It:
  1. Polls the relay for incoming session proposals
  2. Auto-accepts proposals (or asks for human approval — configurable)
  3. Polls active sessions for new messages
  4. Processes messages through Claude CLI
  5. Sends responses back through the relay

Each agent runs this on their own machine.  No inbound ports needed —
everything is outbound HTTPS polling.

Usage:
    MESH_URL=https://agent-mesh.xxx.workers.dev \
    MESH_API_KEY=sk-mesh-xxx \
    MESH_AGENT_NAME=stevens \
    python3 mesh_agent.py

Optional env:
    MESH_POLL_INTERVAL  — seconds between polls (default: 5)
    MESH_AUTO_ACCEPT    — "true" to auto-accept proposals (default: false)
    MESH_WORKSPACE      — working directory for the agent (default: ./workspace)
    CLAUDE_CLI          — path to claude CLI (default: ~/.npm-global/bin/claude)
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Add parent dir so we can import mesh_client
sys.path.insert(0, os.path.dirname(__file__))
from mesh_client import MeshClient

# ─── Config ─────────────────────────────────────────────────────────────

POLL_INTERVAL = int(os.environ.get("MESH_POLL_INTERVAL", "5"))
AUTO_ACCEPT = os.environ.get("MESH_AUTO_ACCEPT", "false").lower() == "true"
WORKSPACE = Path(os.environ.get("MESH_WORKSPACE", os.path.join(os.path.dirname(__file__), "workspace")))
CLAUDE_CLI = os.environ.get("CLAUDE_CLI", os.path.expanduser("~/.npm-global/bin/claude"))
TRANSCRIPTS_DIR = Path(os.path.join(os.path.dirname(__file__), "transcripts"))
MAX_TURNS = 50

WORKSPACE.mkdir(parents=True, exist_ok=True)
TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)

# ─── Agent state ────────────────────────────────────────────────────────

active_sessions = {}  # session_id -> {token, topic, last_turn, messages}

SYSTEM_PROMPT = """You are an AI agent participating in a skill-sharing session with another agent.
Your working directory is {workspace}.

You have access to bash, file reading, and file editing tools. Use them to build things.

The other agent is teaching you a skill. Your job is to:
1. Listen carefully to their instructions
2. Ask clarifying questions when needed
3. Actually build the thing — write code, create files, test it
4. Report back on what you've built and whether it works
5. Be honest about what you don't understand

All your work should be done inside: {workspace}

When you've successfully implemented the skill and verified it works, include
"SKILL_COMPLETE" in your response so the session can be closed.

Keep responses concise and focused."""


def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")


def query_claude(session_context):
    """Send context to Claude CLI, get a response."""
    prompt = SYSTEM_PROMPT.format(workspace=WORKSPACE)

    cmd = [
        CLAUDE_CLI,
        "--print",
        "--dangerously-skip-permissions",
        "--system-prompt", prompt,
        "--output-format", "json",
        "--add-dir", str(WORKSPACE),
    ]

    try:
        result = subprocess.run(
            cmd,
            input=session_context,
            capture_output=True,
            text=True,
            timeout=300,
            cwd=str(WORKSPACE),
        )

        if result.returncode != 0:
            return f"[Agent error: Claude returned code {result.returncode}. {result.stderr[:300]}]"

        try:
            output = json.loads(result.stdout)
            return output.get("result", result.stdout.strip())
        except json.JSONDecodeError:
            return result.stdout.strip() if result.stdout.strip() else f"[Agent error: empty response]"

    except subprocess.TimeoutExpired:
        return "[Agent error: Claude timed out after 5 minutes]"
    except Exception as e:
        return f"[Agent error: {e}]"


def build_context(session_info, messages):
    """Build conversation context for Claude from message history."""
    lines = [
        f"SKILL SHARING SESSION: {session_info['topic']}",
        f"Description: {session_info.get('description', '')}",
        "",
        "--- Conversation so far ---",
    ]

    agent_name = session_info["agent_name"]
    for msg in messages:
        role = "YOU" if msg["from"] == agent_name else "TEACHER"
        lines.append(f"\n{role} ({msg['from']}):\n{msg['content']}")

    lines.append("\n--- End of conversation ---")
    lines.append("\nRespond to the latest message. Build what's asked, test it, report results.")
    return "\n".join(lines)


def save_local_transcript(session_id, session_info, messages):
    """Save a local copy of the transcript."""
    path = TRANSCRIPTS_DIR / f"{session_id}.json"
    with open(path, "w") as f:
        json.dump({
            "session_id": session_id,
            "topic": session_info["topic"],
            "messages": messages,
            "saved_at": datetime.now(timezone.utc).isoformat(),
        }, f, indent=2)
    return path


def run_agent():
    """Main polling loop."""
    client = MeshClient()

    if not client.base_url or not client.api_key or not client.agent_name:
        print("Error: Set MESH_URL, MESH_API_KEY, and MESH_AGENT_NAME environment variables.")
        sys.exit(1)

    log(f"Agent '{client.agent_name}' starting")
    log(f"Relay: {client.base_url}")
    log(f"Workspace: {WORKSPACE}")
    log(f"Poll interval: {POLL_INTERVAL}s")
    log(f"Auto-accept: {AUTO_ACCEPT}")
    log("")

    # Verify connectivity
    status = client.status()
    if "error" in status:
        log(f"Cannot reach relay: {status['error']}")
        sys.exit(1)
    log(f"Relay is {status.get('status', 'unknown')} (v{status.get('version', '?')})")
    log("Listening for sessions...\n")

    while True:
        try:
            # 1. Check for pending proposals
            pending = client.pending()
            if "proposals" in pending:
                for proposal in pending["proposals"]:
                    sid = proposal["session_id"]
                    topic = proposal["topic"]
                    from_agent = proposal["from"]

                    if AUTO_ACCEPT:
                        log(f"Auto-accepting session {sid} from {from_agent}: {topic}")
                        result = client.accept(sid)
                        if "token" in result:
                            active_sessions[sid] = {
                                "token": result["token"],
                                "topic": topic,
                                "from": from_agent,
                                "last_turn": 0,
                                "messages": [],
                                "agent_name": client.agent_name,
                            }
                            log(f"Session {sid} active — ready to learn!")
                        else:
                            log(f"Failed to accept session {sid}: {result}")
                    else:
                        log(f"Incoming proposal from {from_agent}: {topic}")
                        log(f"  Session ID: {sid}")
                        log(f"  Run: python3 mesh_client.py accept {sid}")

            # 2. Poll active sessions for new messages
            for sid, info in list(active_sessions.items()):
                result = client.poll(sid, since=info["last_turn"])

                if "error" in result:
                    log(f"Poll error for {sid}: {result['error']}")
                    continue

                if result.get("status") == "completed":
                    log(f"Session {sid} was completed by the other side.")
                    save_local_transcript(sid, info, info["messages"])
                    del active_sessions[sid]
                    continue

                new_messages = result.get("messages", [])
                if not new_messages:
                    continue

                # Filter to only messages from the OTHER agent (not our own)
                incoming = [m for m in new_messages if m["from"] != client.agent_name]
                if not incoming:
                    # Our own message echoed back — just update turn counter
                    info["last_turn"] = max(m["turn"] for m in new_messages)
                    continue

                # Process each new incoming message
                for msg in incoming:
                    log(f"[{sid}] Message from {msg['from']} (turn {msg['turn']}): {msg['content'][:80]}...")

                    # Add to local message history
                    info["messages"].append(msg)
                    info["last_turn"] = msg["turn"]

                    # Build context and query Claude
                    log(f"[{sid}] Thinking...")
                    context = build_context(info, info["messages"])
                    response = query_claude(context)
                    log(f"[{sid}] Response: {response[:80]}...")

                    # Send response back
                    send_result = client.send(sid, response)
                    if "error" in send_result:
                        log(f"[{sid}] Failed to send response: {send_result['error']}")
                    else:
                        info["last_turn"] = send_result.get("turn", info["last_turn"])
                        info["messages"].append({
                            "turn": info["last_turn"],
                            "from": client.agent_name,
                            "content": response,
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        })

                    # Check if skill is complete
                    if "SKILL_COMPLETE" in response:
                        log(f"[{sid}] Skill complete! Closing session.")
                        client.complete(sid)
                        save_local_transcript(sid, info, info["messages"])
                        del active_sessions[sid]
                        break

        except KeyboardInterrupt:
            log("Shutting down.")
            break
        except Exception as e:
            log(f"Error in poll loop: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    run_agent()
