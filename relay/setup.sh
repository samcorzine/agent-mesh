#!/bin/bash
#
# Agent Mesh — Cloudflare Worker setup script.
#
# Handles:
#   1. Creating KV namespaces
#   2. Generating an admin key
#   3. Updating wrangler.toml with real IDs
#   4. Deploying the worker
#
# Prerequisites:
#   - wrangler CLI installed and authenticated (run `wrangler login` first)
#   - Node.js 20+
#
# Usage: ./setup.sh

set -euo pipefail
cd "$(dirname "$0")"

echo "=== Agent Mesh Setup ==="
echo ""

# Generate admin key
ADMIN_KEY="sk-mesh-admin-$(openssl rand -hex 20)"
echo "Generated admin key: $ADMIN_KEY"
echo ""

# Create KV namespaces
echo "Creating KV namespaces..."

AGENTS_OUTPUT=$(wrangler kv namespace create AGENTS 2>&1)
AGENTS_ID=$(echo "$AGENTS_OUTPUT" | grep -oP 'id = "\K[^"]+')
echo "  AGENTS namespace: $AGENTS_ID"

SESSIONS_OUTPUT=$(wrangler kv namespace create SESSIONS 2>&1)
SESSIONS_ID=$(echo "$SESSIONS_OUTPUT" | grep -oP 'id = "\K[^"]+')
echo "  SESSIONS namespace: $SESSIONS_ID"

MESSAGES_OUTPUT=$(wrangler kv namespace create MESSAGES 2>&1)
MESSAGES_ID=$(echo "$MESSAGES_OUTPUT" | grep -oP 'id = "\K[^"]+')
echo "  MESSAGES namespace: $MESSAGES_ID"

echo ""

# Update wrangler.toml with real values
cat > wrangler.toml << EOF
name = "agent-mesh"
main = "src/worker.js"
compatibility_date = "2024-12-01"

[[kv_namespaces]]
binding = "AGENTS"
id = "$AGENTS_ID"

[[kv_namespaces]]
binding = "SESSIONS"
id = "$SESSIONS_ID"

[[kv_namespaces]]
binding = "MESSAGES"
id = "$MESSAGES_ID"

[vars]
ADMIN_KEY = "$ADMIN_KEY"
EOF

echo "Updated wrangler.toml with namespace IDs and admin key."
echo ""

# Deploy
echo "Deploying worker..."
wrangler deploy

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Admin key (save this!): $ADMIN_KEY"
echo ""
echo "Your relay is live. Next steps:"
echo "  1. Register an agent:  curl -X POST https://agent-mesh.<your-subdomain>.workers.dev/agents/register \\"
echo "       -H 'X-Admin-Key: $ADMIN_KEY' \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"name\": \"stevens\", \"owner\": \"Sam\"}'"
echo ""
echo "  2. Or use the CLI:  MESH_ADMIN_KEY=$ADMIN_KEY python3 mesh_client.py register stevens Sam"
echo ""
