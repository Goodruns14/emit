import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";

import {
  loadCatalogSet,
  loadCatalogSources,
  isCatalogRegistry,
  readCatalog,
  writeCatalog,
} from "../src/core/catalog/index.js";
import { listEventsTool } from "../src/mcp/tools/list-events.js";
import { listResolvedTool } from "../src/mcp/tools/list-resolved.js";
import type { CatalogEvent, EmitCatalog, ResolvedEvent } from "../src/types/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-set-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

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

function writeYaml(rel: string, obj: unknown): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, yaml.dump(obj), "utf8");
  return p;
}

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/**
 * Two repos:
 *  - repoA (name "a"): signup, shared; user_id prop; not_found [gone_a]; resolved [a_old→a_new]
 *  - repoB (name "b"): purchase, shared; user_id + amount props; not_found [gone_a, gone_b]; resolved [b_old→b_new]
 * Registry lists a then b, so "a" wins the bare key on the `shared` clash.
 */
function setupTwoCatalogs(registryRel = "emit.catalogs.yml"): string {
  const catA = makeCatalog(
    {
      signup: makeEvent({ description: "A signup" }),
      shared: makeEvent({ description: "A shared" }),
    },
    {
      version: 2,
      generated_at: "2024-03-01T00:00:00.000Z",
      stats: {
        events_targeted: 2,
        events_located: 2,
        events_not_found: 1,
        high_confidence: 2,
        medium_confidence: 0,
        low_confidence: 0,
      },
      property_definitions: {
        user_id: { description: "user id (A)", events: ["signup"], deviations: {} },
      },
      not_found: ["gone_a"],
      resolved: [makeResolved("a_old", "a_new")],
    }
  );
  const catB = makeCatalog(
    {
      purchase: makeEvent({ description: "B purchase" }),
      shared: makeEvent({ description: "B shared" }),
    },
    {
      version: 1,
      generated_at: "2024-02-01T00:00:00.000Z",
      stats: {
        events_targeted: 2,
        events_located: 2,
        events_not_found: 2,
        high_confidence: 1,
        medium_confidence: 1,
        low_confidence: 0,
      },
      property_definitions: {
        user_id: { description: "user id (B)", events: ["purchase"], deviations: {} },
        amount: { description: "amount", events: ["purchase"], deviations: {} },
      },
      not_found: ["gone_a", "gone_b"],
      resolved: [makeResolved("b_old", "b_new")],
    }
  );
  writeYaml("repoA/emit.catalog.yml", catA);
  writeYaml("repoB/emit.catalog.yml", catB);
  return writeYaml(registryRel, {
    catalogs: [
      { name: "a", path: "repoA/emit.catalog.yml" },
      { name: "b", path: "repoB/emit.catalog.yml" },
    ],
  });
}

// ── Union semantics ─────────────────────────────────────────────────────────

describe("loadCatalogSet — union semantics", () => {
  it("unions events and tags each with its source_catalog", () => {
    const union = loadCatalogSet(setupTwoCatalogs());
    expect(union.events.signup.source_catalog).toBe("a");
    expect(union.events.purchase.source_catalog).toBe("b");
  });

  it("keys a cross-catalog name clash as name@source_catalog (first wins bare key)", () => {
    const union = loadCatalogSet(setupTwoCatalogs());
    expect(union.events.shared.source_catalog).toBe("a");
    expect(union.events.shared.description).toBe("A shared");
    expect(union.events["shared@b"].source_catalog).toBe("b");
    expect(union.events["shared@b"].description).toBe("B shared");
  });

  it("merges property_definitions first-source-wins and concatenates+dedupes their event lists", () => {
    const union = loadCatalogSet(setupTwoCatalogs());
    expect(union.property_definitions.user_id.description).toBe("user id (A)");
    expect([...union.property_definitions.user_id.events].sort()).toEqual([
      "purchase",
      "signup",
    ]);
    expect(union.property_definitions.amount).toBeDefined();
  });

  it("concatenates+dedupes not_found and concatenates resolved", () => {
    const union = loadCatalogSet(setupTwoCatalogs());
    expect([...union.not_found].sort()).toEqual(["gone_a", "gone_b"]);
    expect(union.resolved).toHaveLength(2);
    expect((union.resolved ?? []).map((r) => r.original_name).sort()).toEqual([
      "a_old",
      "b_old",
    ]);
  });

  it("synthesizes top-level metadata (max version, latest generated_at, union commit, summed stats)", () => {
    const union = loadCatalogSet(setupTwoCatalogs());
    expect(union.version).toBe(2);
    expect(union.generated_at).toBe("2024-03-01T00:00:00.000Z");
    expect(union.commit).toBe("union");
    expect(union.stats.events_located).toBe(4);
    expect(union.stats.high_confidence).toBe(3);
    expect(union.stats.medium_confidence).toBe(1);
  });

  it("does not mutate the source catalog objects (the source_catalog tag never leaks)", () => {
    const sources = loadCatalogSources(setupTwoCatalogs());
    for (const src of sources) {
      for (const ev of Object.values(src.catalog.events)) {
        expect(ev.source_catalog).toBeUndefined();
      }
    }
  });

  it("resolves member paths relative to the registry file's directory", () => {
    // Registry lives in a nested dir; members are still ../repoA etc.
    const catA = makeCatalog({ only_a: makeEvent() });
    const catB = makeCatalog({ only_b: makeEvent() });
    writeYaml("repoA/emit.catalog.yml", catA);
    writeYaml("repoB/emit.catalog.yml", catB);
    const reg = writeYaml("nested/dir/emit.catalogs.yml", {
      catalogs: [
        { name: "a", path: "../../repoA/emit.catalog.yml" },
        { name: "b", path: "../../repoB/emit.catalog.yml" },
      ],
    });
    const union = loadCatalogSet(reg);
    expect(Object.keys(union.events).sort()).toEqual(["only_a", "only_b"]);
  });
});

// ── readCatalog / writeCatalog registry awareness ─────────────────────────────

describe("readCatalog / writeCatalog registry awareness", () => {
  it("readCatalog on a registry path returns the union", () => {
    const reg = setupTwoCatalogs();
    const union = readCatalog(reg);
    expect(union.events.signup.source_catalog).toBe("a");
    expect(union.events.purchase.source_catalog).toBe("b");
  });

  it("readCatalog on a normal catalog is unchanged (no source_catalog tag)", () => {
    setupTwoCatalogs();
    const single = readCatalog(path.join(tmp, "repoA/emit.catalog.yml"));
    expect(single.events.signup.source_catalog).toBeUndefined();
    expect(single.commit).toBe("abc123");
  });

  it("writeCatalog refuses to overwrite a registry path", () => {
    const reg = setupTwoCatalogs();
    expect(() => writeCatalog(reg, makeCatalog({ x: makeEvent() }))).toThrow(/registry/i);
  });

  it("writeCatalog still writes a normal catalog file", () => {
    const p = path.join(tmp, "out.yml");
    writeCatalog(p, makeCatalog({ hello: makeEvent({ description: "hi" }) }));
    const back = readCatalog(p);
    expect(back.events.hello.description).toBe("hi");
  });
});

// ── Registry validation ───────────────────────────────────────────────────────

describe("registry validation", () => {
  it("throws on duplicate catalog names", () => {
    writeYaml("repoA/emit.catalog.yml", makeCatalog({ a: makeEvent() }));
    const reg = writeYaml("emit.catalogs.yml", {
      catalogs: [
        { name: "dup", path: "repoA/emit.catalog.yml" },
        { name: "dup", path: "repoA/emit.catalog.yml" },
      ],
    });
    expect(() => loadCatalogSet(reg)).toThrow(/duplicate/i);
  });

  it("throws on an empty registry", () => {
    const reg = writeYaml("emit.catalogs.yml", { catalogs: [] });
    expect(() => loadCatalogSet(reg)).toThrow(/empty/i);
  });

  it("throws on an invalid entry (missing path)", () => {
    const reg = writeYaml("emit.catalogs.yml", { catalogs: [{ name: "a" }] });
    expect(() => loadCatalogSet(reg)).toThrow(/non-empty/i);
  });

  it("throws when a member is itself a registry (no nesting)", () => {
    writeYaml("inner.catalogs.yml", { catalogs: [] });
    const reg = writeYaml("emit.catalogs.yml", {
      catalogs: [{ name: "nested", path: "inner.catalogs.yml" }],
    });
    expect(() => loadCatalogSet(reg)).toThrow(/nested/i);
  });

  it("throws a clear error when a member catalog is missing", () => {
    const reg = writeYaml("emit.catalogs.yml", {
      catalogs: [{ name: "a", path: "does-not-exist.yml" }],
    });
    expect(() => loadCatalogSet(reg)).toThrow(/Failed to load catalog "a"/);
  });
});

// ── isCatalogRegistry ─────────────────────────────────────────────────────────

describe("isCatalogRegistry", () => {
  it("is true for an object with a top-level catalogs array", () => {
    expect(isCatalogRegistry({ catalogs: [] })).toBe(true);
  });

  it("is false for an ordinary catalog object", () => {
    expect(isCatalogRegistry(makeCatalog({ a: makeEvent() }))).toBe(false);
  });

  it("is false for null / non-objects", () => {
    expect(isCatalogRegistry(null)).toBe(false);
    expect(isCatalogRegistry("nope")).toBe(false);
  });
});

// ── MCP tools over a catalog set (no tool changes needed) ─────────────────────

describe("MCP tools over a catalog set", () => {
  it("list_events serves the union across repos", () => {
    const reg = setupTwoCatalogs();
    const data = parse(listEventsTool(reg, {}));
    const names = data.events.map((e: { name: string }) => e.name);
    expect(names).toContain("signup");
    expect(names).toContain("purchase");
    expect(names).toContain("shared");
    expect(names).toContain("shared@b");
  });

  it("list_resolved concatenates renames across the set", () => {
    const reg = setupTwoCatalogs();
    const data = parse(listResolvedTool(reg));
    expect(data.count).toBe(2);
    expect(data.resolved.map((r: { original_name: string }) => r.original_name).sort()).toEqual([
      "a_old",
      "b_old",
    ]);
  });
});
