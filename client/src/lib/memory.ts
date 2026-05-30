/**
 * A2 memory layer — embeddings in webview (WASM via @huggingface/transformers),
 * vector store via Tauri Rust commands (LanceDB native crate).
 *
 * Flow:
 *   save(text, tags?)  → embed("passage:" + text) → invoke("mem_upsert", { rows })
 *   recall(query, top) → embed("query:" + query) → invoke("mem_search", { vector, top, type_filter:"memory" })
 *   searchVault / searchAll — same shape, different type filter
 *   indexVault()       → invoke("mem_walk_vault") → chunk each .md → batch embed → invoke("mem_upsert")
 */
import { invoke } from "@tauri-apps/api/core";
import {
  pipeline,
  env,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

const MODEL_ID = "Xenova/multilingual-e5-large";
const VECTOR_DIM = 1024;
const CHUNK_MAX_CHARS = 800;

// Configure transformers.js: remote-only (no local models), use IndexedDB cache
env.allowLocalModels = false;
env.useBrowserCache = true;

// ----- Pipeline (lazy singleton) + progress reporting -----

let _pipe: FeatureExtractionPipeline | null = null;
let _loading: Promise<FeatureExtractionPipeline> | null = null;

export type ModelEvent =
  | { kind: "downloading"; file: string; progress: number; bytesLoaded?: number; bytesTotal?: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

let _onEvent: ((e: ModelEvent) => void) | null = null;

/** Register a callback to receive download/ready/error events. */
export function onModelEvent(cb: (e: ModelEvent) => void) {
  _onEvent = cb;
}

export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (_pipe) return _pipe;
  if (!_loading) {
    _loading = (pipeline("feature-extraction", MODEL_ID, {
      // quantized variant: ~280MB ONNX into IndexedDB on first run
      dtype: "q8",
      progress_callback: (data: any) => {
        // transformers.js emits: initiate, download, progress, done, ready
        try {
          if (
            data?.status === "progress" &&
            typeof data?.progress === "number"
          ) {
            _onEvent?.({
              kind: "downloading",
              file: String(data.file ?? ""),
              progress: Number(data.progress),
              bytesLoaded: data.loaded,
              bytesTotal: data.total,
            });
          } else if (data?.status === "done") {
            _onEvent?.({
              kind: "downloading",
              file: String(data.file ?? ""),
              progress: 100,
            });
          } else if (data?.status === "ready") {
            _onEvent?.({ kind: "ready" });
          }
        } catch (e) {
          /* ignore listener errors */
        }
      },
    }) as unknown) as Promise<FeatureExtractionPipeline>;
    _loading.catch((err) => {
      _onEvent?.({ kind: "error", message: String(err?.message ?? err) });
    });
  }
  _pipe = await _loading;
  return _pipe;
}

/** Pre-warm the model on app start so the first user call isn't slow. */
export async function preloadModel(): Promise<void> {
  await getEmbedder();
}

async function embed(
  text: string,
  role: "query" | "passage",
): Promise<number[]> {
  const pipe = await getEmbedder();
  const prefixed = `${role}: ${text}`;
  const output = await pipe(prefixed, { pooling: "mean", normalize: true });
  // output.data is a Float32Array of length VECTOR_DIM
  return Array.from(output.data as Float32Array);
}

// ----- Public API -----

export interface MemoryRow {
  text: string;
  vector: number[];
  type_: "vault" | "memory" | "conversation";
  source: string;
  hash: string;
  tags: string;
}

export interface SearchResult {
  id: string;
  text: string;
  type_: string;
  source: string;
  tags: string;
  score: number;
}

/** Save a long-term memory item (persists across sessions). */
export async function save(text: string, tags = ""): Promise<{ id: string }> {
  const vector = await embed(text, "passage");
  return await invoke<{ id: string }>("mem_upsert", {
    rows: [
      {
        text,
        vector,
        type_: "memory",
        source: "",
        hash: "",
        tags,
      },
    ],
  });
}

/** Recall from the long-term memory store only. */
export async function recall(
  query: string,
  top = 8,
): Promise<SearchResult[]> {
  const vector = await embed(query, "query");
  return await invoke<SearchResult[]>("mem_search", {
    vector,
    type_filter: "memory",
    top,
  });
}

/** Search the Obsidian vault only. */
export async function searchVault(
  query: string,
  top = 5,
): Promise<SearchResult[]> {
  const vector = await embed(query, "query");
  return await invoke<SearchResult[]>("mem_search", {
    vector,
    type_filter: "vault",
    top,
  });
}

/** Search vault + memory + conversation together. */
export async function searchAll(
  query: string,
  top = 10,
): Promise<SearchResult[]> {
  const vector = await embed(query, "query");
  return await invoke<SearchResult[]>("mem_search", {
    vector,
    type_filter: null,
    top,
  });
}

/** Delete one memory by id. */
export async function forget(id: string): Promise<{ deleted: boolean }> {
  return await invoke<{ deleted: boolean }>("mem_forget", { id });
}

/** Aggregated counters: rows per type, db path, dimension. */
export async function stats(): Promise<{
  total_rows: number;
  by_type: Record<string, number>;
  db_path: string;
  dim: number;
}> {
  return await invoke("mem_stats", {});
}

// ----- Vault indexing (TS-side orchestration) -----

interface VaultFile {
  path: string; // relative to vault
  content: string;
  hash: string; // sha256 hex
}

function chunkText(text: string, maxChars = CHUNK_MAX_CHARS): string[] {
  // Strip YAML frontmatter
  text = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  // Strip Obsidian callout headers/markers
  text = text.replace(/^> \[![\s\S]*?\]\+.*$/gm, "");
  text = text.replace(/^> ?/gm, "");
  // Collapse extra blank lines
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let current = "";
  for (const para of text.split("\n\n")) {
    if (current.length + para.length > maxChars && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export interface IndexProgress {
  total: number;
  indexed: number;
  skipped: number;
  chunks: number;
  errors: number;
}

/**
 * Walk the Obsidian vault, chunk each .md, embed every chunk, upsert into LanceDB.
 * Skips files whose hash matches what's already stored.
 */
export async function indexVault(
  onProgress?: (p: IndexProgress) => void,
): Promise<IndexProgress> {
  const files = await invoke<VaultFile[]>("mem_walk_vault", {});
  const existing = await invoke<Record<string, string>>(
    "mem_vault_hashes",
    {},
  );

  const progress: IndexProgress = {
    total: files.length,
    indexed: 0,
    skipped: 0,
    chunks: 0,
    errors: 0,
  };

  for (const file of files) {
    try {
      if (existing[file.path] === file.hash) {
        progress.skipped++;
        onProgress?.(progress);
        continue;
      }
      // Hash changed — clear old chunks for this source first
      if (existing[file.path]) {
        await invoke("mem_forget_source", { source: file.path });
      }

      const parts = chunkText(file.content);
      if (parts.length === 0) {
        progress.indexed++;
        onProgress?.(progress);
        continue;
      }

      // Embed sequentially to keep memory low. Could batch with Promise.all
      // but transformers.js doesn't truly parallelise across awaits in WASM.
      const rows: MemoryRow[] = [];
      for (const text of parts) {
        const vector = await embed(text, "passage");
        rows.push({
          text,
          vector,
          type_: "vault",
          source: file.path,
          hash: file.hash,
          tags: "",
        });
      }
      await invoke("mem_upsert", { rows });
      progress.indexed++;
      progress.chunks += parts.length;
      onProgress?.(progress);
    } catch (e) {
      console.error(`indexVault: failed on ${file.path}`, e);
      progress.errors++;
      onProgress?.(progress);
    }
  }
  return progress;
}

// ----- Misc -----

export const MEMORY_VECTOR_DIM = VECTOR_DIM;
export const MEMORY_MODEL = MODEL_ID;
