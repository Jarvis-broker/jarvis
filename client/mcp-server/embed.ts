/**
 * Embedding helper for memory_recall + vault_search.
 *
 * Model: Xenova/multilingual-e5-small (384 dim, ~120MB, RU+EN OK on CPU).
 * Loaded once per MCP server process. Pin to ONNX runtime in Bun.
 *
 * E5 needs prefixes:
 *   - "query: <text>" when embedding queries
 *   - "passage: <text>" when embedding stored facts/chunks
 *
 * Storage: flat Float32 little-endian in SQLite BLOB columns.
 */

let pipelinePromise: Promise<any> | null = null;
const MODEL_ID =
  process.env.JARVIS_EMBED_MODEL ?? "Xenova/multilingual-e5-small";
export const EMBED_DIM = 384;

async function getPipeline(): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      // Dynamic import — transformers.js loads lazily so the MCP server
      // boots in <50ms instead of seconds, and we only download the model
      // when embeddings are actually used.
      const tf = await import("@huggingface/transformers");
      const { pipeline, env } = tf as any;
      // Allow remote download on first run, then cache locally.
      env.allowRemoteModels = true;
      env.allowLocalModels = true;
      return await pipeline("feature-extraction", MODEL_ID, {
        quantized: true,
        device: "cpu",
      });
    })();
  }
  return pipelinePromise;
}

export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const pipe = await getPipeline();
  const out: Float32Array[] = [];
  for (const t of texts) {
    const r = await pipe(t, { pooling: "mean", normalize: true });
    // r.data is a Float32Array of length EMBED_DIM
    out.push(new Float32Array(r.data));
  }
  return out;
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const r = await embed([`query: ${text.replace(/\s+/g, " ").trim()}`]);
  return r[0];
}

export async function embedPassage(text: string): Promise<Float32Array> {
  const r = await embed([`passage: ${text.replace(/\s+/g, " ").trim()}`]);
  return r[0];
}

// ---------- Serialisation to/from SQLite BLOB ----------

export function float32ToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function blobToFloat32(b: Buffer | Uint8Array): Float32Array {
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new Float32Array(ab);
}

// ---------- Cosine similarity (vectors are L2-normalised, so it's dot) ----------

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Preload model in background — call at MCP startup. */
export function warmup(): void {
  void getPipeline().catch((e) =>
    console.error("[embed] warmup failed:", e?.message ?? e),
  );
}
