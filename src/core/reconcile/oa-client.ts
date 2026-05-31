import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { OaMcpConfig } from "../../types/index.js";
import type { OaEvent } from "./index.js";

/**
 * Fetch the event list from the external analytics-source (OA) MCP. emit acts as the MCP
 * client. Isolated here so the coupling to the OA MCP's protocol/shape stays in one file;
 * the caller (reconcile command) decides how to handle failures (fail-soft with a warning).
 */
export async function fetchOaEvents(cfg: OaMcpConfig): Promise<OaEvent[]> {
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
  });
  const client = new Client(
    { name: "emit-reconcile", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: cfg.list_tool ?? "list_events",
      arguments: {},
    });
    return parseOaEvents(result, cfg);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Normalize an OA MCP tool result into `OaEvent[]`. Tolerant of common shapes:
 * a bare JSON array, `{ events: [...] }`, `{ results: [...] }`, or the first array-valued
 * property. Field names are config-driven (`name_field` etc.) since feeds differ.
 *
 * Exported for testing.
 */
export function parseOaEvents(result: unknown, cfg: OaMcpConfig): OaEvent[] {
  const nameField = cfg.name_field ?? "name";
  const originalField = cfg.original_name_field;
  const propsField = cfg.properties_field;

  const text = extractText(result);
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const arr = findEventArray(parsed);
  if (!arr) return [];

  const events: OaEvent[] = [];
  for (const raw of arr) {
    if (raw == null) continue;
    if (typeof raw === "string") {
      events.push({ name: raw });
      continue;
    }
    if (typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const name = obj[nameField];
    if (typeof name !== "string" || !name) continue;
    const ev: OaEvent = { name };
    if (originalField && typeof obj[originalField] === "string") {
      ev.original_name = obj[originalField] as string;
    }
    if (propsField && Array.isArray(obj[propsField])) {
      ev.properties = (obj[propsField] as unknown[]).map(String);
    }
    events.push(ev);
  }
  return events;
}

function extractText(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
      const t = (item as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function findEventArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.events)) return obj.events;
    if (Array.isArray(obj.results)) return obj.results;
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) return v;
    }
  }
  return null;
}
