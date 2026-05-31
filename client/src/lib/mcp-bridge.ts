/**
 * MCP Bridge — connects the frontend to the Rust McpHost.
 *
 * Responsibilities:
 *   1. Fetch MCP tool declarations from Rust → convert to Gemini format
 *   2. Call MCP tools by qualified name and normalize the result
 *   3. Merge MCP declarations with built-in TOOL_DECLARATIONS
 *
 * Phase 2: dynamic tool discovery. The frontend no longer has a
 * static-only tool set — MCP servers contribute tools at runtime.
 */
import { invoke } from "@tauri-apps/api/core";

// ──────────────────────────────────────────────────────────────
// Types matching the Rust structs in mcp_host.rs
// ──────────────────────────────────────────────────────────────

export interface McpTool {
  namespace: string;
  name: string;
  qualified_name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface McpContent {
  content_type: string; // "text" | "image" | "resource"
  text?: string;
  data?: string;
  mime_type?: string;
}

export interface McpToolResult {
  content: McpContent[];
  is_error: boolean;
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  tool_count: number;
  error?: string;
}

// ──────────────────────────────────────────────────────────────
// Gemini-compatible declaration format
// ──────────────────────────────────────────────────────────────

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

// ──────────────────────────────────────────────────────────────
// Fetch MCP tools from Rust
// ──────────────────────────────────────────────────────────────

/**
 * Ask the Rust McpHost for all currently connected tools.
 * Returns an empty array on error (non-fatal — the app works without MCP).
 */
export async function fetchMcpTools(): Promise<McpTool[]> {
  try {
    return (await invoke("mcp_list_tools")) as McpTool[];
  } catch (e) {
    console.warn("[mcp-bridge] mcp_list_tools failed, continuing without MCP tools:", e);
    return [];
  }
}

/**
 * Get connection status of all configured MCP servers.
 */
export async function fetchMcpStatus(): Promise<McpServerStatus[]> {
  try {
    return (await invoke("mcp_status")) as McpServerStatus[];
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────
// Convert MCP tool → Gemini function declaration
// ──────────────────────────────────────────────────────────────

/**
 * Converts an MCP tool's JSON Schema `input_schema` into Gemini's
 * `parameters` format.  MCP uses standard JSON Schema; Gemini expects
 * a subset (type, properties, required).  We pass it through mostly
 * verbatim — Gemini handles the common subset fine.
 *
 * The tool name is the qualified `namespace.tool_name` so it won't
 * collide with hardcoded built-in declarations.
 */
function mcpToolToGemini(tool: McpTool): GeminiFunctionDeclaration {
  // Build a clean parameters object from the MCP input_schema.
  // MCP tools may have an empty schema (no arguments), in which case
  // Gemini still needs `{ type: "object", properties: {} }`.
  const schema = tool.input_schema ?? {};
  const parameters: Record<string, any> = {
    type: schema.type ?? "object",
    properties: schema.properties ?? {},
  };
  if (schema.required && Array.isArray(schema.required)) {
    parameters.required = schema.required;
  }

  // Gemini doesn't support `additionalProperties` — strip it.
  delete parameters.additionalProperties;

  // Prefix description with the server namespace for clarity.
  const desc = `[MCP: ${tool.namespace}] ${tool.description}`;

  return {
    name: tool.qualified_name,
    description: desc,
    parameters,
  };
}

/**
 * Fetch all MCP tools and convert them to Gemini function declarations.
 */
export async function getMcpDeclarations(): Promise<GeminiFunctionDeclaration[]> {
  const tools = await fetchMcpTools();
  return tools.map(mcpToolToGemini);
}

// ──────────────────────────────────────────────────────────────
// Call an MCP tool and normalize the result
// ──────────────────────────────────────────────────────────────

/**
 * Call a tool on an MCP server by its qualified name.
 * Returns a plain object suitable for Gemini's tool response.
 */
export async function callMcpTool(
  qualifiedName: string,
  args: Record<string, any>,
): Promise<Record<string, any>> {
  try {
    const result = (await invoke("mcp_call_tool", {
      qualifiedName,
      arguments: args,
    })) as McpToolResult;

    return normalizeMcpResult(result);
  } catch (e: any) {
    return { error: `MCP call failed: ${e?.message ?? e}` };
  }
}

/**
 * Flatten McpToolResult into a simple object for Gemini.
 * Gemini expects a JSON-serializable value as tool response;
 * MCP returns an array of content blocks.
 */
function normalizeMcpResult(result: McpToolResult): Record<string, any> {
  if (result.is_error) {
    const errorText = result.content
      .filter((c) => c.text)
      .map((c) => c.text)
      .join("\n");
    return { error: errorText || "MCP tool returned an error" };
  }

  // Single text block → return as { result: "..." }
  const textBlocks = result.content.filter((c) => c.content_type === "text" && c.text);
  if (textBlocks.length === 1) {
    // Try to parse as JSON — many tools return JSON strings.
    try {
      return JSON.parse(textBlocks[0].text!);
    } catch {
      return { result: textBlocks[0].text };
    }
  }

  // Multiple blocks or non-text → return structured
  if (textBlocks.length > 1) {
    return {
      results: textBlocks.map((c) => {
        try { return JSON.parse(c.text!); }
        catch { return c.text; }
      }),
    };
  }

  // Fallback: return the raw content array
  return { content: result.content };
}

// ──────────────────────────────────────────────────────────────
// Merge built-in + MCP declarations
// ──────────────────────────────────────────────────────────────

/**
 * Merge hardcoded built-in declarations with dynamically discovered MCP tools.
 * MCP tools use qualified names (e.g. `jarvis-mac.run_shell`) so there are no
 * collisions with built-in names (e.g. `run_shell`).
 */
export function mergeDeclarations(
  builtIn: GeminiFunctionDeclaration[],
  mcp: GeminiFunctionDeclaration[],
): GeminiFunctionDeclaration[] {
  // Build a set of built-in names for dedup safety.
  const builtInNames = new Set(builtIn.map((d) => d.name));

  // Filter out any MCP tool whose qualified_name somehow collides
  // with a built-in (shouldn't happen with namespace.tool format,
  // but safety first).
  const filtered = mcp.filter((d) => !builtInNames.has(d.name));

  return [...builtIn, ...filtered];
}
