import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createMcpServer } from "../src/mcp/server.js";
import type { CatalogEvent, EmitCatalog, ResolvedEvent } from "../src/types/index.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

let tmp: string;
let registryPath: string;

function makeEvent(over: Partial<CatalogEvent> = {}): CatalogEvent {
  return {
    description: "desc",
    fires_when: "when",
    confidence: "high",
    confidence_reason: "reason",
    review_required: false,
    source_file: "src/x.ts",
    source_line: 1,
    all_call_sites: [{ file: "src/x.ts", line: 1 }],
    properties: {},
    flags: [],
    ...over,
  };
}

function makeResolved(original: string, actual: string): ResolvedEvent {
  return {
    original_name: original,
    actual_event_name: actual,
    match_file: "src/x.ts",
    match_line: 1,
    event_type: "frontend",
    explanation: "looks renamed",
    rename_detected: true,
    confidence: "high",
  };
}

function makeCatalog(
  events: Record<string, CatalogEvent>,
  over: Partial<EmitCatalog> = {}
): EmitCatalog {
  return {
    version: 1,
    generated_at: "2024-01-01T00:00:00.000Z",
    commit: "abc123",
    stats: {
      events_targeted: 0,
      events_located: 0,
      events_not_found: 0,
      high_confidence: 0,
      medium_confidence: 0,
      low_confidence: 0,
    },
    property_definitions: {},
    events,
    not_found: [],
    ...over,
  };
}

function writeYaml(rel: string, obj: unknown): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, yaml.dump(obj), "utf8");
  return p;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-mcp-set-test-"));
  // repo "web": signup_started, shared_event; resolved a_old→a_new
  writeYaml(
    "repoA/emit.catalog.yml",
    makeCatalog(
      {
        signup_started: makeEvent({ description: "User began the signup flow" }),
        shared_event: makeEvent({ description: "Shared (web)" }),
      },
      { resolved: [makeResolved("a_old", "a_new")] }
    )
  );
  // repo "billing": purchase_made, shared_event; resolved b_old→b_new
  writeYaml(
    "repoB/emit.catalog.yml",
    makeCatalog(
      {
        purchase_made: makeEvent({ description: "User completed a purchase" }),
        shared_event: makeEvent({ description: "Shared (billing)" }),
      },
      { resolved: [makeResolved("b_old", "b_new")] }
    )
  );
  registryPath = writeYaml("emit.catalogs.yml", {
    catalogs: [
      { name: "web", path: "repoA/emit.catalog.yml" },
      { name: "billing", path: "repoB/emit.catalog.yml" },
    ],
  });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function textOf(result: unknown): any {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

// ── In-process: real MCP client ↔ real MCP server over a linked transport ─────

describe("MCP server over a catalog set (in-process client↔server)", () => {
  async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
    const server = createMcpServer(registryPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "emit-e2e-test", version: "0.0.0" });
    await client.connect(clientTransport);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it("advertises the catalog tools (including list_resolved)", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "list_events",
          "search_events",
          "get_event_description",
          "list_resolved",
        ])
      );
    } finally {
      await close();
    }
  });

  it("list_events returns events from every catalog in the set", async () => {
    const { client, close } = await connect();
    try {
      const data = textOf(await client.callTool({ name: "list_events", arguments: {} }));
      const names = data.events.map((e: { name: string }) => e.name);
      expect(names).toContain("signup_started"); // from web
      expect(names).toContain("purchase_made"); // from billing
      expect(names).toContain("shared_event"); // clash: first wins bare key
      expect(names).toContain("shared_event@billing"); // clash: later keyed by source
    } finally {
      await close();
    }
  });

  it("search_events finds an event that lives in a different repo", async () => {
    const { client, close } = await connect();
    try {
      const data = textOf(
        await client.callTool({ name: "search_events", arguments: { query: "purchase" } })
      );
      const names = data.events.map((e: { name: string }) => e.name);
      expect(names).toContain("purchase_made");
    } finally {
      await close();
    }
  });

  it("get_event_description resolves an event from a different repo", async () => {
    const { client, close } = await connect();
    try {
      const data = textOf(
        await client.callTool({
          name: "get_event_description",
          arguments: { event_name: "purchase_made" },
        })
      );
      expect(data.event_name).toBe("purchase_made");
      expect(data.description).toBe("User completed a purchase");
    } finally {
      await close();
    }
  });

  it("list_resolved aggregates renames across the whole set", async () => {
    const { client, close } = await connect();
    try {
      const data = textOf(await client.callTool({ name: "list_resolved", arguments: {} }));
      expect(data.count).toBe(2);
      expect(
        data.resolved.map((r: { original_name: string }) => r.original_name).sort()
      ).toEqual(["a_old", "b_old"]);
    } finally {
      await close();
    }
  });
});

// ── Full binary: the real `emit mcp --catalog-set` over stdio (needs a build) ─

const distCli = path.resolve("dist/cli.js");
const hasBuild = fs.existsSync(distCli);

describe("MCP server over a catalog set (real `emit mcp --catalog-set` subprocess)", () => {
  it.skipIf(!hasBuild)(
    "serves the union over stdio from the compiled CLI",
    async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [distCli, "mcp", "--catalog-set", registryPath],
      });
      const client = new Client({ name: "emit-e2e-test", version: "0.0.0" });
      await client.connect(transport);
      try {
        const data = textOf(await client.callTool({ name: "list_events", arguments: {} }));
        const names = data.events.map((e: { name: string }) => e.name);
        expect(names).toContain("signup_started");
        expect(names).toContain("purchase_made");
      } finally {
        await client.close();
      }
    },
    20000
  );
});
