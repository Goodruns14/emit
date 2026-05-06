import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { writeCatalog, readCatalog } from "../src/core/catalog/index.js";
import type { EmitCatalog } from "../src/types/index.js";

let tmpDir: string;
let catalogPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-roundtrip-"));
  catalogPath = path.join(tmpDir, "emit.catalog.yml");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeCatalog → readCatalog round-trip — minimal catalog", () => {
  it("survives a minimal catalog with no stats / property_definitions", () => {
    // This is the shape produced by partial scans, fresh-init flows, or
    // hand-crafted test fixtures. Previously the writer emitted bare `{}`
    // tokens for missing stats/property_definitions, which broke YAML
    // parsing on the read-back path.
    const minimal: EmitCatalog = {
      version: 1,
      generated_at: "2026-05-06T00:00:00.000Z",
      events: {
        evt_purchase: {
          description: "User completed a purchase",
          fires_when: "After payment confirmation",
          confidence: "high",
          confidence_reason: "Test",
          review_required: false,
          source_file: "./src/checkout.ts",
          source_line: 1,
          all_call_sites: [{ file: "./src/checkout.ts", line: 1 }],
          properties: {
            user_id: {
              description: "User identifier",
              edge_cases: [],
              null_rate: 0,
              cardinality: 0,
              sample_values: ["alice", "bob"],
              code_sample_values: [],
              confidence: "high",
            },
          },
          flags: [],
        },
      },
      not_found: [],
    };

    writeCatalog(catalogPath, minimal);
    const persisted = readCatalog(catalogPath);

    expect(persisted.events?.evt_purchase?.properties?.user_id?.sample_values).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("survives a catalog with stats and property_definitions present", () => {
    const full: EmitCatalog = {
      version: 1,
      generated_at: "2026-05-06T00:00:00.000Z",
      stats: {
        events_targeted: 1,
        events_located: 1,
        events_not_found: 0,
        high_confidence: 1,
        medium_confidence: 0,
        low_confidence: 0,
      },
      property_definitions: {
        user_id: {
          description: "Canonical user id",
          events: ["evt_purchase"],
          deviations: {},
        },
      },
      events: {
        evt_purchase: {
          description: "Test",
          fires_when: "Test",
          confidence: "high",
          confidence_reason: "Test",
          review_required: false,
          source_file: "./x",
          source_line: 1,
          all_call_sites: [],
          properties: {},
          flags: [],
        },
      },
      not_found: [],
    };

    writeCatalog(catalogPath, full);
    const persisted = readCatalog(catalogPath);

    expect(persisted.stats?.events_targeted).toBe(1);
    expect(persisted.property_definitions?.user_id?.description).toBe("Canonical user id");
  });

  it("write → write → read produces a valid catalog (idempotent)", () => {
    // Reproduces the scenario from scripts/test-mode3-e2e.mjs: an MCP write
    // tool calls writeCatalog, then a subsequent get_property_description
    // call goes through readCatalog. Previously this failed because the
    // first write produced unparseable output when stats was undefined.
    const minimal: EmitCatalog = {
      version: 1,
      generated_at: "2026-05-06T00:00:00.000Z",
      events: {
        e: {
          description: "x",
          fires_when: "x",
          confidence: "high",
          confidence_reason: "x",
          review_required: false,
          source_file: "./x",
          source_line: 1,
          all_call_sites: [],
          properties: {
            p: {
              description: "x",
              edge_cases: [],
              null_rate: 0,
              cardinality: 0,
              sample_values: [],
              code_sample_values: [],
              confidence: "high",
            },
          },
          flags: [],
        },
      },
      not_found: [],
    };

    writeCatalog(catalogPath, minimal);
    const afterFirstRead = readCatalog(catalogPath);
    // Mutate and write again (mirrors update_property_sample_values flow)
    afterFirstRead.events!.e!.properties!.p!.sample_values = ["a", "b"];
    writeCatalog(catalogPath, afterFirstRead);
    const afterSecondRead = readCatalog(catalogPath);

    expect(afterSecondRead.events?.e?.properties?.p?.sample_values).toEqual(["a", "b"]);
  });
});
