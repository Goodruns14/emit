import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readCatalog,
  writeCatalog,
  loadCatalogSet,
  loadRegistry,
  isRegistryFile,
} from "../src/core/catalog/index.js";
import type { EmitCatalog, CatalogEvent } from "../src/types/index.js";

function ev(over: Partial<CatalogEvent> = {}): CatalogEvent {
  return {
    description: "d",
    fires_when: "f",
    confidence: "high",
    confidence_reason: "r",
    review_required: false,
    source_file: "src/x.ts",
    source_line: 1,
    all_call_sites: [],
    properties: {},
    flags: [],
    ...over,
  };
}

function cat(events: Record<string, CatalogEvent>): EmitCatalog {
  return {
    version: 1,
    generated_at: "2026-01-01T00:00:00Z",
    commit: "abc",
    stats: {
      events_targeted: Object.keys(events).length,
      events_located: Object.keys(events).length,
      events_not_found: 0,
      high_confidence: Object.keys(events).length,
      medium_confidence: 0,
      low_confidence: 0,
    },
    property_definitions: {},
    events,
    not_found: [],
  };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-catset-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("catalog set (registry)", () => {
  it("unions catalogs and tags source_catalog", () => {
    const aPath = path.join(dir, "a.catalog.yml");
    const bPath = path.join(dir, "b.catalog.yml");
    writeCatalog(aPath, cat({ signup_started: ev() }));
    writeCatalog(bPath, cat({ checkout_completed: ev() }));

    const regPath = path.join(dir, "emit.catalogs.yml");
    fs.writeFileSync(
      regPath,
      `catalogs:\n  - { name: alpha, path: a.catalog.yml }\n  - { name: beta, path: b.catalog.yml }\n`
    );

    const merged = loadCatalogSet(regPath);
    expect(Object.keys(merged.events).sort()).toEqual([
      "checkout_completed",
      "signup_started",
    ]);
    expect(merged.events["signup_started"].source_catalog).toBe("alpha");
    expect(merged.events["checkout_completed"].source_catalog).toBe("beta");
    // stats summed
    expect(merged.stats.events_located).toBe(2);
  });

  it("de-collides identical event names across repos", () => {
    const aPath = path.join(dir, "a.catalog.yml");
    const bPath = path.join(dir, "b.catalog.yml");
    writeCatalog(aPath, cat({ page_viewed: ev({ description: "from a" }) }));
    writeCatalog(bPath, cat({ page_viewed: ev({ description: "from b" }) }));

    const regPath = path.join(dir, "emit.catalogs.yml");
    fs.writeFileSync(
      regPath,
      `catalogs:\n  - { name: alpha, path: a.catalog.yml }\n  - { name: beta, path: b.catalog.yml }\n`
    );

    const merged = loadCatalogSet(regPath);
    expect(merged.events["page_viewed"].description).toBe("from a");
    expect(merged.events["page_viewed@beta"].description).toBe("from b");
    expect(merged.events["page_viewed@beta"].source_catalog).toBe("beta");
  });

  it("readCatalog transparently merges when given a registry", () => {
    const aPath = path.join(dir, "a.catalog.yml");
    writeCatalog(aPath, cat({ signup_started: ev() }));
    const regPath = path.join(dir, "emit.catalogs.yml");
    fs.writeFileSync(regPath, `catalogs:\n  - { name: alpha, path: a.catalog.yml }\n`);

    const merged = readCatalog(regPath);
    expect(merged.events["signup_started"].source_catalog).toBe("alpha");
  });

  it("writeCatalog refuses to write to a registry", () => {
    const regPath = path.join(dir, "emit.catalogs.yml");
    fs.writeFileSync(regPath, `catalogs: []\n`);
    expect(() => writeCatalog(regPath, cat({}))).toThrow(/catalog set registry/i);
  });

  it("isRegistryFile detects registries, not normal catalogs", () => {
    const regPath = path.join(dir, "emit.catalogs.yml");
    fs.writeFileSync(regPath, `catalogs: []\n`);
    expect(isRegistryFile(regPath)).toBe(true);

    const catPath = path.join(dir, "normal.catalog.yml");
    writeCatalog(catPath, cat({ a: ev() }));
    expect(isRegistryFile(catPath)).toBe(false);
  });

  it("loadRegistry validates entries", () => {
    const bad = path.join(dir, "emit.catalogs.yml");
    fs.writeFileSync(bad, `catalogs:\n  - { name: alpha }\n`);
    expect(() => loadRegistry(bad)).toThrow(/path/);
  });
});
