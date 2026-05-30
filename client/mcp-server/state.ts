/**
 * Central state.db access from the MCP server.
 *
 * Lives at $JARVIS_STATE_DB or ~/Code/jarvis/client/memory/state.db.
 * Multiple processes (shell + MCP server) read/write — we open in WAL mode.
 *
 * Schema is owned by `memory/schema.sql`. Both the shell and the MCP
 * server can run the migration; the SQL is idempotent (CREATE IF NOT EXISTS).
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  blobToFloat32,
  cosine,
  embedPassage,
  embedQuery,
  float32ToBlob,
} from "./embed.ts";

const HOME = process.env.HOME ?? "";

export const DB_PATH =
  process.env.JARVIS_STATE_DB ?? join(HOME, "Code/jarvis/client/memory/state.db");

export const SCHEMA_PATH =
  process.env.JARVIS_SCHEMA_PATH ??
  join(HOME, "Code/jarvis/client/memory/schema.sql");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH, { create: true });
  db.prepare("PRAGMA journal_mode = WAL").run();
  db.prepare("PRAGMA synchronous = NORMAL").run();
  db.prepare("PRAGMA foreign_keys = ON").run();
  _db = db;
  return db;
}

/**
 * Apply schema.sql (idempotent CREATE-IF-NOT-EXISTS DDL).
 * Splits on `;` at depth 0 and runs each statement via prepare().run().
 */
export function ensureSchema(): void {
  if (!existsSync(SCHEMA_PATH)) {
    throw new Error(`schema.sql not found at ${SCHEMA_PATH}`);
  }
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  const cleaned = stripSqlLineComments(sql);
  const stmts = splitSqlStatements(cleaned);
  const db = getDb();
  for (const s of stmts) {
    const t = s.trim();
    if (!t) continue;
    db.prepare(t).run();
  }
}

function stripSqlLineComments(sql: string): string {
  // Remove `--` line comments. Naive: doesn't handle `--` inside string
  // literals, which we don't have in schema.sql. Comments may contain
  // apostrophes (e.g. "user's dog") which otherwise break the splitter.
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (!inDouble && ch === "'" && sql[i - 1] !== "\\") inSingle = !inSingle;
    else if (!inSingle && ch === '"' && sql[i - 1] !== "\\") inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "(") depth++;
    else if (!inSingle && !inDouble && ch === ")") depth--;
    if (!inSingle && !inDouble && depth === 0 && ch === ";") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

// ============================================================
// memory_facts
// ============================================================

export async function factSave(
  text: string,
  tags?: string,
  namespace = "core",
): Promise<{ id: number }> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  // Compute embedding so semantic recall works immediately.
  let embedding: Buffer | null = null;
  try {
    const v = await embedPassage(text);
    embedding = float32ToBlob(v);
  } catch (e) {
    console.error("[state] embedding failed, saving without vector:", e);
  }
  const r = db
    .prepare(
      `INSERT INTO memory_facts (namespace, text, tags, source, created_at, updated_at, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(namespace, text, tags ?? null, "mcp-server", now, now, embedding);
  return { id: Number(r.lastInsertRowid) };
}

export async function factSearch(
  query: string,
  top = 8,
  namespace?: string,
): Promise<any[]> {
  const db = getDb();
  // Try semantic first; fall back to LIKE if model not ready.
  let qVec: Float32Array | null = null;
  try {
    qVec = await embedQuery(query);
  } catch (e) {
    console.error("[state] query embedding failed, using LIKE:", e);
  }

  const ns = namespace ? `AND namespace = ?` : "";
  if (qVec) {
    // Pull all rows with embeddings, score by cosine. For ~thousands of facts
    // this is fine; if it ever grows past 10k we'll switch to sqlite-vec.
    const stmt = db.prepare(
      `SELECT id, namespace, text, tags, source, created_at, embedding
       FROM memory_facts
       WHERE embedding IS NOT NULL ${ns}`,
    );
    const rows = (
      namespace ? stmt.all(namespace) : stmt.all()
    ) as Array<any>;
    const scored = rows
      .map((r) => {
        const v = blobToFloat32(r.embedding as Buffer);
        return { row: r, score: cosine(qVec!, v) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, top);
    return scored.map((s) => ({
      id: s.row.id,
      namespace: s.row.namespace,
      text: s.row.text,
      tags: s.row.tags,
      source: s.row.source,
      created_at: s.row.created_at,
      score: Number(s.score.toFixed(4)),
    }));
  }

  // LIKE fallback.
  const like = `%${query.toLowerCase()}%`;
  const stmt = db.prepare(
    `SELECT id, namespace, text, tags, source, created_at
     FROM memory_facts
     WHERE LOWER(text) LIKE ? ${ns}
     ORDER BY created_at DESC
     LIMIT ?`,
  );
  const params: any[] = namespace ? [like, namespace, top] : [like, top];
  return stmt.all(...params) as any[];
}

export function factForget(id: number): { deleted: number } {
  const db = getDb();
  const r = db.prepare(`DELETE FROM memory_facts WHERE id = ?`).run(id);
  return { deleted: r.changes };
}

// ============================================================
// memory_episodes
// ============================================================

export function episodeAdd(e: {
  channel: string;
  agent?: string;
  user_text?: string;
  jarvis_text?: string;
  tools_used?: string[];
  duration_ms?: number;
  cost_usd?: number;
}): { id: number } {
  const db = getDb();
  const r = db
    .prepare(
      `INSERT INTO memory_episodes (ts, channel, agent, user_text, jarvis_text, tools_used, duration_ms, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Math.floor(Date.now() / 1000),
      e.channel,
      e.agent ?? null,
      e.user_text ?? null,
      e.jarvis_text ?? null,
      e.tools_used ? JSON.stringify(e.tools_used) : null,
      e.duration_ms ?? null,
      e.cost_usd ?? null,
    );
  return { id: Number(r.lastInsertRowid) };
}

export function episodesByPeriod(period = "today", agent?: string): any[] {
  const db = getDb();
  const { from, to } = periodRange(period);
  const filter = agent ? `AND agent = ?` : "";
  const stmt = db.prepare(
    `SELECT id, ts, channel, agent, user_text, jarvis_text, tools_used, duration_ms, cost_usd
     FROM memory_episodes
     WHERE ts BETWEEN ? AND ? ${filter}
     ORDER BY ts DESC LIMIT 200`,
  );
  const params: any[] = agent ? [from, to, agent] : [from, to];
  return stmt.all(...params) as any[];
}

// ============================================================
// vault_chunks — Obsidian markdown indexed semantically
// ============================================================

const VAULT_ROOT =
  process.env.JARVIS_VAULT_ROOT ?? `${process.env.HOME}/Code/Obsidian`;

const CHUNK_TARGET_CHARS = 800;
const CHUNK_OVERLAP_CHARS = 100;

function chunkMarkdown(text: string): string[] {
  // Naive paragraph-based chunking with overlap. Good enough for v1 — proper
  // semantic chunking can come later when we have a chunker model.
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf.length + p.length + 2 > CHUNK_TARGET_CHARS) {
      if (buf) chunks.push(buf);
      // Overlap with the tail of the previous chunk for context continuity.
      const tail = buf.slice(-CHUNK_OVERLAP_CHARS);
      buf = (tail ? tail + "\n\n" : "") + p;
    } else {
      buf = buf ? buf + "\n\n" + p : p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function vaultIndex(
  onProgress?: (msg: { file: string; chunks: number; total_files: number; indexed: number }) => void,
): Promise<{
  total_files: number;
  indexed: number;
  skipped: number;
  chunks_written: number;
  errors: number;
}> {
  const db = getDb();
  if (!existsSync(VAULT_ROOT)) {
    throw new Error(`vault not found at ${VAULT_ROOT}`);
  }
  // Walk *.md files (synchronously — fine for ~thousands of files).
  const { readdirSync, statSync } = await import("node:fs");
  const { join: jp } = await import("node:path");
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const p = jp(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (e.endsWith(".md")) files.push(p);
    }
  };
  walk(VAULT_ROOT);

  let indexed = 0,
    skipped = 0,
    chunksWritten = 0,
    errors = 0;
  const insStmt = db.prepare(
    `INSERT INTO vault_chunks (rel_path, chunk_idx, text, text_hash, embedding, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(rel_path, chunk_idx) DO UPDATE SET
       text=excluded.text,
       text_hash=excluded.text_hash,
       embedding=excluded.embedding,
       indexed_at=excluded.indexed_at`,
  );
  const seenHashStmt = db.prepare(
    `SELECT text_hash FROM vault_chunks WHERE rel_path = ? AND chunk_idx = ?`,
  );
  const purgeOver = db.prepare(
    `DELETE FROM vault_chunks WHERE rel_path = ? AND chunk_idx >= ?`,
  );

  for (const full of files) {
    try {
      const rel = full.slice(VAULT_ROOT.length + 1);
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        errors++;
        continue;
      }
      const chunks = chunkMarkdown(text);
      let changed = 0;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const hash = await sha256(chunk);
        const prev = seenHashStmt.get(rel, i) as any;
        if (prev?.text_hash === hash) continue;
        const vec = await embedPassage(chunk.slice(0, 2000));
        insStmt.run(
          rel,
          i,
          chunk,
          hash,
          float32ToBlob(vec),
          Math.floor(Date.now() / 1000),
        );
        changed++;
      }
      // Drop chunks that no longer exist (file got shorter).
      purgeOver.run(rel, chunks.length);
      if (changed > 0) {
        indexed++;
        chunksWritten += changed;
      } else {
        skipped++;
      }
      onProgress?.({
        file: rel,
        chunks: chunks.length,
        total_files: files.length,
        indexed,
      });
    } catch (e) {
      console.error("[vault_index]", e);
      errors++;
    }
  }
  return {
    total_files: files.length,
    indexed,
    skipped,
    chunks_written: chunksWritten,
    errors,
  };
}

export async function vaultSearchSemantic(
  query: string,
  top = 5,
): Promise<any[]> {
  const db = getDb();
  let qVec: Float32Array | null = null;
  try {
    qVec = await embedQuery(query);
  } catch {
    return []; // caller can fall back to keyword search
  }
  const rows = db
    .prepare(
      `SELECT rel_path, chunk_idx, text, embedding FROM vault_chunks WHERE embedding IS NOT NULL`,
    )
    .all() as Array<any>;
  return rows
    .map((r) => {
      const v = blobToFloat32(r.embedding as Buffer);
      return { row: r, score: cosine(qVec!, v) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, top)
    .map((s) => ({
      file: s.row.rel_path,
      chunk_idx: s.row.chunk_idx,
      snippet: String(s.row.text).slice(0, 400),
      score: Number(s.score.toFixed(4)),
    }));
}

// ============================================================
// task_log
// ============================================================

export function taskAdd(skill: string, args?: any): { id: number } {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const r = db
    .prepare(
      `INSERT INTO task_log (skill, args, status, created_at) VALUES (?, ?, 'queued', ?)`,
    )
    .run(skill, args ? JSON.stringify(args) : null, now);
  return { id: Number(r.lastInsertRowid) };
}

export function taskList(period = "today", status?: string): any[] {
  const db = getDb();
  const { from, to } = periodRange(period);
  const filter = status ? `AND status = ?` : "";
  const stmt = db.prepare(
    `SELECT id, skill, args, status, result, created_at, started_at, finished_at
     FROM task_log
     WHERE created_at BETWEEN ? AND ? ${filter}
     ORDER BY created_at DESC LIMIT 100`,
  );
  const params: any[] = status ? [from, to, status] : [from, to];
  return stmt.all(...params) as any[];
}

// ============================================================
// revenue_ledger — income events (RUB)
// ============================================================

export function revenueAdd(
  amount: number,
  source?: string,
  note?: string,
  currency = "RUB",
): { id: number } {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const r = db
    .prepare(
      `INSERT INTO revenue_ledger (ts, amount, currency, source, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(now, amount, currency, source ?? null, note ?? null, now);
  return { id: Number(r.lastInsertRowid) };
}

export function revenueSummary(period = "month"): {
  period: string;
  currency: string;
  total: number;
  count: number;
  by_source: Array<{ source: string; total: number }>;
} {
  const db = getDb();
  const { from, to } = periodRange(period);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM revenue_ledger WHERE ts BETWEEN ? AND ?`,
    )
    .get(from, to) as any;
  const bySource = db
    .prepare(
      `SELECT COALESCE(source, 'unknown') AS source, SUM(amount) AS total
       FROM revenue_ledger WHERE ts BETWEEN ? AND ?
       GROUP BY source ORDER BY total DESC`,
    )
    .all(from, to) as Array<any>;
  return {
    period,
    currency: "RUB",
    total: Number(row?.total ?? 0),
    count: Number(row?.count ?? 0),
    by_source: bySource.map((s) => ({
      source: String(s.source),
      total: Number(s.total),
    })),
  };
}

// ============================================================
// skill_registry
// ============================================================

export function skillUpsert(row: {
  name: string;
  version: string;
  path: string;
  enabled: number;
  source: string;
  manifest?: any;
}): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO skill_registry (name, version, path, enabled, source, installed_at, manifest)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       version=excluded.version,
       path=excluded.path,
       manifest=excluded.manifest`,
  ).run(
    row.name,
    row.version,
    row.path,
    row.enabled,
    row.source,
    now,
    row.manifest ? JSON.stringify(row.manifest) : null,
  );
}

export function skillsList(enabledOnly = true): any[] {
  const db = getDb();
  const where = enabledOnly ? `WHERE enabled = 1` : ``;
  return db
    .prepare(
      `SELECT name, version, path, enabled, source, installed_at, manifest
       FROM skill_registry ${where} ORDER BY name`,
    )
    .all() as any[];
}

// ============================================================
// agent_registry
// ============================================================

export function agentUpsert(row: {
  name: string;
  url: string;
  host: string;
  auth_token_env?: string;
  enabled?: number;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_registry (name, url, host, auth_token_env, enabled)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       url=excluded.url,
       host=excluded.host,
       auth_token_env=excluded.auth_token_env,
       enabled=excluded.enabled`,
  ).run(
    row.name,
    row.url,
    row.host,
    row.auth_token_env ?? null,
    row.enabled ?? 1,
  );
}

export function agentGet(name: string): any | null {
  const db = getDb();
  return (
    (db
      .prepare(
        `SELECT name, url, host, auth_token_env, enabled, last_seen, status
         FROM agent_registry WHERE name = ?`,
      )
      .get(name) as any) ?? null
  );
}

export function agentTouch(name: string, status: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE agent_registry SET last_seen = ?, status = ? WHERE name = ?`,
  ).run(Math.floor(Date.now() / 1000), status, name);
}

export function agentList(): any[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT name, url, host, auth_token_env, enabled, last_seen, status
       FROM agent_registry ORDER BY name`,
    )
    .all() as any[];
}

// ============================================================
// Helpers
// ============================================================

function periodRange(period: string): { from: number; to: number } {
  const now = new Date();
  const startOfDay = (d: Date) => {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return Math.floor(c.getTime() / 1000);
  };
  const endOfDay = (d: Date) => {
    const c = new Date(d);
    c.setHours(23, 59, 59, 999);
    return Math.floor(c.getTime() / 1000);
  };
  switch (period) {
    case "yesterday": {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case "week": {
      const w = new Date(now);
      w.setDate(w.getDate() - 7);
      return { from: startOfDay(w), to: endOfDay(now) };
    }
    case "month": {
      const m = new Date(now);
      m.setDate(m.getDate() - 30);
      return { from: startOfDay(m), to: endOfDay(now) };
    }
    case "today":
    default:
      return { from: startOfDay(now), to: endOfDay(now) };
  }
}
