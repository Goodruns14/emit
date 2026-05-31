import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";

import { listResolvedTool } from "../src/mcp/tools/list-resolved.js";
import type { CatalogEvent, EmitCatalog, ResolvedEvent } from "../src/types/index.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-resolved-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeEvent(): CatalogEvent {
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
  };
}

function makeCatalog(over: Partial<EmitCatalog> = {}): EmitCatalog {
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
    events: { an_event: makeEvent() },
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

function writeCatalogYaml(catalog: EmitCatalog): string {
  const p = path.join(tmp, "emit.catalog.yml");
  fs.writeFileSync(p, yaml.dump(catalog), "utf8");
  return p;
}

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("listResolvedTool", () => {
  it("returns resolved entries with a count and a renames explanation", () => {
    const p = writeCatalogYaml(
      makeCatalog({ resolved: [makeResolved("old_name", "new_name")] })
    );
    const data = parse(listResolvedTool(p));
    expect(data.count).toBe(1);
    expect(data.resolved[0].original_name).toBe("old_name");
    expect(data.resolved[0].actual_event_name).toBe("new_name");
    expect(data.explanation).toMatch(/rename/i);
  });

  it("handles a catalog with no resolved section", () => {
    const p = writeCatalogYaml(makeCatalog());
    const data = parse(listResolvedTool(p));
    expect(data.count).toBe(0);
    expect(data.resolved).toEqual([]);
    expect(data.explanation).toMatch(/no renamed/i);
  });

  it("returns an error payload for a missing catalog", () => {
    const result = listResolvedTool(path.join(tmp, "nope.yml"));
    expect(result.isError).toBe(true);
    expect(parse(result).error).toBeTruthy();
  });
});
