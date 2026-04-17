/**
 * Migration script: v3 (session-based) → v4 (DM-mode, pair-routed).
 *
 * Collapses all sessions into per-pair message streams.
 * - Reads all messages from all sessions
 * - Groups them by canonical pair (sorted alphabetically)
 * - Assigns per-pair sequence numbers based on original timestamps
 * - Inserts into the new dm_messages table
 * - Renames old tables to _v3_backup (preserving everything)
 *
 * Safe to run multiple times — checks if migration is already done.
 *
 * Usage:
 *   node migrate.js                    # run migration
 *   node migrate.js --dry-run          # preview what would happen
 *   node migrate.js --check            # just check migration status
 */

import Database from "better-sqlite3";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "data", "relay.db");

const dryRun = process.argv.includes("--dry-run");
const checkOnly = process.argv.includes("--check");

// Ensure data directory exists
fs.mkdirSync(join(__dirname, "data"), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = OFF"); // Off during migration

// ─── Check current state ───────────────────────────────────────────

function tableExists(name) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
  return !!row;
}

const hasOldSessions = tableExists("sessions");
const hasNewMessages = tableExists("dm_messages");
const hasBackup = tableExists("sessions_v3_backup");

if (checkOnly) {
  console.log("Migration status:");
  console.log(`  sessions table exists:         ${hasOldSessions}`);
  console.log(`  dm_messages table exists:       ${hasNewMessages}`);
  console.log(`  sessions_v3_backup exists:      ${hasBackup}`);

  if (hasBackup && hasNewMessages && !hasOldSessions) {
    console.log("\n✓ Migration already completed.");
  } else if (!hasOldSessions && !hasNewMessages && !hasBackup) {
    console.log("\n✓ Fresh install — no migration needed.");
  } else if (hasOldSessions && !hasBackup) {
    console.log("\n→ Migration needed. Run: node migrate.js");
  } else {
    console.log("\n⚠ Partial state — inspect manually.");
  }
  db.close();
  process.exit(0);
}

// ─── Fresh install: nothing to migrate ─────────────────────────────

if (!hasOldSessions && !hasBackup) {
  console.log("No sessions table found — fresh install, nothing to migrate.");

  // Create the new dm_messages table if it doesn't exist
  if (!hasNewMessages) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dm_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_messages(from_agent, to_agent);
      CREATE INDEX IF NOT EXISTS idx_dm_pair_seq ON dm_messages(from_agent, to_agent, sequence);
    `);
    console.log("✓ Created dm_messages table.");
  }

  // Drop the old messages table if it exists (the session-linked one)
  if (tableExists("messages")) {
    db.exec("DROP TABLE IF EXISTS messages;");
    console.log("✓ Dropped empty old messages table.");
  }

  db.close();
  process.exit(0);
}

// ─── Already migrated ──────────────────────────────────────────────

if (hasBackup && !hasOldSessions) {
  console.log("✓ Migration already completed (backup tables exist, sessions table removed).");
  db.close();
  process.exit(0);
}

// ─── Perform migration ─────────────────────────────────────────────

console.log("Starting v3 → v4 migration...");

// 1. Read all old sessions
const sessions = db.prepare("SELECT * FROM sessions ORDER BY created_at").all();
console.log(`  Found ${sessions.length} sessions to migrate.`);

// 2. Read all old messages, enriched with session pair info
const allMessages = [];
for (const s of sessions) {
  const msgs = db.prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY turn"
  ).all(s.id);

  for (const m of msgs) {
    // Determine the recipient: whoever in the session pair is NOT the sender
    const toAgent = m.from_agent === s.from_agent ? s.to_agent : s.from_agent;
    allMessages.push({
      from_agent: m.from_agent,
      to_agent: toAgent,
      content: m.content,
      timestamp: m.timestamp,
      session_id: s.id,
      original_turn: m.turn,
    });
  }
}

console.log(`  Found ${allMessages.length} messages across all sessions.`);

// 3. Group by canonical pair and sort by timestamp
// Canonical pair: alphabetically sorted, so (a, b) and (b, a) map to the same stream
function canonicalPair(a, b) {
  return [a, b].sort().join(":");
}

const pairMap = new Map(); // canonical_key -> messages[]
for (const msg of allMessages) {
  const key = canonicalPair(msg.from_agent, msg.to_agent);
  if (!pairMap.has(key)) pairMap.set(key, []);
  pairMap.get(key).push(msg);
}

// Sort each pair's messages by timestamp, then by original turn as tiebreaker
for (const [key, msgs] of pairMap) {
  msgs.sort((a, b) => {
    const tsCmp = a.timestamp.localeCompare(b.timestamp);
    if (tsCmp !== 0) return tsCmp;
    return a.original_turn - b.original_turn;
  });
}

console.log(`  Collapsed into ${pairMap.size} unique pair stream(s):`);
for (const [key, msgs] of pairMap) {
  console.log(`    ${key}: ${msgs.length} messages`);
}

if (dryRun) {
  console.log("\n[DRY RUN] No changes made. Run without --dry-run to apply.");
  db.close();
  process.exit(0);
}

// 4. Create new table and insert
const migrate = db.transaction(() => {
  // Create dm_messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS dm_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      sequence INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_messages(from_agent, to_agent);
    CREATE INDEX IF NOT EXISTS idx_dm_pair_seq ON dm_messages(from_agent, to_agent, sequence);
  `);

  const insert = db.prepare(
    "INSERT INTO dm_messages (from_agent, to_agent, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?)"
  );

  let totalInserted = 0;
  for (const [key, msgs] of pairMap) {
    let seq = 1;
    for (const msg of msgs) {
      insert.run(msg.from_agent, msg.to_agent, msg.content, msg.timestamp, seq);
      seq++;
      totalInserted++;
    }
  }

  console.log(`  Inserted ${totalInserted} messages into dm_messages.`);

  // 5. Rename old tables to backups
  db.exec("ALTER TABLE sessions RENAME TO sessions_v3_backup;");
  db.exec("ALTER TABLE messages RENAME TO messages_v3_backup;");

  console.log("  Renamed sessions → sessions_v3_backup");
  console.log("  Renamed messages → messages_v3_backup");
});

migrate();

// 6. Verify
const newCount = db.prepare("SELECT COUNT(*) as c FROM dm_messages").get().c;
console.log(`\n✓ Migration complete. ${newCount} messages in dm_messages.`);

db.close();
