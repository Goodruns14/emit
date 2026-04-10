import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";

import {
  readCatalog,
  writeCatalog,
  catalogExists,
  getEvent,
  updateEvent,
  slugifyEventName,
  isCatalogDirectory,
  readSingleEvent,
  writeSingleEvent,
} from "../src/core/catalog/index.js";
import type { EmitCatalog, CatalogEvent } from "../src/types/index.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const makeEvent = (overrides: Partial<CatalogEvent> = {}): CatalogEvent => ({
  description: "Test event",
  fires_when: "Test condition",
  confidence: "high",
  confidence_reason: "Test reason",
  review_required: false,
  source_file: "./src/test.ts",
  source_line: 10,
  all_call_sites: [{ file: "./src/test.ts", line: 10 }],
  properties: {
    user_id: {
      description: "User identifier",
      edge_cases: [],
      null_rate: 0,
      cardinality: 1000,
      sample_values: ["u_123"],
      code_sample_values: ["userId"],
      confidence: "high",
    },
  },
  flags: [],
  context_hash: "abc123",
  last_modified_by: "scan",
  ...overrides,
});

const fixture: EmitCatalog = {
  version: 1,
  generated_at: "2026-03-24T00:00:00.000Z",
  commit: "abc1234",
  stats: {
    events_targeted: 3,
    events_located: 3,
    events_not_found: 0,
    high_confidence: 2,
    medium_confidence: 0,
    low_confidence: 1,
  },
  property_definitions: {
    user_id: {
      description: "Canonical user identifier",
      events: ["purchase_completed", "signup_completed"],
      deviations: {},
    },
  },
  events: {
    purchase_completed: makeEvent({ description: "Fired on purchase", source_file: "./src/checkout.ts" }),
    signup_completed: makeEvent({ description: "Fired on signup", source_file: "./src/auth.ts" }),
    "page.viewed": makeEvent({ description: "Fired on page view", confidence: "low", source_file: "./src/pages.ts" }),
  },
  not_found: ["missing_event"],
  resolved: [
    {
      original_name: "old_event",
      actual_event_name: "new_event",
      match_file: "./src/renamed.ts",
      match_line: 5,
      event_type: "frontend",
      explanation: "Renamed in v2",
      rename_detected: true,
      confidence: "high",
    },
  ],
};

// ── Setup ────────────────────────────────────────────────────────────────────

let tmpDir: string;
let catalogDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-dir-test-"));
  catalogDir = path.join(tmpDir, "emit.catalog");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── slugifyEventName ─────────────────────────────────────────────────────────

describe("slugifyEventName", () => {
  it("converts underscores to hyphens", () => {
    expect(slugifyEventName("purchase_completed")).toBe("purchase-completed");
  });

  it("converts spaces to hyphens", () => {
    expect(slugifyEventName("Purchase Completed")).toBe("purchase-completed");
  });

  it("converts dots to hyphens", () => {
    expect(slugifyEventName("app.page_viewed")).toBe("app-page-viewed");
  });

  it("strips leading special characters", () => {
    expect(slugifyEventName("$pageview")).toBe("pageview");
  });

  it("collapses consecutive hyphens", () => {
    expect(slugifyEventName("foo__bar--baz")).toBe("foo-bar-baz");
  });

  it("handles empty string", () => {
    expect(slugifyEventName("")).toBe("");
  });

  it("handles all-special-character names", () => {
    expect(slugifyEventName("$$$")).toBe("");
  });

  it("handles unicode characters", () => {
    expect(slugifyEventName("événement_créé")).toBe("v-nement-cr");
  });

  it("lowercases", () => {
    expect(slugifyEventName("MyEvent")).toBe("myevent");
  });
});

// ── isCatalogDirectory ───────────────────────────────────────────────────────

describe("isCatalogDirectory", () => {
  it("returns false for .yml files", () => {
    expect(isCatalogDirectory("emit.catalog.yml")).toBe(false);
  });

  it("returns false for .yaml files", () => {
    expect(isCatalogDirectory("emit.catalog.yaml")).toBe(false);
  });

  it("returns true for paths without yaml extension", () => {
    expect(isCatalogDirectory("emit.catalog")).toBe(true);
  });

  it("returns true for paths ending in a directory name", () => {
    expect(isCatalogDirectory("/path/to/my-catalog")).toBe(true);
  });

  it("returns true for extensionless paths", () => {
    expect(isCatalogDirectory("catalog")).toBe(true);
  });
});

// ── Directory round-trip ─────────────────────────────────────────────────────

describe("directory catalog round-trip", () => {
  it("writes and reads back the same catalog", () => {
    writeCatalog(catalogDir, fixture);
    const read = readCatalog(catalogDir);

    expect(read.version).toBe(fixture.version);
    expect(read.generated_at).toBe(fixture.generated_at);
    expect(read.commit).toBe(fixture.commit);
    expect(read.stats).toEqual(fixture.stats);
    expect(read.property_definitions).toEqual(fixture.property_definitions);
    expect(read.not_found).toEqual(fixture.not_found);
    expect(read.resolved).toEqual(fixture.resolved);

    // Events
    expect(Object.keys(read.events).sort()).toEqual(Object.keys(fixture.events).sort());
    for (const [name, event] of Object.entries(fixture.events)) {
      expect(read.events[name]).toEqual(event);
    }
  });

  it("creates expected directory structure", () => {
    writeCatalog(catalogDir, fixture);

    expect(fs.existsSync(path.join(catalogDir, "_index.yml"))).toBe(true);
    expect(fs.existsSync(path.join(catalogDir, "events"))).toBe(true);
    expect(fs.existsSync(path.join(catalogDir, "events", "purchase-completed.yml"))).toBe(true);
    expect(fs.existsSync(path.join(catalogDir, "events", "signup-completed.yml"))).toBe(true);
    expect(fs.existsSync(path.join(catalogDir, "events", "page-viewed.yml"))).toBe(true);
  });

  it("event files contain the event name as top-level key", () => {
    writeCatalog(catalogDir, fixture);

    const content = fs.readFileSync(path.join(catalogDir, "events", "purchase-completed.yml"), "utf8");
    const parsed = yaml.load(content) as Record<string, CatalogEvent>;
    expect(parsed).toHaveProperty("purchase_completed");
    expect(parsed.purchase_completed.description).toBe("Fired on purchase");
  });

  it("_index.yml does not contain events", () => {
    writeCatalog(catalogDir, fixture);

    const content = fs.readFileSync(path.join(catalogDir, "_index.yml"), "utf8");
    const parsed = yaml.load(content) as any;
    expect(parsed.events).toBeUndefined();
    expect(parsed.version).toBe(1);
    expect(parsed.stats).toEqual(fixture.stats);
  });
});

// ── catalogExists ────────────────────────────────────────────────────────────

describe("catalogExists (directory mode)", () => {
  it("returns false when directory does not exist", () => {
    expect(catalogExists(catalogDir)).toBe(false);
  });

  it("returns true when _index.yml exists", () => {
    writeCatalog(catalogDir, fixture);
    expect(catalogExists(catalogDir)).toBe(true);
  });

  it("returns false when directory exists but _index.yml is missing", () => {
    fs.mkdirSync(catalogDir, { recursive: true });
    expect(catalogExists(catalogDir)).toBe(false);
  });
});

// ── Orphan cleanup ───────────────────────────────────────────────────────────

describe("orphan cleanup", () => {
  it("removes event files for events no longer in catalog", () => {
    writeCatalog(catalogDir, fixture);
    expect(fs.existsSync(path.join(catalogDir, "events", "page-viewed.yml"))).toBe(true);

    // Write catalog without page.viewed
    const { "page.viewed": _, ...remainingEvents } = fixture.events;
    const smallerCatalog: EmitCatalog = {
      ...fixture,
      events: remainingEvents,
    };
    writeCatalog(catalogDir, smallerCatalog);

    expect(fs.existsSync(path.join(catalogDir, "events", "purchase-completed.yml"))).toBe(true);
    expect(fs.existsSync(path.join(catalogDir, "events", "signup-completed.yml"))).toBe(true);
    expect(fs.existsSync(path.join(catalogDir, "events", "page-viewed.yml"))).toBe(false);
  });
});

// ── readCatalog error handling ───────────────────────────────────────────────

describe("readCatalog error handling (directory mode)", () => {
  it("throws when directory does not exist", () => {
    expect(() => readCatalog(catalogDir)).toThrow("Catalog directory not found");
  });

  it("throws when _index.yml is malformed", () => {
    fs.mkdirSync(catalogDir, { recursive: true });
    fs.writeFileSync(path.join(catalogDir, "_index.yml"), "not valid yaml: [[[", "utf8");
    expect(() => readCatalog(catalogDir)).toThrow();
  });
});

// ── Single-file mode still works ─────────────────────────────────────────────

describe("single-file mode backward compatibility", () => {
  it("writes and reads single file when path ends in .yml", () => {
    const singlePath = path.join(tmpDir, "emit.catalog.yml");
    writeCatalog(singlePath, fixture);
    expect(fs.existsSync(singlePath)).toBe(true);
    expect(fs.statSync(singlePath).isFile()).toBe(true);

    const read = readCatalog(singlePath);
    expect(Object.keys(read.events).sort()).toEqual(Object.keys(fixture.events).sort());
  });
});

// ── readSingleEvent ──────────────────────────────────────────────────────────

describe("readSingleEvent", () => {
  it("reads a single event without loading full catalog", () => {
    writeCatalog(catalogDir, fixture);

    const result = readSingleEvent(catalogDir, "purchase_completed");
    expect(result).not.toBeNull();
    expect(result!.event.description).toBe("Fired on purchase");
    expect(result!.propertyDefinitions.user_id).toBeDefined();
  });

  it("returns null for non-existent event", () => {
    writeCatalog(catalogDir, fixture);
    expect(readSingleEvent(catalogDir, "nonexistent")).toBeNull();
  });

  it("falls back to full read in single-file mode", () => {
    const singlePath = path.join(tmpDir, "emit.catalog.yml");
    writeCatalog(singlePath, fixture);

    const result = readSingleEvent(singlePath, "purchase_completed");
    expect(result).not.toBeNull();
    expect(result!.event.description).toBe("Fired on purchase");
  });
});

// ── writeSingleEvent ─────────────────────────────────────────────────────────

describe("writeSingleEvent", () => {
  it("writes a single event file and updates index timestamp", () => {
    writeCatalog(catalogDir, fixture);

    const updatedEvent = makeEvent({ description: "Updated description" });
    writeSingleEvent(catalogDir, "purchase_completed", updatedEvent, {
      generated_at: "2026-04-01T00:00:00.000Z",
    });

    // Verify event file updated
    const result = readSingleEvent(catalogDir, "purchase_completed");
    expect(result!.event.description).toBe("Updated description");

    // Verify index timestamp updated
    const indexContent = fs.readFileSync(path.join(catalogDir, "_index.yml"), "utf8");
    const index = yaml.load(indexContent) as any;
    expect(index.generated_at).toBe("2026-04-01T00:00:00.000Z");
  });
});

// ── getEvent / updateEvent (in-memory, mode-agnostic) ────────────────────────

describe("getEvent and updateEvent with directory catalog", () => {
  it("works on catalog read from directory", () => {
    writeCatalog(catalogDir, fixture);
    const catalog = readCatalog(catalogDir);

    const event = getEvent(catalog, "purchase_completed");
    expect(event).toBeDefined();
    expect(event!.description).toBe("Fired on purchase");

    const updated = updateEvent(catalog, "purchase_completed", makeEvent({ description: "Changed" }));
    expect(updated.events.purchase_completed.description).toBe("Changed");
    // Original not mutated
    expect(catalog.events.purchase_completed.description).toBe("Fired on purchase");
  });
});
