import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Plan cache for `emit enrich`. Caches the LLM planner output for a
 * (destination_type, tool_surface, event_signature) triple under
 * `.emit/cache/enrich/<sha256>.json`. Hits skip the planner LLM call.
 *
 * Invalidation is implicit: the cache key includes a hash of the destination
 * MCP's tool surface AND the event's property list, so any change to either
 * produces a different key. No TTL by default — `--no-cache` forces fresh.
 */
export interface CachedPlan {
  calls: { tool: string; args: Record<string, unknown> }[];
  extractor_hint?: string;
}

export interface EnrichCacheOptions {
  /** Absolute path to the directory holding `.emit/cache/enrich/`. */
  rootDir: string;
}

export interface PlanKeyInputs {
  destinationType: string;
  toolsSignature: string;
  eventSignature: string;
}

export class EnrichCache {
  private dir: string;

  constructor(opts: EnrichCacheOptions) {
    this.dir = path.join(opts.rootDir, ".emit", "cache", "enrich");
  }

  static buildKey(inputs: PlanKeyInputs): string {
    const h = createHash("sha256");
    h.update("v1\n");
    h.update(`type:${inputs.destinationType}\n`);
    h.update(`tools:${inputs.toolsSignature}\n`);
    h.update(`event:${inputs.eventSignature}\n`);
    return h.digest("hex");
  }

  /**
   * Stable signature for an MCP tool surface. Sorts tools by name so client
   * registration order doesn't churn the key.
   */
  static toolsSignature(tools: { name: string; inputSchema?: unknown }[]): string {
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    return sorted
      .map((t) => `${t.name}:${JSON.stringify(t.inputSchema ?? null)}`)
      .join("|");
  }

  /**
   * Stable signature for an event from the catalog. Captures the inputs that
   * affect what the planner would generate: the event name, the resolved
   * destination shape, and the sorted property list.
   */
  static eventSignature(args: {
    eventName: string;
    destinationShape: string;
    properties: string[];
    limit: number;
  }): string {
    const props = [...args.properties].sort().join(",");
    return `${args.eventName}|${args.destinationShape}|n=${args.limit}|props=${props}`;
  }

  read(key: string): CachedPlan | undefined {
    const file = path.join(this.dir, `${key}.json`);
    try {
      const txt = fs.readFileSync(file, "utf8");
      return JSON.parse(txt) as CachedPlan;
    } catch {
      return undefined;
    }
  }

  write(key: string, plan: CachedPlan): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${key}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
    fs.renameSync(tmp, file);
  }
}
