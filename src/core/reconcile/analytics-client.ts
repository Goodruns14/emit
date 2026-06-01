import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import type { AnalyticsEvent, AnalyticsMcpConfig } from "../../types/index.js";
import { parseEventsFile } from "../import/parse.js";

const require = createRequire(import.meta.url);
const pkg = require("../../../package.json") as { version: string };

/**
 * Thrown for any analytics-source failure (spawn, timeout, non-JSON, unexpected
 * shape). `emit reconcile` catches it, prints a clear message, and exits
 * non-zero — it never crashes the process.
 */
export class AnalyticsClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsClientError";
  }
}

const DEFAULT_TOOL = "list_events";
const DEFAULT_TIMEOUT_MS = 30_000;

// ── Reference contract for the external analytics MCP ──────────────────────────
//
// emit does NOT build the analytics MCP. It calls a configurable "list events"
// tool (default `list_events`; vendors differ — Mixpanel `Get-Events`, PostHog
// `event-definitions-list`, Amplitude taxonomy/category-based) and parses the
// result defensively, because none of these vendors documents a stable JSON
// shape. Accepted response shapes (see parseAnalyticsResponse):
//   - MCP tool result { content: [{ type: "text", text: "<JSON>" }] }
//   - or structuredContent, or a value passed directly (for tests)
//   - unwrapped to an array via a bare array, or { events | results | data |
//     event_definitions: [...] } (PostHog-style `results` pagination wrapper)
//   - each event: name (or event / event_name) required; properties (or
//     property_names / props, as string[] | {name}[] | object keys) optional;
//     original_name (or renamed_from / code_name) optional.
// NOTE: pagination beyond the first page (following a `next` cursor) is a
// follow-up — v1 reads the first response's array.

/** Defensive parse of an analytics MCP tool result into AnalyticsEvent[]. Exported for unit testing. */
export function parseAnalyticsResponse(res: unknown): AnalyticsEvent[] {
  const payload = extractJsonPayload(res);
  const arr = unwrapArray(payload);
  const events: AnalyticsEvent[] = [];
  for (const item of arr) {
    const ev = toAnalyticsEvent(item);
    if (ev) events.push(ev);
  }
  if (arr.length > 0 && events.length === 0) {
    throw new AnalyticsClientError(
      "Analytics feed returned items but none had a recognizable event name " +
        "(expected `name`, or `event` / `event_name`)."
    );
  }
  return events;
}

function extractJsonPayload(res: unknown): unknown {
  if (res && typeof res === "object") {
    const o = res as Record<string, unknown>;
    // MCP tool result: { content: [{ type: "text", text: "<json>" }] }
    if (Array.isArray(o.content)) {
      const textItem = (o.content as Array<Record<string, unknown>>).find(
        (c) => c && typeof c.text === "string"
      );
      if (textItem && typeof textItem.text === "string") {
        try {
          return JSON.parse(textItem.text);
        } catch {
          throw new AnalyticsClientError(
            "Analytics MCP returned non-JSON text content; expected a JSON list of events."
          );
        }
      }
    }
    // Some servers return already-parsed JSON.
    if (o.structuredContent !== undefined) return o.structuredContent;
  }
  return res;
}

function unwrapArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of ["events", "results", "data", "event_definitions"]) {
      const v = (payload as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v;
    }
  }
  throw new AnalyticsClientError(
    "Could not find an events array in the analytics feed (expected a JSON array, " +
      "or an object with an `events` / `results` / `data` array)."
  );
}

function toAnalyticsEvent(item: unknown): AnalyticsEvent | null {
  if (typeof item === "string") return item.trim() ? { name: item } : null;
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const name = firstString(o.name, o.event, o.event_name);
  if (!name) return null;
  const properties = extractProperties(o.properties ?? o.property_names ?? o.props);
  const original_name = firstString(o.original_name, o.renamed_from, o.code_name);
  return {
    name,
    ...(properties && properties.length ? { properties } : {}),
    ...(original_name ? { original_name } : {}),
  };
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v;
  return undefined;
}

function extractProperties(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const names = v
      .map((p) =>
        typeof p === "string"
          ? p
          : p && typeof p === "object"
            ? firstString((p as Record<string, unknown>).name, (p as Record<string, unknown>).key)
            : undefined
      )
      .filter((x): x is string => !!x);
    return names.length ? names : undefined;
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v as object);
    return keys.length ? keys : undefined;
  }
  return undefined;
}

// ── Sources ────────────────────────────────────────────────────────────────

/** Connect to the analytics MCP over stdio, call its list-events tool, parse, disconnect. Fail-soft. */
export async function fetchAnalyticsEventsFromMcp(
  cfg: AnalyticsMcpConfig
): Promise<AnalyticsEvent[]> {
  if (!cfg.command || !cfg.command.trim()) {
    throw new AnalyticsClientError("analytics_mcp.command is required to reach the analytics MCP.");
  }
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") baseEnv[k] = v;

  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: { ...baseEnv, ...(cfg.env ?? {}) },
  });
  const client = new Client({ name: "emit-reconcile", version: pkg.version });
  const toolName = cfg.tool_name ?? DEFAULT_TOOL;

  try {
    await withTimeout(client.connect(transport), DEFAULT_TIMEOUT_MS, "connect to the analytics MCP");
    const res = await withTimeout(
      client.callTool({ name: toolName, arguments: cfg.tool_args ?? {} }),
      DEFAULT_TIMEOUT_MS,
      `call the "${toolName}" tool`
    );
    if (res && typeof res === "object" && (res as Record<string, unknown>).isError) {
      throw new AnalyticsClientError(`Analytics MCP tool "${toolName}" returned an error result.`);
    }
    return parseAnalyticsResponse(res);
  } catch (err) {
    if (err instanceof AnalyticsClientError) throw err;
    throw new AnalyticsClientError(
      `Could not reach the analytics MCP via \`${cfg.command}\`: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    await client.close().catch(() => {});
  }
}

/** Read analytics event names from a CSV/TSV/JSON export (reuses the import parser). Names only — no properties. */
export function fetchAnalyticsEventsFromCsv(csvPath: string, column?: string): AnalyticsEvent[] {
  try {
    const result = parseEventsFile(csvPath, column ? { column } : undefined);
    return result.events.map((name) => ({ name }));
  } catch (err) {
    throw new AnalyticsClientError(
      `Could not read analytics events from "${csvPath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AnalyticsClientError(`Timed out (${ms}ms) trying to ${what}.`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
