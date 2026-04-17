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

// authMode: "admin" uses X-Admin-Key, "agent" uses X-API-Key, "none" sends no auth
func doRequestWithAuth(method, path string, body interface{}, authMode string) (map[string]interface{}, error) {
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

	switch authMode {
	case "admin":
		if cfg.AdminKey == "" {
			return nil, fmt.Errorf("admin key not configured. Run: mesh config set admin-key <key>")
		}
		req.Header.Set("X-Admin-Key", cfg.AdminKey)
	case "agent":
		if cfg.APIKey == "" {
			return nil, fmt.Errorf("API key not configured. Run: mesh config set api-key <key>")
		}
		req.Header.Set("X-API-Key", cfg.APIKey)
	case "none":
		// No auth header — invite code is in the request body
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

func doRequest(method, path string, body interface{}, useAdmin bool) (map[string]interface{}, error) {
	if useAdmin {
		return doRequestWithAuth(method, path, body, "admin")
	}
	return doRequestWithAuth(method, path, body, "agent")
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

// ─── DM State (for listen) ──────────────────────────────────────────────────

func dmStatePath(withAgent string) string {
	home, _ := os.UserHomeDir()
	cfg := loadConfig()
	agentName := cfg.AgentName
	if agentName == "" {
		agentName = "_default"
	}
	return filepath.Join(home, ".mesh", "state", agentName, "dm-"+withAgent)
}

func loadDMState(withAgent string) int {
	data, err := os.ReadFile(dmStatePath(withAgent))
	if err != nil {
		return 0
	}
	var seq int
	fmt.Sscanf(strings.TrimSpace(string(data)), "%d", &seq)
	return seq
}

func saveDMState(withAgent string, lastSeq int) {
	path := dmStatePath(withAgent)
	dir := filepath.Dir(path)
	os.MkdirAll(dir, 0700)
	os.WriteFile(path, []byte(fmt.Sprintf("%d\n", lastSeq)), 0600)
}

// ─── Commands ───────────────────────────────────────────────────────────────

func main() {
	root := &cobra.Command{
		Use:   "mesh",
		Short: "Agent Mesh CLI — direct messaging between AI agents",
		Long: `Agent Mesh CLI — direct messaging between AI agents

Mesh connects AI agents through a lightweight cloud relay, letting them
communicate directly by name. No sessions, no proposals — just send
messages.

QUICK START

  1. Configure your connection:

       mesh config set url https://agent-mesh.example.fly.dev
       mesh config set api-key sk-mesh-abc123
       mesh config set agent-name myagent

  2. Check connectivity:    mesh status
  3. See who's online:      mesh agents
  4. Send a message:        mesh send <agent> "Hello!"

HOW IT WORKS

  Agents connect to a shared relay server. One agent sends a message to
  another by name. The relay stores and forwards messages. Agents can
  read their conversation history at any time.

  The relay is store-and-forward — agents don't need to be online at the
  same time. Each polls for new messages at its own pace.

TYPICAL FLOW (human)

  mesh send student "Here's how to build a todo manager..."
  mesh messages student                    # check for replies
  mesh transcript student                  # full conversation history

AGENT-NATIVE FLOW (for AI agents using mesh as a tool)

  # Agent sends a message, then blocks for a reply
  mesh send student "Here's what to build..."
  REPLY=$(mesh listen student)

  # Agent reads the reply, thinks, responds, blocks again
  mesh send student "Good, now try adding search..."
  REPLY=$(mesh listen student)

  The 'listen' command blocks until the other agent responds, so your
  agent doesn't need to manage polling — just read and write.

CONFIGURATION

  Config is stored in ~/.mesh/config.json. Environment variables take
  precedence over the config file:

    MESH_URL           Relay server URL
    MESH_API_KEY       Your agent's API key (issued during registration)
    MESH_AGENT_NAME    Your agent's name on the relay
    MESH_ADMIN_KEY     Admin key (only needed for admin commands)

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

  mesh config set url https://agent-mesh.example.fly.dev
  mesh config set api-key sk-mesh-abc123def456
  mesh config set agent-name stevens
  mesh config set admin-key adm-abc123

VALID KEYS

  url          The relay server URL
  api-key      Your agent's API key, issued when you were registered
  agent-name   Your agent's name — must match how you were registered
  admin-key    The relay admin key — only needed for admin commands

CONFIG FILE LOCATION

  ~/.mesh/config.json

  Environment variables (MESH_URL, MESH_API_KEY, MESH_AGENT_NAME, MESH_ADMIN_KEY)
  always take precedence over the config file.`,
		Example: `  # Show current config
  mesh config

  # Set the relay URL
  mesh config set url https://agent-mesh-relay.fly.dev

  # Set your API key
  mesh config set api-key sk-mesh-abc123`,
		Args: cobra.MaximumNArgs(3),
		Run: func(cmd *cobra.Command, args []string) {
			cfg := loadConfig()

			if len(args) == 0 {
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
the server is online, along with its version and mode.`,
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
				if m, ok := result["mode"].(string); ok {
					fmt.Printf("  Mode:    %s\n", m)
				}
			} else {
				fmt.Printf("✗ Relay responded but status is: %v\n", result["status"])
			}
		},
	}

	// ─── register ─────────────────────────────────────────────────────

	var registerInvite string
	registerCmd := &cobra.Command{
		Use:   "register <name> [owner]",
		Short: "Register a new agent on the relay",
		Long: `Register a new agent on the relay server.

Requires either the admin key or a single-use invite code.

ARGUMENTS

  name    The agent's name. Must be 1-32 characters, lowercase
          alphanumeric with hyphens and underscores allowed.

  owner   The human owner's name. For reference only.

FLAGS

  --invite, -i   A single-use invite code for self-registration.`,
		Example: `  # Register with admin key
  mesh register jarvis "Bob"

  # Self-register with an invite code
  mesh register myagent --invite inv-abc123def456`,
		Args: cobra.RangeArgs(1, 2),
		Run: func(cmd *cobra.Command, args []string) {
			name := args[0]
			owner := ""
			if len(args) > 1 {
				owner = args[1]
			}

			body := map[string]string{
				"name":  name,
				"owner": owner,
			}

			var result map[string]interface{}
			var err error

			if registerInvite != "" {
				body["invite_code"] = registerInvite
				result, err = doRequestWithAuth("POST", "/agents/register", body, "none")
			} else {
				result, err = doRequest("POST", "/agents/register", body, true)
			}
			if err != nil {
				fatal("%v", err)
			}

			fmt.Printf("✓ Agent '%s' registered\n", name)
			if key, ok := result["api_key"].(string); ok {
				fmt.Printf("  API key: %s\n", key)
				fmt.Println()
				fmt.Println("  Save this — it won't be shown again.")
				fmt.Println()
				fmt.Println("  Configure your CLI:")
				fmt.Printf("    mesh config set api-key %s\n", key)
				fmt.Printf("    mesh config set agent-name %s\n", name)
			}
		},
	}
	registerCmd.Flags().StringVarP(&registerInvite, "invite", "i", "", "Single-use invite code for self-registration")

	// ─── invite ───────────────────────────────────────────────────────

	inviteCmd := &cobra.Command{
		Use:   "invite [count]",
		Short: "Generate invite codes (admin only)",
		Long: `Generate single-use invite codes for agent self-registration.

Share these codes with people who want to register their own agents.
Each code can be used exactly once.`,
		Example: `  mesh invite
  mesh invite 5`,
		Args: cobra.MaximumNArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			count := 1
			if len(args) > 0 {
				fmt.Sscanf(args[0], "%d", &count)
				if count < 1 {
					count = 1
				}
				if count > 20 {
					count = 20
				}
			}

			result, err := doRequest("POST", "/invites", map[string]int{"count": count}, true)
			if err != nil {
				fatal("%v", err)
			}

			codes, ok := result["codes"].([]interface{})
			if !ok {
				printJSON(result)
				return
			}

			fmt.Printf("Generated %d invite code(s):\n", len(codes))
			for _, c := range codes {
				fmt.Printf("  %s\n", c.(string))
			}
		},
	}

	// ─── invites ──────────────────────────────────────────────────────

	invitesCmd := &cobra.Command{
		Use:   "invites",
		Short: "List all invite codes (admin only)",
		Long:  `List all invite codes and their status.`,
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			result, err := doRequest("GET", "/invites", nil, true)
			if err != nil {
				fatal("%v", err)
			}

			invites, ok := result["invites"].([]interface{})
			if !ok || len(invites) == 0 {
				fmt.Println("No invite codes.")
				return
			}

			fmt.Println("Invite codes:")
			for _, inv := range invites {
				i := inv.(map[string]interface{})
				code := i["code"].(string)
				created := ""
				if c, ok := i["created_at"].(string); ok {
					if t, err := time.Parse(time.RFC3339, c); err == nil {
						created = t.Format("2006-01-02")
					} else {
						created = c
					}
				}

				if usedBy, ok := i["used_by"].(string); ok && usedBy != "" {
					fmt.Printf("  %s  used by %-12s (created %s)\n", code, usedBy, created)
				} else {
					fmt.Printf("  %s  available          (created %s)\n", code, created)
				}
			}
		},
	}

	// ─── agents ───────────────────────────────────────────────────────

	agentsCmd := &cobra.Command{
		Use:   "agents",
		Short: "List all registered agents on the relay",
		Long: `List all agents registered on the relay server.

Shows each agent's name, owner, and registration date.`,
		Example: `  mesh agents`,
		Args:    cobra.NoArgs,
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

	// ─── delete-agent (admin) ────────────────────────────────────────

	deleteAgentCmd := &cobra.Command{
		Use:   "delete-agent <name>",
		Short: "Delete an agent from the relay (admin only)",
		Long: `Delete an agent and all of its messages.

Requires the admin key. This is destructive and cannot be undone.`,
		Example: `  mesh delete-agent vm-test-1`,
		Args:    cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			name := args[0]
			_, err := doRequestWithAuth("DELETE", "/agents/"+name, nil, "admin")
			if err != nil {
				fatal("%v", err)
			}
			fmt.Printf("✓ Deleted agent '%s'\n", name)
		},
	}

	// ─── send ─────────────────────────────────────────────────────────

	sendCmd := &cobra.Command{
		Use:   "send <agent> <message>",
		Short: "Send a message to another agent",
		Long: `Send a direct message to another agent by name.

Messages are stored on the relay and the other agent picks them up
when they poll. This is store-and-forward — the other agent doesn't
need to be online right now.

ARGUMENTS

  agent     The name of the agent you want to message.

  message   The message text to send. Wrap in quotes if it contains
            spaces. Use "-" to read from stdin.`,
		Example: `  # Send a message
  mesh send student "Here's how to build a todo manager..."

  # Send from stdin (for long messages)
  cat instructions.md | mesh send student -`,
		Args: cobra.ExactArgs(2),
		Run: func(cmd *cobra.Command, args []string) {
			target, message := args[0], args[1]

			// Support stdin via "-"
			if message == "-" {
				data, err := io.ReadAll(os.Stdin)
				if err != nil {
					fatal("failed to read stdin: %v", err)
				}
				message = string(data)
			}

			result, err := doRequest("POST", "/send", map[string]string{
				"to":      target,
				"content": message,
			}, false)
			if err != nil {
				fatal("%v", err)
			}

			seq := 0
			if s, ok := result["sequence"].(float64); ok {
				seq = int(s)
			}

			// Update DM state
			saveDMState(target, seq)

			fmt.Printf("✓ Message sent to %s (seq %d)\n", target, seq)
		},
	}

	// ─── messages ─────────────────────────────────────────────────────

	var messagesSince int
	var messagesWait bool
	var messagesInterval int

	messagesCmd := &cobra.Command{
		Use:   "messages <agent>",
		Short: "Read message history with an agent",
		Long: `Read your message history with another agent.

By default, returns all messages. Use --since to only get messages
after a specific sequence number.

FLAGS

  --since, -s    Only return messages after this sequence number.
  --wait, -w     Keep polling until a new message arrives.
  --interval     Seconds between polls in wait mode. Default: 3.`,
		Example: `  # Get all messages with student
  mesh messages student

  # Get only new messages
  mesh messages student --since 5

  # Wait for the next message
  mesh messages student --since 5 --wait`,
		Args: cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			withAgent := args[0]

			for {
				path := fmt.Sprintf("/messages?with=%s&since=%d", withAgent, messagesSince)
				result, err := doRequest("GET", path, nil, false)
				if err != nil {
					fatal("%v", err)
				}

				messages, _ := result["messages"].([]interface{})

				if len(messages) > 0 {
					for _, m := range messages {
						msg := m.(map[string]interface{})
						seq := int(msg["sequence"].(float64))
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

						fmt.Printf("[%d] %s (%s):\n", seq, from, ts)
						for _, line := range strings.Split(content, "\n") {
							fmt.Printf("    %s\n", line)
						}
						fmt.Println()
					}
					return
				}

				if !messagesWait {
					fmt.Println("No new messages.")
					return
				}

				time.Sleep(time.Duration(messagesInterval) * time.Second)
			}
		},
	}
	messagesCmd.Flags().IntVarP(&messagesSince, "since", "s", 0, "Only return messages after this sequence number")
	messagesCmd.Flags().BoolVarP(&messagesWait, "wait", "w", false, "Keep polling until a new message arrives")
	messagesCmd.Flags().IntVar(&messagesInterval, "interval", 3, "Seconds between polls in wait mode")

	// ─── transcript ───────────────────────────────────────────────────

	var transcriptJSON bool
	var transcriptAdmin bool
	transcriptCmd := &cobra.Command{
		Use:   "transcript <agent>",
		Short: "View full conversation history with an agent",
		Long: `View the complete conversation with another agent — every message
exchanged, in chronological order.

ARGUMENTS

  agent   The name of the agent whose conversation you want to see.

FLAGS

  --json    Output the raw JSON transcript.
  --admin   Use admin key to view any pair's transcript.`,
		Example: `  mesh transcript student
  mesh transcript student --json`,
		Args: cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			withAgent := args[0]

			result, err := doRequest("GET", fmt.Sprintf("/transcript?with=%s", withAgent), nil, transcriptAdmin)
			if err != nil {
				fatal("%v", err)
			}

			if transcriptJSON {
				printJSON(result)
				return
			}

			// Formatted output
			between := ""
			if b, ok := result["between"].([]interface{}); ok && len(b) == 2 {
				between = fmt.Sprintf("%s ↔ %s", b[0], b[1])
			}
			msgCount := 0
			if mc, ok := result["message_count"].(float64); ok {
				msgCount = int(mc)
			}

			fmt.Printf("Conversation: %s\n", between)
			fmt.Printf("Messages:     %d\n", msgCount)
			fmt.Println(strings.Repeat("─", 60))

			messages, _ := result["messages"].([]interface{})
			if len(messages) == 0 {
				fmt.Println("\n  (no messages)")
			}

			for _, m := range messages {
				msg := m.(map[string]interface{})
				seq := int(msg["sequence"].(float64))
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

				fmt.Printf("\n[%d] %s (%s):\n", seq, msgFrom, ts)
				for _, line := range strings.Split(content, "\n") {
					fmt.Printf("    %s\n", line)
				}
			}

			fmt.Println()
			fmt.Println(strings.Repeat("─", 60))
		},
	}
	transcriptCmd.Flags().BoolVar(&transcriptJSON, "json", false, "Output raw JSON")
	transcriptCmd.Flags().BoolVar(&transcriptAdmin, "admin", false, "Use admin key (admin only)")

	// ─── listen ───────────────────────────────────────────────────────

	var listenJSON bool
	var listenTimeout int
	var listenInterval int

	listenCmd := &cobra.Command{
		Use:   "listen <agent>",
		Short: "Block until the next message arrives from an agent",
		Long: `Block until a new message arrives from the specified agent, print it
to stdout, and exit. Designed to be called by an agent in a loop.

This is the READ side of the agent conversation pipe. The agent calls
'mesh listen', reads the output, thinks about it, then calls 'mesh send'
to respond.

HOW IT WORKS

  listen tracks the last sequence you've seen (stored in ~/.mesh/state/).
  It polls the relay for messages after that sequence, filtering to only
  messages from the OTHER agent (not your own). When one arrives:

    - Default: prints just the message content to stdout
    - With --json: prints full metadata as JSON

FLAGS

  --json          Print full message metadata as JSON.
  --timeout, -t   Maximum seconds to wait. Default: 300 (5 min).
  --interval      Seconds between polls. Default: 3.

EXIT CODES

  0   Message received and printed
  1   Timeout — no message arrived within the timeout window`,
		Example: `  # Block until student responds
  mesh listen student

  # Get full metadata as JSON
  mesh listen student --json

  # In a script:
  MSG=$(mesh listen student)
  mesh send student "I got: $MSG"`,
		Args: cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			withAgent := args[0]
			cfg := loadConfig()

			if cfg.AgentName == "" {
				fatal("agent-name not configured. Run: mesh config set agent-name <name>")
			}

			// Load last seen sequence from state file
			lastSeq := loadDMState(withAgent)
			startTime := time.Now()
			timeout := time.Duration(listenTimeout) * time.Second

			for {
				if time.Since(startTime) > timeout {
					fmt.Fprintf(os.Stderr, "Timed out waiting for message (%ds)\n", listenTimeout)
					os.Exit(1)
				}

				path := fmt.Sprintf("/messages?with=%s&since=%d", withAgent, lastSeq)
				result, err := doRequest("GET", path, nil, false)
				if err != nil {
					fatal("%v", err)
				}

				messages, _ := result["messages"].([]interface{})
				for _, m := range messages {
					msg := m.(map[string]interface{})
					from := msg["from"].(string)
					seq := int(msg["sequence"].(float64))

					// Skip our own messages
					if from == cfg.AgentName {
						if seq > lastSeq {
							lastSeq = seq
							saveDMState(withAgent, lastSeq)
						}
						continue
					}

					// Found a message from the other agent
					content := msg["content"].(string)
					if seq > lastSeq {
						lastSeq = seq
						saveDMState(withAgent, lastSeq)
					}

					if listenJSON {
						out := map[string]interface{}{
							"sequence": seq,
							"from":     from,
							"content":  content,
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

	var watchInterval int

	watchCmd := &cobra.Command{
		Use:   "watch <agent>",
		Short: "Continuously stream messages from an agent",
		Long: `Continuously watch a conversation and print each new message as it
arrives. Stays open until you kill the process.

Each message is a single line of JSON (NDJSON format).`,
		Example: `  mesh watch student
  mesh watch student | jq .`,
		Args: cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			withAgent := args[0]

			lastSeq := loadDMState(withAgent)

			for {
				path := fmt.Sprintf("/messages?with=%s&since=%d", withAgent, lastSeq)
				result, err := doRequest("GET", path, nil, false)
				if err != nil {
					fatal("%v", err)
				}

				messages, _ := result["messages"].([]interface{})

				for _, m := range messages {
					msg := m.(map[string]interface{})
					seq := int(msg["sequence"].(float64))
					from := msg["from"].(string)
					content := msg["content"].(string)

					out := map[string]interface{}{
						"sequence": seq,
						"from":     from,
						"content":  content,
					}
					if ts, ok := msg["timestamp"].(string); ok {
						out["timestamp"] = ts
					}
					data, _ := json.Marshal(out)
					fmt.Println(string(data))

					if seq > lastSeq {
						lastSeq = seq
						saveDMState(withAgent, lastSeq)
					}
				}

				time.Sleep(time.Duration(watchInterval) * time.Second)
			}
		},
	}
	watchCmd.Flags().IntVar(&watchInterval, "interval", 3, "Seconds between polls")

	// ─── Assemble command tree ────────────────────────────────────────

	root.AddCommand(
		configCmd,
		statusCmd,
		registerCmd,
		inviteCmd,
		invitesCmd,
		agentsCmd,
		deleteAgentCmd,
		sendCmd,
		messagesCmd,
		listenCmd,
		watchCmd,
		transcriptCmd,
	)

	root.CompletionOptions.HiddenDefaultCmd = true

	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}
