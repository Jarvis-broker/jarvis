-- Jarvis central memory schema (SQLite).
-- File: ~/Code/jarvis/memory/state.db
-- Owner: jarvis shell (Rust) creates / migrates on startup.
-- Readers: every agent and skill through the MCP `memory_*` tools.

-- =========================================================
-- Facts: durable atoms (preferences, biographical, recurring context)
-- =========================================================
CREATE TABLE IF NOT EXISTS memory_facts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace   TEXT NOT NULL DEFAULT 'core',
  text        TEXT NOT NULL,
  tags        TEXT,                          -- comma-separated, e.g. "pets,personal"
  source      TEXT,                          -- agent / skill that wrote it
  created_at  INTEGER NOT NULL,              -- unix seconds
  updated_at  INTEGER NOT NULL,
  embedding   BLOB                           -- float32[1024], sqlite-vec ready
);
CREATE INDEX IF NOT EXISTS idx_facts_ns ON memory_facts(namespace);
CREATE INDEX IF NOT EXISTS idx_facts_created ON memory_facts(created_at);

-- =========================================================
-- Episodes: one row per user↔jarvis turn (full transcript of a moment)
-- =========================================================
CREATE TABLE IF NOT EXISTS memory_episodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,              -- unix seconds
  channel     TEXT NOT NULL,                 -- voice | text | hotkey | agent
  agent       TEXT,                          -- claude | gemini | skill:<name>
  user_text   TEXT,
  jarvis_text TEXT,
  tools_used  TEXT,                          -- JSON array of tool names called this turn
  duration_ms INTEGER,
  cost_usd    REAL,
  embedding   BLOB
);
CREATE INDEX IF NOT EXISTS idx_episodes_ts ON memory_episodes(ts);
CREATE INDEX IF NOT EXISTS idx_episodes_agent ON memory_episodes(agent);

-- =========================================================
-- Obsidian vault chunks: indexed markdown for semantic search
-- =========================================================
CREATE TABLE IF NOT EXISTS vault_chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_path    TEXT NOT NULL,                 -- e.g. "Memory/jarvis-app — A2 migration.md"
  chunk_idx   INTEGER NOT NULL,              -- 0-based chunk index inside the file
  text        TEXT NOT NULL,
  text_hash   TEXT NOT NULL,                 -- sha256, used for skip-if-unchanged
  embedding   BLOB,
  indexed_at  INTEGER NOT NULL,
  UNIQUE(rel_path, chunk_idx)
);
CREATE INDEX IF NOT EXISTS idx_vault_rel ON vault_chunks(rel_path);

-- =========================================================
-- Agent state: KV scratchpad per agent
-- =========================================================
CREATE TABLE IF NOT EXISTS agent_state (
  agent_id    TEXT NOT NULL,                 -- e.g. "research-bot", "writer"
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,                 -- JSON-encoded
  expires_at  INTEGER,                       -- unix seconds, NULL = no ttl
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (agent_id, key)
);

-- =========================================================
-- Task log: durable multi-step tasks (queued → running → completed/failed)
-- =========================================================
CREATE TABLE IF NOT EXISTS task_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  skill       TEXT NOT NULL,                 -- which skill is running this task
  args        TEXT,                          -- JSON args
  status      TEXT NOT NULL DEFAULT 'queued',-- queued | running | completed | failed | cancelled
  result      TEXT,                          -- JSON result (success) or error message
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_status ON task_log(status);
CREATE INDEX IF NOT EXISTS idx_task_created ON task_log(created_at);

-- =========================================================
-- Skill registry: which skills are installed and enabled
-- =========================================================
CREATE TABLE IF NOT EXISTS skill_registry (
  name        TEXT PRIMARY KEY,
  version     TEXT NOT NULL,
  path        TEXT NOT NULL,                 -- absolute path to skills/<name>/
  enabled     INTEGER NOT NULL DEFAULT 1,
  source      TEXT,                          -- "local" | "skills.sh:<url>" | "github:<repo>"
  installed_at INTEGER NOT NULL,
  manifest    TEXT                           -- parsed YAML frontmatter as JSON
);

-- =========================================================
-- Revenue ledger: one row per income event (RUB by default)
-- Source of truth for the dashboard MRR widget + wake-greeting report.
-- Writers: revenue_add MCP tool (voice / agents). Readers: revenue_summary
-- (MCP tool for the brain, Rust command for the widget).
-- =========================================================
CREATE TABLE IF NOT EXISTS revenue_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,              -- unix seconds of the income event
  amount      REAL NOT NULL,                 -- positive = income, negative = refund/cost
  currency    TEXT NOT NULL DEFAULT 'RUB',   -- ISO 4217; RUB by default
  source      TEXT,                          -- "stripe" | "manual" | agent:<name>
  note        TEXT,                          -- free-form description
  created_at  INTEGER NOT NULL              -- unix seconds the row was written
);
CREATE INDEX IF NOT EXISTS idx_revenue_ts ON revenue_ledger(ts);
CREATE INDEX IF NOT EXISTS idx_revenue_source ON revenue_ledger(source);

-- =========================================================
-- Agent registry: which remote agent endpoints we know about
-- =========================================================
CREATE TABLE IF NOT EXISTS agent_registry (
  name        TEXT PRIMARY KEY,              -- "research-bot", "writer", ...
  url         TEXT NOT NULL,                 -- "https://agent.example.com"
  host        TEXT NOT NULL,                 -- "remote-vps" | "windows-box" | "local" | ...
  auth_token_env TEXT,                       -- env var name holding the bearer token
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_seen   INTEGER,                       -- unix seconds of last successful health-check
  status      TEXT,                          -- "healthy" | "degraded" | "down" | NULL
  role        TEXT,                          -- "CEO" | "CTO" | "Head of Sales" | ... display label
  parent      TEXT,                          -- name of parent agent for org-chart layout
  prompt      TEXT,                          -- system prompt / behaviour spec used when this agent is invoked
  skills      TEXT,                          -- JSON array of skill names this agent is allowed to use
  provider    TEXT                           -- operator/LLM: claude | openai | gemini | cursor | http
);
