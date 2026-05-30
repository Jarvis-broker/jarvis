// A2 memory layer — SQLite + sqlite-vec.
//
// Schema:
//   memory(id TEXT PK, text, type_, source, hash, tags, created_at)
//   memory_vec USING vec0(id TEXT PK, vector FLOAT[1024])  -- KNN
//   memory_fts USING fts5(id, text, type_, source, tokenize='unicode61')  -- BM25
//
// Receives pre-computed embedding vectors (Float32[1024]) from the webview
// (TS @huggingface/transformers e5-large) and handles all storage + search.

use std::sync::{Mutex, OnceLock};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

pub const VECTOR_DIM: usize = 1024;

// ===== Connection (singleton) =====

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();

fn db_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = std::path::PathBuf::from(home).join("Code/Obsidian");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("memory.db"))
}

fn obsidian_root() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(std::path::PathBuf::from(home).join("Code/Obsidian"))
}

fn ensure_db<'a>() -> Result<std::sync::MutexGuard<'a, Connection>, String> {
    let m = DB.get_or_init(|| {
        // Register sqlite-vec as an auto-extension before any Connection::open.
        unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
        let path = db_path().expect("db_path");
        let conn = Connection::open(path).expect("open sqlite");
        init_schema(&conn).expect("init schema");
        Mutex::new(conn)
    });
    m.lock().map_err(|e| e.to_string())
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(&format!(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE IF NOT EXISTS memory (
            id          TEXT PRIMARY KEY,
            text        TEXT NOT NULL,
            type_       TEXT NOT NULL,
            source      TEXT NOT NULL DEFAULT '',
            hash        TEXT NOT NULL DEFAULT '',
            tags        TEXT NOT NULL DEFAULT '',
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type_);
        CREATE INDEX IF NOT EXISTS idx_memory_source ON memory(source);

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
            id     TEXT PRIMARY KEY,
            vector FLOAT[{dim}]
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            id UNINDEXED,
            text,
            type_ UNINDEXED,
            source UNINDEXED,
            tokenize = 'unicode61 remove_diacritics 2'
        );
        ",
        dim = VECTOR_DIM
    ))
    .map_err(|e| format!("init schema: {}", e))
}

// ===== Helpers =====

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

fn vec_to_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

// ===== Types =====

#[derive(Debug, Deserialize)]
pub struct UpsertRow {
    pub text: String,
    pub vector: Vec<f32>,
    pub type_: String,
    pub source: String,
    pub hash: String,
    pub tags: String,
}

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub id: String,
    pub text: String,
    pub type_: String,
    pub source: String,
    pub tags: String,
    pub score: f32,
}

#[derive(Debug, Serialize)]
pub struct VaultFile {
    pub path: String,
    pub content: String,
    pub hash: String,
}

// ===== Tauri commands =====

#[tauri::command]
pub fn mem_upsert(rows: Vec<UpsertRow>) -> Result<JsonValue, String> {
    if rows.is_empty() {
        return Ok(json!({ "inserted": 0 }));
    }
    let mut conn = ensure_db()?;
    let now = now_millis();
    let mut first_id = String::new();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for row in &rows {
        if row.vector.len() != VECTOR_DIM {
            return Err(format!(
                "vector dim {} != {}",
                row.vector.len(),
                VECTOR_DIM
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        if first_id.is_empty() {
            first_id = id.clone();
        }
        let bytes = vec_to_bytes(&row.vector);
        tx.execute(
            "INSERT INTO memory(id, text, type_, source, hash, tags, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, row.text, row.type_, row.source, row.hash, row.tags, now],
        )
        .map_err(|e| format!("insert memory: {}", e))?;
        tx.execute(
            "INSERT INTO memory_vec(id, vector) VALUES (?1, ?2)",
            params![id, bytes],
        )
        .map_err(|e| format!("insert memory_vec: {}", e))?;
        tx.execute(
            "INSERT INTO memory_fts(id, text, type_, source) VALUES (?1, ?2, ?3, ?4)",
            params![id, row.text, row.type_, row.source],
        )
        .map_err(|e| format!("insert memory_fts: {}", e))?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({ "inserted": rows.len(), "id": first_id }))
}

#[tauri::command]
pub fn mem_search(
    vector: Vec<f32>,
    type_filter: Option<String>,
    top: u32,
) -> Result<Vec<SearchHit>, String> {
    if vector.len() != VECTOR_DIM {
        return Err(format!("vector dim {} != {}", vector.len(), VECTOR_DIM));
    }
    let conn = ensure_db()?;
    let bytes = vec_to_bytes(&vector);
    let k = top.max(1) as i64;

    // Pull more from vec table than requested so we can post-filter by type
    // (sqlite-vec MATCH joined with regular WHERE on memory table works, but
    //  putting filter inside KNN scope is cleaner via candidates approach).
    let mut stmt = conn
        .prepare(
            "
        SELECT m.id, m.text, m.type_, m.source, m.tags, v.distance
        FROM memory_vec v
        JOIN memory m ON m.id = v.id
        WHERE v.vector MATCH ?1 AND k = ?2
          AND (?3 IS NULL OR m.type_ = ?3)
        ORDER BY v.distance
        LIMIT ?4
        ",
        )
        .map_err(|e| format!("prepare: {}", e))?;

    let tf: Option<String> = type_filter.filter(|s| !s.is_empty());
    let rows = stmt
        .query_map(params![bytes, k, tf, k], |r| {
            Ok(SearchHit {
                id: r.get(0)?,
                text: r.get(1)?,
                type_: r.get(2)?,
                source: r.get(3)?,
                tags: r.get(4)?,
                score: r.get::<_, f64>(5)? as f32,
            })
        })
        .map_err(|e| format!("query: {}", e))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn mem_forget(id: String) -> Result<JsonValue, String> {
    let conn = ensure_db()?;
    let n1 = conn
        .execute("DELETE FROM memory WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    let _ = conn.execute("DELETE FROM memory_vec WHERE id = ?1", params![id]);
    let _ = conn.execute("DELETE FROM memory_fts WHERE id = ?1", params![id]);
    Ok(json!({ "deleted": n1 > 0, "id": id }))
}

#[tauri::command]
pub fn mem_forget_source(source: String) -> Result<JsonValue, String> {
    let conn = ensure_db()?;
    // Collect ids first so we can clean associated vec/fts rows
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM memory WHERE source = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![source], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for id in &ids {
        let _ = conn.execute("DELETE FROM memory_vec WHERE id = ?1", params![id]);
        let _ = conn.execute("DELETE FROM memory_fts WHERE id = ?1", params![id]);
    }
    conn.execute("DELETE FROM memory WHERE source = ?1", params![source])
        .map_err(|e| e.to_string())?;
    Ok(json!({ "deleted_source": source, "rows": ids.len() }))
}

#[tauri::command]
pub fn mem_stats() -> Result<JsonValue, String> {
    let conn = ensure_db()?;
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut by_type = serde_json::Map::new();
    {
        let mut stmt = conn
            .prepare("SELECT type_, COUNT(*) FROM memory GROUP BY type_")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?;
        for r in rows {
            let (t, c) = r.map_err(|e| e.to_string())?;
            by_type.insert(t, JsonValue::Number(c.into()));
        }
    }
    Ok(json!({
        "total_rows": total,
        "by_type": by_type,
        "dim": VECTOR_DIM,
        "db_path": db_path().ok().map(|p| p.to_string_lossy().to_string()),
    }))
}

// ===== Vault walking =====

#[tauri::command]
pub fn mem_walk_vault() -> Result<Vec<VaultFile>, String> {
    let vault = obsidian_root()?;
    let mut out = Vec::new();
    for entry in WalkDir::new(&vault).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let path_str = path.to_string_lossy();
        // Skip our own db / venv / lance-db / chroma artifacts
        if path_str.contains("/memory.db")
            || path_str.contains("/.venv-memory/")
            || path_str.contains("/.lance_db/")
            || path_str.contains("/.chroma_db/")
        {
            continue;
        }
        if path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            != Some("md".to_string())
        {
            continue;
        }
        let rel = path
            .strip_prefix(&vault)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path_str.to_string());
        let content = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let hash = sha256_hex(&content);
        out.push(VaultFile {
            path: rel,
            content,
            hash,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn mem_vault_hashes() -> Result<JsonValue, String> {
    let conn = ensure_db()?;
    let mut stmt = conn
        .prepare("SELECT DISTINCT source, hash FROM memory WHERE type_ = 'vault'")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut map = serde_json::Map::new();
    for r in rows {
        let (s, h) = r.map_err(|e| e.to_string())?;
        if !s.is_empty() {
            map.insert(s, JsonValue::String(h));
        }
    }
    Ok(JsonValue::Object(map))
}

// ===== Optional FTS (BM25) search — can be wired later for hybrid =====

#[tauri::command]
pub fn mem_fts_search(
    query: String,
    type_filter: Option<String>,
    top: u32,
) -> Result<Vec<SearchHit>, String> {
    let conn = ensure_db()?;
    let tf: Option<String> = type_filter.filter(|s| !s.is_empty());
    let mut stmt = conn
        .prepare(
            "
        SELECT m.id, m.text, m.type_, m.source, m.tags, bm25(memory_fts) AS score
        FROM memory_fts
        JOIN memory m ON m.id = memory_fts.id
        WHERE memory_fts MATCH ?1
          AND (?2 IS NULL OR m.type_ = ?2)
        ORDER BY score
        LIMIT ?3
        ",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![query, tf, top as i64], |r| {
            Ok(SearchHit {
                id: r.get(0)?,
                text: r.get(1)?,
                type_: r.get(2)?,
                source: r.get(3)?,
                tags: r.get(4)?,
                score: r.get::<_, f64>(5)? as f32,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}
