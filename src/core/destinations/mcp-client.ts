import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../../package.json") as { version: string };

export interface DestinationMcpClientOptions {
  command: string[];
  env?: Record<string, string>;
}

/**
 * Thin wrapper around `@modelcontextprotocol/sdk` for talking to a
 * destination's own MCP server (e.g. a community BigQuery MCP).
 *
 * Spawns the destination MCP as a stdio subprocess via `StdioClientTransport`
 * and exposes a single `callTool()` entry point. Destination MCPs handle their
 * own authentication — emit never holds destination credentials.
 *
 * Stderr from the spawned subprocess is piped into emit's stderr so users see
 * any auth/config errors the destination MCP emits.
 */
export class DestinationMcpClient {
  private client?: Client;
  private transport?: StdioClientTransport;

  async connect(opts: DestinationMcpClientOptions): Promise<void> {
    if (!opts.command || opts.command.length === 0) {
      throw new Error("DestinationMcpClient: command must be a non-empty array");
    }
    const [executable, ...args] = opts.command;

    // Inherit emit's full env so users' destination-MCP credentials
    // (GOOGLE_APPLICATION_CREDENTIALS, BIGQUERY_*, etc.) make it through.
    // The SDK's getDefaultEnvironment() is too restrictive for this.
    const childEnv = { ...sanitizedEnv(), ...(opts.env ?? {}) };

    this.transport = new StdioClientTransport({
      command: executable,
      args,
      env: childEnv,
      // Pipe child stderr into emit's stderr so auth/config errors are visible
      // without polluting the MCP-protocol stdout stream.
      stderr: "pipe",
    });

    this.client = new Client({ name: "emit", version: pkg.version }, { capabilities: {} });
    await this.client.connect(this.transport);

    // Forward child stderr to emit's stderr after start.
    const stderr = this.transport.stderr;
    if (stderr) {
      stderr.on("data", (chunk: Buffer | string) => {
        process.stderr.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      });
    }
  }

  /**
   * Invoke a tool on the destination MCP and return the parsed result.
   *
   * MCP tool responses are an array of content items. We collect the text
   * content and try to parse it as JSON (most query-passthrough tools return
   * JSON rows). If parsing fails, we return the raw concatenated text — the
   * caller can decide what to do with it.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) {
      throw new Error("DestinationMcpClient.callTool called before connect()");
    }
    const result = (await this.client.callTool({ name, arguments: args })) as Record<
      string,
      unknown
    >;
    if (result.isError) {
      const errText = collectText(result);
      throw new Error(
        `Destination MCP tool "${name}" returned error: ${errText || "(no error text)"}`,
      );
    }
    // Some MCPs return structured content directly — prefer that when present.
    if (result.structuredContent !== undefined) {
      return result.structuredContent;
    }
    const text = collectText(result);
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // ignore — we're shutting down
    }
    this.client = undefined;
    this.transport = undefined;
  }
}

function collectText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as { content?: unknown };
  if (!Array.isArray(r.content)) return "";
  const parts: string[] = [];
  for (const c of r.content) {
    if (c && typeof c === "object") {
      const item = c as { type?: unknown; text?: unknown };
      if (item.type === "text" && typeof item.text === "string") {
        parts.push(item.text);
      }
    }
  }
  return parts.join("");
}

/**
 * Subset of process.env safe to forward into a spawned destination MCP. The
 * SDK's default-inherited list is conservative; we widen it slightly so users'
 * destination-MCP credentials (typically in env vars like
 * GOOGLE_APPLICATION_CREDENTIALS, BIGQUERY_*, etc.) make it through.
 */
function sanitizedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
