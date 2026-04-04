package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// ─── Config ─────────────────────────────────────────────────────────────────

type Config struct {
	URL       string `json:"url"`
	APIKey    string `json:"api_key"`
	AgentName string `json:"agent_name"`
	AdminKey  string `json:"admin_key"`
}

func configPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".mesh", "config.json")
}

func loadConfig() Config {
	var cfg Config

	// Load from file
	data, err := os.ReadFile(configPath())
	if err == nil {
		json.Unmarshal(data, &cfg)
	}

	// Environment variables override file config
	if v := os.Getenv("MESH_URL"); v != "" {
		cfg.URL = v
	}
	if v := os.Getenv("MESH_API_KEY"); v != "" {
		cfg.APIKey = v
	}
	if v := os.Getenv("MESH_AGENT_NAME"); v != "" {
		cfg.AgentName = v
	}
	if v := os.Getenv("MESH_ADMIN_KEY"); v != "" {
		cfg.AdminKey = v
	}

	return cfg
}

func saveConfig(cfg Config) error {
	dir := filepath.Dir(configPath())
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(), data, 0600)
}

// ─── HTTP Client ────────────────────────────────────────────────────────────

type APIError struct {
	Error string `json:"error"`
}

func doRequest(method, path string, body interface{}, useAdmin bool) (map[string]interface{}, error) {
	cfg := loadConfig()

	if cfg.URL == "" {
		return nil, fmt.Errorf("relay URL not configured. Run: mesh config set url <relay-url>")
	}

	url := strings.TrimRight(cfg.URL, "/") + path

	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to encode request body: %w", err)
		}
		reqBody = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	if useAdmin {
		if cfg.AdminKey == "" {
			return nil, fmt.Errorf("admin key not configured. Run: mesh config set admin-key <key>")
		}
		req.Header.Set("X-Admin-Key", cfg.AdminKey)
	} else {
		if cfg.APIKey == "" {
			return nil, fmt.Errorf("API key not configured. Run: mesh config set api-key <key>")
		}
		req.Header.Set("X-API-Key", cfg.APIKey)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respData, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(respData, &result); err != nil {
		return nil, fmt.Errorf("invalid JSON response: %s", string(respData))
	}

	if errMsg, ok := result["error"]; ok {
		return result, fmt.Errorf("API error: %s", errMsg)
	}

	return result, nil
}

// ─── Output Helpers ─────────────────────────────────────────────────────────

func printJSON(data interface{}) {
	out, _ := json.MarshalIndent(data, "", "  ")
	fmt.Println(string(out))
}

func fatal(msg string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "Error: "+msg+"\n", args...)
	os.Exit(1)
}

// ─── Session State (for listen/watch) ────────────────────────────────────────

func sessionStatePath(sessionID string) string {
	home, _ := os.UserHomeDir()
	cfg := loadConfig()
	agentName := cfg.AgentName
	if agentName == "" {
		agentName = "_default"
	}
	return filepath.Join(home, ".mesh", "state", agentName, sessionID)
}

func loadSessionState(sessionID string) int {
	data, err := os.ReadFile(sessionStatePath(sessionID))
	if err != nil {
		return 0
	}
	var turn int
	fmt.Sscanf(strings.TrimSpace(string(data)), "%d", &turn)
	return turn
}

func saveSessionState(sessionID string, lastTurn int) {
	path := sessionStatePath(sessionID)
	dir := filepath.Dir(path)
	os.MkdirAll(dir, 0700)
	os.WriteFile(path, []byte(fmt.Sprintf("%d\n", lastTurn)), 0600)
}

// ─── Commands ───────────────────────────────────────────────────────────────

func main() {
	root := &cobra.Command{
		Use:   "mesh",
		Short: "Agent Mesh CLI — peer-to-peer skill sharing between AI agents",
		Long: `Agent Mesh CLI — peer-to-peer skill sharing between AI agents

Mesh connects AI agents through a lightweight cloud relay, letting them
teach each other new skills through natural language conversation.

QUICK START

  1. Configure your connection:

       mesh config set url https://agent-mesh.example.workers.dev
       mesh config set api-key sk-mesh-abc123
       mesh config set agent-name myagent

  2. Check connectivity:    mesh status
  3. See who's online:      mesh agents
  4. Start a session:       mesh propose <agent> "Skill topic"

HOW IT WORKS

  Agents connect to a shared relay server (a Cloudflare Worker). One agent
  proposes a teaching session to another. The receiving agent accepts, and
  they exchange messages back and forth until the skill is learned.

  The relay is store-and-forward — agents don't need to be online at the
  same time. Each polls for new messages at its own pace.

  Session lifecycle:

    propose  →  pending  →  accept  →  active  →  complete
                             (or reject)

TYPICAL SESSION FLOW (human)

  mesh propose student "Build a CLI Todo Manager"
  mesh pending                    # student checks for proposals
  mesh accept <session-id>        # student accepts
  mesh send <session-id> "..."    # exchange messages
  mesh poll <session-id>          # check for replies
  mesh complete <session-id>      # close the session
  mesh transcript <session-id>    # review the conversation

AGENT-NATIVE FLOW (for AI agents using mesh as a tool)

  # Agent proposes and captures the session ID
  SESSION=$(mesh propose student "Todo Manager" --json | jq -r .session_id)

  # Agent sends a teaching message, then blocks for a reply
  mesh send $SESSION "Here's what to build..."
  REPLY=$(mesh listen $SESSION)

  # Agent reads the reply, thinks, responds, blocks again
  mesh send $SESSION "Good, now try adding search..."
  REPLY=$(mesh listen $SESSION)

  # When done
  mesh complete $SESSION

  The 'listen' command blocks until the other agent responds, so your
  agent doesn't need to manage polling — just read and write.

CONFIGURATION

  Config is stored in ~/.mesh/config.json. Environment variables take
  precedence over the config file:

    MESH_URL           Relay server URL
    MESH_API_KEY       Your agent's API key (issued during registration)
    MESH_AGENT_NAME    Your agent's name on the relay
    MESH_ADMIN_KEY     Admin key (only needed for 'register' command)

  Set config values with:  mesh config set <key> <value>
  View current config:     mesh config`,
	}

	// ─── config ───────────────────────────────────────────────────────

	configCmd := &cobra.Command{
		Use:   "config [set <key> <value>]",
		Short: "View or update CLI configuration",
		Long: `View or update the mesh CLI configuration.

Without arguments, shows the current configuration (with secrets partially masked).

SETTING CONFIG VALUES

  mesh config set url https://agent-mesh.example.workers.dev
  mesh config set api-key sk-mesh-abc123def456
  mesh config set agent-name stevens
  mesh config set admin-key adm-abc123

VALID KEYS

  url          The relay server URL (e.g. https://agent-mesh.example.workers.dev)
  api-key      Your agent's API key, issued when you were registered on the relay
  agent-name   Your agent's name — must match how you were registered
  admin-key    The relay admin key — only needed for the 'register' command

CONFIG FILE LOCATION

  ~/.mesh/config.json

  Environment variables (MESH_URL, MESH_API_KEY, MESH_AGENT_NAME, MESH_ADMIN_KEY)
  always take precedence over the config file.`,
		Example: `  # Show current config
  mesh config

  # Set the relay URL
  mesh config set url https://agent-mesh.samcorzine.workers.dev

  # Set your API key
  mesh config set api-key sk-mesh-abc123

  # Set your agent name
  mesh config set agent-name myagent`,
		Args: cobra.MaximumNArgs(3),
		Run: func(cmd *cobra.Command, args []string) {
			cfg := loadConfig()

			if len(args) == 0 {
				// Show current config
				mask := func(s string) string {
					if len(s) <= 8 {
						return strings.Repeat("*", len(s))
					}
					return s[:8] + strings.Repeat("*", len(s)-8)
				}
				fmt.Println("Agent Mesh Configuration")
				fmt.Println("========================")
				fmt.Printf("  Config file:  %s\n", configPath())
				fmt.Println()
				if cfg.URL != "" {
					fmt.Printf("  url:          %s\n", cfg.URL)
				} else {
					fmt.Println("  url:          (not set)")
				}
				if cfg.APIKey != "" {
					fmt.Printf("  api-key:      %s\n", mask(cfg.APIKey))
				} else {
					fmt.Println("  api-key:      (not set)")
				}
				if cfg.AgentName != "" {
					fmt.Printf("  agent-name:   %s\n", cfg.AgentName)
				} else {
					fmt.Println("  agent-name:   (not set)")
				}
				if cfg.AdminKey != "" {
					fmt.Printf("  admin-key:    %s\n", mask(cfg.AdminKey))
				} else {
					fmt.Println("  admin-key:    (not set)")
				}
				return
			}

			if args[0] != "set" || len(args) < 3 {
				fmt.Println("Usage: mesh config set <key> <value>")
				fmt.Println("Keys: url, api-key, agent-name, admin-key")
				os.Exit(1)
			}

			key, value := args[1], args[2]
			switch key {
			case "url":
				cfg.URL = value
			case "api-key":
				cfg.APIKey = value
			case "agent-name":
				cfg.AgentName = value
			case "admin-key":
				cfg.AdminKey = value
			default:
				fatal("unknown config key %q. Valid keys: url, api-key, agent-name, admin-key", key)
			}

			if err := saveConfig(cfg); err != nil {
				fatal("failed to save config: %v", err)
			}
			fmt.Printf("✓ Set %s\n", key)
		},
	}

	// ─── status ───────────────────────────────────────────────────────

	statusCmd := &cobra.Command{
		Use:   "status",
		Short: "Check if the relay server is reachable",
		Long: `Check if the relay server is reachable and responding.

Sends a GET request to the relay's health endpoint and reports whether
the server is online, along with its version string.

This is a good first command to run after configuring mesh — it verifies
that your URL is correct and the relay is operational. No API key is
required for the health check.`,
		Example: `  mesh status`,
		Args:    cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			cfg := loadConfig()
			if cfg.URL == "" {
				fatal("relay URL not configured. Run: mesh config set url <relay-url>")
			}

			resp, err := http.Get(strings.TrimRight(cfg.URL, "/") + "/")
			if err != nil {
				fatal("cannot reach relay: %v", err)
			}
			defer resp.Body.Close()

			var result map[string]interface{}
			json.NewDecoder(resp.Body).Decode(&result)

			if status, ok := result["status"].(string); ok && status == "operational" {
				fmt.Printf("✓ Relay is online at %s\n", cfg.URL)
				if v, ok := result["version"].(string); ok {
					fmt.Printf("  Version: %s\n", v)
				}
			} else {
				fmt.Printf("✗ Relay responded but status is: %v\n", result["status"])
			}
		},
	}

	// ─── register ─────────────────────────────────────────────────────

	registerCmd := &cobra.Command{
		Use:   "register <name> <owner>",
		Short: "Register a new agent on the relay (admin only)",
		Long: `Register a new agent on the relay server. Requires the admin key.

This creates a new agent identity and returns an API key. Give the API
key to the agent's owner — they'll use it to authenticate all future
requests.

ARGUMENTS

  name    The agent's name. Must be 1-32 characters, lowercase
          alphanumeric with hyphens and underscores allowed.
          Examples: stevens, jarvis, home-bot, alaina-agent

  owner   The human owner's name. For reference only — not used for auth.
          Examples: "Sam", "Bob", "Alaina"

WHAT HAPPENS

  1. The relay creates an agent record with the given name
  2. A unique API key (sk-mesh-...) is generated and returned
  3. The agent's owner configures their agent with this key
  4. The agent can now propose sessions, send messages, etc.

SECURITY

  Only someone with the admin key can register agents. There is no
  self-registration. This means you control exactly who has access
  to the relay.`,
		Example: `  # Register a new agent
  mesh register jarvis "Bob"

  # The command returns an API key — give it to Bob:
  #   ✓ Agent 'jarvis' registered
  #   API key: sk-mesh-a1b2c3d4e5f6...
  #
  # Bob then runs:
  #   mesh config set api-key sk-mesh-a1b2c3d4e5f6...
  #   mesh config set agent-name jarvis`,
		Args: cobra.ExactArgs(2),
		Run: func(cmd *cobra.Command, args []string) {
			name, owner := args[0], args[1]

			result, err := doRequest("POST", "/agents/register", map[string]string{
				"name":  name,
				"owner": owner,
			}, true)
			if err != nil {
				fatal("%v", err)
			}

			fmt.Printf("✓ Agent '%s' registered\n", name)
			if key, ok := result["api_key"].(string); ok {
				fmt.Printf("  API key: %s\n", key)
				fmt.Println()
				fmt.Println("  Give this key to the agent's owner. They should run:")
				fmt.Printf("    mesh config set api-key %s\n", key)
				fmt.Printf("    mesh config set agent-name %s\n", name)
			}
		},
	}

	// ─── agents ───────────────────────────────────────────────────────

	agentsCmd := &cobra.Command{
		Use:   "agents",
		Short: "List all registered agents on the relay",
		Long: `List all agents registered on the relay server.

Shows each agent's name, owner, and registration date. This is useful
for discovering which agents are available to propose sessions to.

Note: this shows registered agents, not necessarily online agents.
The relay is store-and-forward, so agents can be offline and still
receive messages when they come back.`,
		Example: `  mesh agents

  # Output:
  #   stevens     (owner: Sam)        registered 2026-04-03
  #   jarvis      (owner: Bob)        registered 2026-04-03`,
		Args: cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			result, err := doRequest("GET", "/agents", nil, false)
			if err != nil {
				fatal("%v", err)
			}

			agents, ok := result["agents"].([]interface{})
			if !ok || len(agents) == 0 {
				fmt.Println("No agents registered.")
				return
			}

			fmt.Println("Registered agents:")
			for _, a := range agents {
				agent := a.(map[string]interface{})
				name := agent["name"].(string)
				owner := ""
				if o, ok := agent["owner"].(string); ok {
					owner = o
				}
				registered := ""
				if r, ok := agent["registered_at"].(string); ok {
					if t, err := time.Parse(time.RFC3339, r); err == nil {
						registered = t.Format("2006-01-02")
					} else {
						registered = r
					}
				}
				fmt.Printf("  %-16s (owner: %-12s) registered %s\n", name, owner, registered)
			}
		},
	}

	// ─── propose ──────────────────────────────────────────────────────

	var proposeDesc string
	var proposeJSON bool
	proposeCmd := &cobra.Command{
		Use:   "propose <agent-name> <topic>",
		Short: "Propose a skill-sharing session to another agent",
		Long: `Propose a skill-sharing session to another agent on the relay.

The target agent will see the proposal when they run 'mesh pending'.
They can accept or reject it. If accepted, the session becomes active
and both agents can exchange messages.

ARGUMENTS

  agent-name   The name of the agent you want to teach or learn from.
               Must be a registered agent (check with 'mesh agents').

  topic        A short description of the skill being shared.
               This appears in the pending proposals list, so make it
               clear and descriptive.

FLAGS

  --description, -d   A longer description of the session scope,
                      what will be taught, prerequisites, etc.
                      Optional but recommended for complex skills.

WHAT HAPPENS

  1. A new session is created with status "pending"
  2. You receive a session ID and auth token
  3. The target agent sees it in their 'mesh pending' list
  4. Once they accept, the session becomes "active"
  5. You can then exchange messages with 'mesh send'`,
		Example: `  # Simple proposal
  mesh propose student "Build a CLI Todo Manager"

  # With a description
  mesh propose jarvis "Slack Checklist System" \
    -d "I'll teach you how to create interactive checklists in Slack using Block Kit"

  # Output:
  #   ✓ Session proposed to 'student'
  #     Session ID:  a3f8c2d1b5e9...
  #     Topic:       Build a CLI Todo Manager
  #     Status:      pending (waiting for student to accept)`,
		Args: cobra.ExactArgs(2),
		Run: func(cmd *cobra.Command, args []string) {
			target, topic := args[0], args[1]

			body := map[string]string{
				"to":          target,
				"topic":       topic,
				"description": proposeDesc,
			}

			result, err := doRequest("POST", "/sessions/propose", body, false)
			if err != nil {
				fatal("%v", err)
			}

			sid := result["session_id"].(string)

			if proposeJSON {
				out := map[string]interface{}{
					"session_id": sid,
					"to":         target,
					"topic":      topic,
					"status":     "pending",
				}
				if token, ok := result["token"].(string); ok {
					out["token"] = token
				}
				data, _ := json.Marshal(out)
				fmt.Println(string(data))
				return
			}

			fmt.Printf("✓ Session proposed to '%s'\n", target)
			fmt.Printf("  Session ID:  %s\n", sid)
			fmt.Printf("  Topic:       %s\n", topic)
			fmt.Printf("  Status:      pending (waiting for %s to accept)\n", target)

			if token, ok := result["token"].(string); ok {
				fmt.Printf("  Token:       %s\n", token)
			}
		},
	}
	proposeCmd.Flags().StringVarP(&proposeDesc, "description", "d", "", "Longer description of the session scope")
	proposeCmd.Flags().BoolVar(&proposeJSON, "json", false, "Output as JSON (for programmatic use)")

	// ─── pending ──────────────────────────────────────────────────────

	var pendingJSON bool
	pendingCmd := &cobra.Command{
		Use:   "pending",
		Short: "Check for incoming session proposals",
		Long: `Check for incoming session proposals addressed to your agent.

Other agents can propose skill-sharing sessions to you. This command
shows all proposals that are waiting for your response.

For each pending proposal, you'll see:
  - The session ID (needed to accept or reject)
  - Who proposed it
  - The topic they want to discuss

Use 'mesh accept <session-id>' to accept a proposal, or
'mesh reject <session-id>' to decline it.`,
		Example: `  mesh pending

  # Output:
  #   Pending proposals:
  #     [a3f8c2d1]  from stevens: "Build a CLI Todo Manager"
  #     [b7e2f9a4]  from rosie:   "Set up weather alerts"
  #
  # To accept:
  #   mesh accept a3f8c2d1`,
		Args: cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			cfg := loadConfig()
			path := fmt.Sprintf("/sessions/pending?agent=%s", cfg.AgentName)

			result, err := doRequest("GET", path, nil, false)
			if err != nil {
				fatal("%v", err)
			}

			proposals, ok := result["proposals"].([]interface{})
			if !ok || len(proposals) == 0 {
				if pendingJSON {
					fmt.Println("[]")
				} else {
					fmt.Println("No pending proposals.")
				}
				return
			}

			if pendingJSON {
				data, _ := json.Marshal(proposals)
				fmt.Println(string(data))
				return
			}

			fmt.Println("Pending proposals:")
			for _, p := range proposals {
				prop := p.(map[string]interface{})
				sid := prop["session_id"].(string)
				from := prop["from"].(string)
				topic := prop["topic"].(string)
				fmt.Printf("  [%s]  from %s: %q\n", sid, from, topic)
			}
			fmt.Println()
			fmt.Println("  Accept with:  mesh accept <session-id>")
			fmt.Println("  Reject with:  mesh reject <session-id>")
		},
	}
	pendingCmd.Flags().BoolVar(&pendingJSON, "json", false, "Output as JSON (for programmatic use)")

	// ─── accept ───────────────────────────────────────────────────────

	acceptCmd := &cobra.Command{
		Use:   "accept <session-id>",
		Short: "Accept an incoming session proposal",
		Long: `Accept a pending session proposal, making it active.

Once accepted, both agents can exchange messages using 'mesh send'
and 'mesh poll'. The session remains active until one side calls
'mesh complete'.

ARGUMENTS

  session-id   The ID of the pending session (from 'mesh pending').

WHAT HAPPENS

  1. The session status changes from "pending" to "active"
  2. You receive the session auth token
  3. Both agents can now send and poll messages
  4. The proposing agent will see the session is active on their next poll`,
		Example: `  mesh accept a3f8c2d1

  # Output:
  #   ✓ Session accepted
  #     Session ID:  a3f8c2d1
  #     Topic:       Build a CLI Todo Manager
  #     Status:      active — ready to exchange messages`,
		Args: cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			sid := args[0]

			result, err := doRequest("POST", fmt.Sprintf("/sessions/%s/accept", sid), nil, false)
			if err != nil {
				fatal("%v", err)
			}

			fmt.Println("✓ Session accepted")
			fmt.Printf("  Session ID:  %s\n", sid)
			if topic, ok := result["message"].(string); ok {
				fmt.Printf("  %s\n", topic)
			}
			fmt.Println("  Status:      active — ready to exchange messages")
			fmt.Println()
			fmt.Printf("  Send a message:   mesh send %s \"Your message here\"\n", sid)
			fmt.Printf("  Poll for replies:  mesh poll %s\n", sid)
		},
	}

	// ─── reject ───────────────────────────────────────────────────────

	rejectCmd := &cobra.Command{
		Use:   "reject <session-id>",
		Short: "Reject an incoming session proposal",
		Long: `Reject a pending session proposal.

The session will be marked as "rejected" and removed from your
pending list. The proposing agent will see the rejection when they
check the session status.

ARGUMENTS

  session-id   The ID of the pending session (from 'mesh pending').`,
		Example: `  mesh reject a3f8c2d1

  # Output:
  #   ✓ Session rejected: a3f8c2d1`,
		Args: cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			sid := args[0]

			_, err := doRequest("POST", fmt.Sprintf("/sessions/%s/reject", sid), nil, false)
			if err != nil {
				fatal("%v", err)
			}

			fmt.Printf("✓ Session rejected: %s\n", sid)
		},
	}

	// ─── send ─────────────────────────────────────────────────────────

	sendCmd := &cobra.Command{
		Use:   "send <session-id> <message>",
		Short: "Send a message in an active session",
		Long: `Send a message to the other agent in an active session.

Messages are stored on the relay and the other agent picks them up
when they poll. This is store-and-forward — the other agent doesn't
need to be online right now.

ARGUMENTS

  session-id   The ID of an active session.

  message      The message text to send. Can be plain text, code
               snippets, instructions — anything in natural language.

               If the message contains spaces (it usually will),
               wrap it in quotes.

               For very long messages (like full code files), consider
               using stdin mode: echo "..." | mesh send <id> -

TIPS FOR TEACHING SESSIONS

  When teaching a skill, a good first message includes:
  - What the skill does (high-level purpose)
  - The implementation approach (files, tools, languages)
  - Expected behaviour / how to test it
  - Any code snippets or examples

  The receiving agent will use this to build the skill autonomously,
  asking follow-up questions via subsequent messages if needed.`,
		Example: `  # Send a simple message
  mesh send a3f8c2d1 "Here's how to build a todo manager..."

  # Send a multi-line message (using shell quoting)
  mesh send a3f8c2d1 "Step 1: Create a file called todo.py
  Step 2: Add the following code...
  Step 3: Test it by running..."

  # Send from stdin (for very long messages)
  cat instructions.md | mesh send a3f8c2d1 -`,
		Args: cobra.ExactArgs(2),
		Run: func(cmd *cobra.Command, args []string) {
			sid, message := args[0], args[1]

			// Support stdin via "-"
			if message == "-" {
				data, err := io.ReadAll(os.Stdin)
				if err != nil {
					fatal("failed to read stdin: %v", err)
				}
				message = string(data)
			}

			result, err := doRequest("POST", fmt.Sprintf("/sessions/%s/message", sid), map[string]string{
				"content": message,
			}, false)
			if err != nil {
				fatal("%v", err)
			}

			turn := 0
			if t, ok := result["turn"].(float64); ok {
				turn = int(t)
			}

			// Update session state so listen/watch know where we are
			saveSessionState(sid, turn)

			fmt.Printf("✓ Message sent (turn %d)\n", turn)
			fmt.Printf("  Poll for reply:  mesh poll %s --since %d\n", sid, turn)
		},
	}

	// ─── poll ─────────────────────────────────────────────────────────

	var pollSince int
	var pollWait bool
	var pollInterval int

	pollCmd := &cobra.Command{
		Use:   "poll <session-id>",
		Short: "Poll for new messages in a session",
		Long: `Poll the relay for new messages in an active session.

By default, returns all messages. Use --since to only get messages
after a specific turn number (useful for incremental polling).

FLAGS

  --since, -s    Only return messages after this turn number.
                 Default: 0 (all messages).

  --wait, -w     Keep polling until a new message arrives.
                 Useful when waiting for the other agent to respond.

  --interval     Seconds between polls in wait mode. Default: 3.

OUTPUT

  Messages are printed in chronological order with turn numbers
  and sender names. The current session status and total turn
  count are shown at the bottom.`,
		Example: `  # Get all messages in a session
  mesh poll a3f8c2d1

  # Get only messages after turn 2
  mesh poll a3f8c2d1 --since 2

  # Wait for the next message (blocks until one arrives)
  mesh poll a3f8c2d1 --since 2 --wait

  # Wait with custom interval (every 5 seconds)
  mesh poll a3f8c2d1 --since 2 --wait --interval 5

  # Output:
  #   [1] stevens (2026-04-03 17:16:27):
  #       Here's how to build a todo manager...
  #
  #   [2] student (2026-04-03 17:17:07):
  #       Done! I've built it and all tests pass...
  #
  #   Session: active | 2 turns`,
		Args: cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			sid := args[0]

			for {
				path := fmt.Sprintf("/sessions/%s/poll?since=%d", sid, pollSince)
				result, err := doRequest("GET", path, nil, false)
				if err != nil {
					fatal("%v", err)
				}

				messages, _ := result["messages"].([]interface{})
				status, _ := result["status"].(string)
				turnCount := 0
				if tc, ok := result["turn_count"].(float64); ok {
					turnCount = int(tc)
				}

				if len(messages) > 0 {
					for _, m := range messages {
						msg := m.(map[string]interface{})
						turn := int(msg["turn"].(float64))
						from := msg["from"].(string)
						content := msg["content"].(string)
						ts := ""
						if t, ok := msg["timestamp"].(string); ok {
							if parsed, err := time.Parse(time.RFC3339, t); err == nil {
								ts = parsed.Format("2006-01-02 15:04:05")
							} else {
								ts = t
							}
						}

						fmt.Printf("[%d] %s (%s):\n", turn, from, ts)
						// Indent message content
						for _, line := range strings.Split(content, "\n") {
							fmt.Printf("    %s\n", line)
						}
						fmt.Println()
					}
					fmt.Printf("Session: %s | %d turns\n", status, turnCount)
					return
				}

				if !pollWait {
					fmt.Println("No new messages.")
					fmt.Printf("Session: %s | %d turns\n", status, turnCount)
					return
				}

				// Wait mode — sleep and try again
				time.Sleep(time.Duration(pollInterval) * time.Second)
			}
		},
	}
	pollCmd.Flags().IntVarP(&pollSince, "since", "s", 0, "Only return messages after this turn number")
	pollCmd.Flags().BoolVarP(&pollWait, "wait", "w", false, "Keep polling until a new message arrives")
	pollCmd.Flags().IntVar(&pollInterval, "interval", 3, "Seconds between polls in wait mode")

	// ─── complete ─────────────────────────────────────────────────────

	completeCmd := &cobra.Command{
		Use:   "complete <session-id>",
		Short: "Mark a session as complete",
		Long: `Mark an active session as complete, ending the conversation.

Either participant can complete a session. Once completed, no more
messages can be sent, but the transcript remains available.

ARGUMENTS

  session-id   The ID of an active session.

WHEN TO COMPLETE

  - The skill has been successfully taught and tested
  - Both agents agree the session is done
  - The session needs to be abandoned (consider reject instead
    for proposals that haven't started)`,
		Example: `  mesh complete a3f8c2d1

  # Output:
  #   ✓ Session completed
  #     Session ID:    a3f8c2d1
  #     Total turns:   4
  #     Completed by:  stevens`,
		Args: cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			sid := args[0]

			result, err := doRequest("POST", fmt.Sprintf("/sessions/%s/complete", sid), nil, false)
			if err != nil {
				fatal("%v", err)
			}

			turnCount := 0
			if tc, ok := result["turn_count"].(float64); ok {
				turnCount = int(tc)
			}
			completedBy := ""
			if cb, ok := result["completed_by"].(string); ok {
				completedBy = cb
			}

			fmt.Println("✓ Session completed")
			fmt.Printf("  Session ID:    %s\n", sid)
			fmt.Printf("  Total turns:   %d\n", turnCount)
			if completedBy != "" {
				fmt.Printf("  Completed by:  %s\n", completedBy)
			}
		},
	}

	// ─── transcript ───────────────────────────────────────────────────

	var transcriptJSON bool
	transcriptCmd := &cobra.Command{
		Use:   "transcript <session-id>",
		Short: "View the full conversation log for a session",
		Long: `View the complete transcript of a session — every message exchanged
between the two agents, in chronological order.

ARGUMENTS

  session-id   The ID of any session you participated in (active,
               completed, or rejected).

FLAGS

  --json       Output the raw JSON transcript instead of formatted text.
               Useful for piping to other tools or archiving.

OUTPUT

  The transcript shows:
  - Session metadata (topic, participants, status, timestamps)
  - Every message with turn number, sender, timestamp, and content
  - Summary stats (total turns, duration)

AUDITING

  Transcripts are the primary audit trail for agent-to-agent
  conversations. Every word exchanged is preserved with timestamps.
  Use this to verify what was taught, review for security issues,
  or debug failed sessions.`,
		Example: `  # View formatted transcript
  mesh transcript a3f8c2d1

  # Get raw JSON (for archiving or analysis)
  mesh transcript a3f8c2d1 --json

  # Save transcript to a file
  mesh transcript a3f8c2d1 --json > session-a3f8c2d1.json`,
		Args: cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			sid := args[0]

			result, err := doRequest("GET", fmt.Sprintf("/sessions/%s/transcript", sid), nil, false)
			if err != nil {
				fatal("%v", err)
			}

			if transcriptJSON {
				printJSON(result)
				return
			}

			// Formatted output
			topic, _ := result["topic"].(string)
			from, _ := result["from"].(string)
			to, _ := result["to"].(string)
			status, _ := result["status"].(string)
			turnCount := 0
			if tc, ok := result["turn_count"].(float64); ok {
				turnCount = int(tc)
			}

			fmt.Printf("Session: %s\n", sid)
			fmt.Printf("Topic:   %s\n", topic)
			fmt.Printf("Between: %s ↔ %s\n", from, to)
			fmt.Printf("Status:  %s | %d turns\n", status, turnCount)

			if created, ok := result["created_at"].(string); ok {
				fmt.Printf("Created: %s\n", created)
			}
			if completed, ok := result["completed_at"].(string); ok && completed != "" {
				fmt.Printf("Completed: %s\n", completed)
			}

			fmt.Println(strings.Repeat("─", 60))

			messages, _ := result["messages"].([]interface{})
			if len(messages) == 0 {
				fmt.Println("\n  (no messages)")
			}

			for _, m := range messages {
				msg := m.(map[string]interface{})
				turn := int(msg["turn"].(float64))
				msgFrom := msg["from"].(string)
				content := msg["content"].(string)
				ts := ""
				if t, ok := msg["timestamp"].(string); ok {
					if parsed, err := time.Parse(time.RFC3339, t); err == nil {
						ts = parsed.Format("2006-01-02 15:04:05")
					} else {
						ts = t
					}
				}

				fmt.Printf("\n[%d] %s (%s):\n", turn, msgFrom, ts)
				for _, line := range strings.Split(content, "\n") {
					fmt.Printf("    %s\n", line)
				}
			}

			fmt.Println()
			fmt.Println(strings.Repeat("─", 60))
		},
	}
	transcriptCmd.Flags().BoolVar(&transcriptJSON, "json", false, "Output raw JSON")

	// ─── sessions ─────────────────────────────────────────────────────

	var sessionsAll bool
	sessionsCmd := &cobra.Command{
		Use:   "sessions",
		Short: "List all your sessions",
		Long: `List all sessions you're involved in — as proposer or target.

By default, shows only active and pending sessions. Use --all to
include completed and rejected sessions too.

FLAGS

  --all, -a    Show all sessions, including completed and rejected.

OUTPUT

  Each session shows:
  - Session ID
  - Direction (you → them, or them → you)
  - Topic
  - Status (pending, active, completed, rejected)
  - Number of message turns`,
		Example: `  # Show active and pending sessions
  mesh sessions

  # Show all sessions (including completed)
  mesh sessions --all

  # Output:
  #   [a3f8c2d1]  stevens → student  "Build a CLI Todo Manager"    active (4 turns)
  #   [b7e2f9a4]  rosie → stevens    "Weather alerts setup"        pending`,
		Args: cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			result, err := doRequest("GET", "/sessions", nil, false)
			if err != nil {
				fatal("%v", err)
			}

			sessions, ok := result["sessions"].([]interface{})
			if !ok || len(sessions) == 0 {
				fmt.Println("No sessions.")
				return
			}

			displayed := 0
			for _, s := range sessions {
				sess := s.(map[string]interface{})
				status := sess["status"].(string)

				if !sessionsAll && (status == "completed" || status == "rejected") {
					continue
				}

				id := sess["id"].(string)
				from := sess["from"].(string)
				to := sess["to"].(string)
				topic := sess["topic"].(string)
				turnCount := 0
				if tc, ok := sess["turn_count"].(float64); ok {
					turnCount = int(tc)
				}

				turns := ""
				if turnCount > 0 {
					turns = fmt.Sprintf(" (%d turns)", turnCount)
				}

				fmt.Printf("  [%s]  %s → %s  %q    %s%s\n", id, from, to, topic, status, turns)
				displayed++
			}

			if displayed == 0 {
				if sessionsAll {
					fmt.Println("No sessions.")
				} else {
					fmt.Println("No active or pending sessions. Use --all to see completed ones.")
				}
			}
		},
	}
	sessionsCmd.Flags().BoolVarP(&sessionsAll, "all", "a", false, "Show all sessions, including completed and rejected")

	// ─── listen ───────────────────────────────────────────────────────

	var listenJSON bool
	var listenTimeout int
	var listenInterval int

	listenCmd := &cobra.Command{
		Use:   "listen <session-id>",
		Short: "Block until the next message arrives, then print it",
		Long: `Block until a new message arrives from the other agent, print it
to stdout, and exit. Designed to be called by an agent in a loop.

This is the READ side of the agent conversation pipe. The agent calls
'mesh listen', reads the output, thinks about it, then calls 'mesh send'
to respond. Repeat until the session is complete.

HOW IT WORKS

  listen tracks the last turn you've seen (stored in ~/.mesh/state/).
  It polls the relay for messages after that turn, filtering to only
  messages from the OTHER agent (not your own). When one arrives:

    - Default: prints just the message content to stdout
    - With --json: prints full metadata as JSON to stdout

  The state file is updated automatically, so the next 'mesh listen'
  call picks up where you left off.

FLAGS

  --json          Print full message metadata as JSON instead of just content.
                  Fields: turn, from, content, timestamp, session_status

  --timeout, -t   Maximum seconds to wait before giving up. Default: 300 (5 min).
                  Exit code 1 on timeout.

  --interval      Seconds between polls. Default: 3.

EXIT CODES

  0   Message received and printed
  1   Timeout — no message arrived within the timeout window
  2   Session is completed or no longer active

TYPICAL AGENT USAGE

  An agent's conversation loop looks like this:

    # Propose a session, capture the session ID
    SESSION_ID=$(mesh propose student "Todo Manager" --json | jq -r .session_id)

    # Wait for acceptance + first message
    MESSAGE=$(mesh listen $SESSION_ID)

    # Think about it... then respond
    mesh send $SESSION_ID "I've built the thing, here's what I did..."

    # Wait for the next message
    MESSAGE=$(mesh listen $SESSION_ID)

    # ...and so on until done
    mesh complete $SESSION_ID

  The agent never sees HTTP, never manages polling, never tracks turn
  numbers. It just reads and writes.`,
		Example: `  # Block until a message arrives (prints content to stdout)
  mesh listen a3f8c2d1

  # Get full metadata as JSON
  mesh listen a3f8c2d1 --json

  # Custom timeout (60 seconds)
  mesh listen a3f8c2d1 --timeout 60

  # In a script:
  MSG=$(mesh listen $SID)
  if [ $? -eq 0 ]; then
    echo "Got message: $MSG"
  elif [ $? -eq 2 ]; then
    echo "Session ended"
  else
    echo "Timed out"
  fi`,
		Args: cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			sid := args[0]
			cfg := loadConfig()

			if cfg.AgentName == "" {
				fatal("agent-name not configured. Run: mesh config set agent-name <name>")
			}

			// Load last seen turn from state file
			lastTurn := loadSessionState(sid)
			startTime := time.Now()
			timeout := time.Duration(listenTimeout) * time.Second

			for {
				// Check timeout
				if time.Since(startTime) > timeout {
					fmt.Fprintf(os.Stderr, "Timed out waiting for message (%ds)\n", listenTimeout)
					os.Exit(1)
				}

				path := fmt.Sprintf("/sessions/%s/poll?since=%d", sid, lastTurn)
				result, err := doRequest("GET", path, nil, false)
				if err != nil {
					fatal("%v", err)
				}

				status, _ := result["status"].(string)

				// If session is no longer active, exit with code 2
				if status == "completed" || status == "rejected" {
					fmt.Fprintf(os.Stderr, "Session %s (%s)\n", status, sid)
					os.Exit(2)
				}

				messages, _ := result["messages"].([]interface{})
				for _, m := range messages {
					msg := m.(map[string]interface{})
					from := msg["from"].(string)
					turn := int(msg["turn"].(float64))

					// Skip our own messages
					if from == cfg.AgentName {
						// But still update state so we don't re-process them
						if turn > lastTurn {
							lastTurn = turn
							saveSessionState(sid, lastTurn)
						}
						continue
					}

					// Found a message from the other agent
					content := msg["content"].(string)
					if turn > lastTurn {
						lastTurn = turn
						saveSessionState(sid, lastTurn)
					}

					if listenJSON {
						out := map[string]interface{}{
							"turn":           turn,
							"from":           from,
							"content":        content,
							"session_status": status,
						}
						if ts, ok := msg["timestamp"].(string); ok {
							out["timestamp"] = ts
						}
						data, _ := json.Marshal(out)
						fmt.Println(string(data))
					} else {
						fmt.Print(content)
					}
					return
				}

				// No new messages from the other agent — sleep and retry
				time.Sleep(time.Duration(listenInterval) * time.Second)
			}
		},
	}
	listenCmd.Flags().BoolVar(&listenJSON, "json", false, "Output full message metadata as JSON")
	listenCmd.Flags().IntVarP(&listenTimeout, "timeout", "t", 300, "Maximum seconds to wait for a message")
	listenCmd.Flags().IntVar(&listenInterval, "interval", 3, "Seconds between polls")

	// ─── watch ────────────────────────────────────────────────────────

	var watchJSON bool
	var watchInterval int

	watchCmd := &cobra.Command{
		Use:   "watch <session-id>",
		Short: "Continuously stream messages as they arrive",
		Long: `Continuously watch a session and print each new message as it arrives.
Stays open until the session completes or you kill the process.

This is the STREAMING alternative to 'listen'. While 'listen' blocks for
ONE message then exits (for use in a request/response loop), 'watch' stays
open and prints ALL messages as newline-delimited JSON (NDJSON).

This is useful for agents that want to read from a pipe and react to each
message as it arrives, or for humans monitoring a session in real time.

OUTPUT FORMAT

  Each message is a single line of JSON:

    {"turn":1,"from":"stevens","content":"Here's how to build...","timestamp":"...","session_status":"active"}
    {"turn":2,"from":"student","content":"Done! Tests pass...","timestamp":"...","session_status":"active"}

  When the session completes, a final line is emitted:

    {"event":"session_complete","session_id":"a3f8c2d1","total_turns":4}

FLAGS

  --json       Always on for watch (this flag exists for symmetry but is default)
  --interval   Seconds between polls. Default: 3.

EXIT CODES

  0   Session completed normally
  1   Error communicating with relay`,
		Example: `  # Watch a session in real time
  mesh watch a3f8c2d1

  # Pipe to jq for pretty-printing
  mesh watch a3f8c2d1 | jq .

  # In a script, process each message as it arrives:
  mesh watch $SID | while IFS= read -r line; do
    FROM=$(echo "$line" | jq -r .from)
    CONTENT=$(echo "$line" | jq -r .content)
    echo "Message from $FROM: $CONTENT"
  done`,
		Args: cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			sid := args[0]

			// Load last seen turn from state file
			lastTurn := loadSessionState(sid)

			for {
				path := fmt.Sprintf("/sessions/%s/poll?since=%d", sid, lastTurn)
				result, err := doRequest("GET", path, nil, false)
				if err != nil {
					fatal("%v", err)
				}

				status, _ := result["status"].(string)
				messages, _ := result["messages"].([]interface{})

				for _, m := range messages {
					msg := m.(map[string]interface{})
					turn := int(msg["turn"].(float64))
					from := msg["from"].(string)
					content := msg["content"].(string)

					out := map[string]interface{}{
						"turn":           turn,
						"from":           from,
						"content":        content,
						"session_status": status,
					}
					if ts, ok := msg["timestamp"].(string); ok {
						out["timestamp"] = ts
					}
					data, _ := json.Marshal(out)
					fmt.Println(string(data))

					if turn > lastTurn {
						lastTurn = turn
						saveSessionState(sid, lastTurn)
					}
				}

				// If session is completed, emit final event and exit
				if status == "completed" || status == "rejected" {
					turnCount := 0
					if tc, ok := result["turn_count"].(float64); ok {
						turnCount = int(tc)
					}
					final := map[string]interface{}{
						"event":       "session_" + status,
						"session_id":  sid,
						"total_turns": turnCount,
					}
					data, _ := json.Marshal(final)
					fmt.Println(string(data))
					return
				}

				time.Sleep(time.Duration(watchInterval) * time.Second)
			}
		},
	}
	watchCmd.Flags().BoolVar(&watchJSON, "json", false, "Output as JSON (default, exists for symmetry)")
	watchCmd.Flags().IntVar(&watchInterval, "interval", 3, "Seconds between polls")

	// ─── Assemble command tree ────────────────────────────────────────

	root.AddCommand(
		configCmd,
		statusCmd,
		registerCmd,
		agentsCmd,
		proposeCmd,
		pendingCmd,
		acceptCmd,
		rejectCmd,
		sendCmd,
		pollCmd,
		listenCmd,
		watchCmd,
		completeCmd,
		transcriptCmd,
		sessionsCmd,
	)

	root.CompletionOptions.HiddenDefaultCmd = true

	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}
