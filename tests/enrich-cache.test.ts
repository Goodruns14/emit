import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EnrichCache } from "../src/core/destinations/enrich-cache.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-enrich-cache-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("EnrichCache.buildKey", () => {
  it("is stable across calls", () => {
    const a = EnrichCache.buildKey({
      destinationType: "bigquery",
      toolsSignature: "sig1",
      eventSignature: "evt1",
    });
    const b = EnrichCache.buildKey({
      destinationType: "bigquery",
      toolsSignature: "sig1",
      eventSignature: "evt1",
    });
    expect(a).toBe(b);
  });

  it("differs when destination type changes", () => {
    const a = EnrichCache.buildKey({
      destinationType: "bigquery",
      toolsSignature: "sig1",
      eventSignature: "evt1",
    });
    const b = EnrichCache.buildKey({
      destinationType: "snowflake",
      toolsSignature: "sig1",
      eventSignature: "evt1",
    });
    expect(a).not.toBe(b);
  });

  it("differs when tool surface changes", () => {
    const a = EnrichCache.buildKey({
      destinationType: "bigquery",
      toolsSignature: "tools-v1",
      eventSignature: "evt1",
    });
    const b = EnrichCache.buildKey({
      destinationType: "bigquery",
      toolsSignature: "tools-v2",
      eventSignature: "evt1",
    });
    expect(a).not.toBe(b);
  });

  it("differs when event signature changes", () => {
    const a = EnrichCache.buildKey({
      destinationType: "bigquery",
      toolsSignature: "sig1",
      eventSignature: "purchase|table=t|n=100|props=a,b",
    });
    const b = EnrichCache.buildKey({
      destinationType: "bigquery",
      toolsSignature: "sig1",
      eventSignature: "purchase|table=t|n=100|props=a,c",
    });
    expect(a).not.toBe(b);
  });
});

describe("EnrichCache.toolsSignature", () => {
  it("is order-independent", () => {
    const a = EnrichCache.toolsSignature([
      { name: "alpha", inputSchema: { x: 1 } },
      { name: "beta", inputSchema: { y: 2 } },
    ]);
    const b = EnrichCache.toolsSignature([
      { name: "beta", inputSchema: { y: 2 } },
      { name: "alpha", inputSchema: { x: 1 } },
    ]);
    expect(a).toBe(b);
  });

  it("changes when a tool's schema changes", () => {
    const a = EnrichCache.toolsSignature([{ name: "alpha", inputSchema: { x: 1 } }]);
    const b = EnrichCache.toolsSignature([{ name: "alpha", inputSchema: { x: 2 } }]);
    expect(a).not.toBe(b);
  });
});

describe("EnrichCache.eventSignature", () => {
  it("is property-order-independent", () => {
    const a = EnrichCache.eventSignature({
      eventName: "purchase",
      destinationShape: "bq|t",
      properties: ["a", "b", "c"],
      limit: 100,
    });
    const b = EnrichCache.eventSignature({
      eventName: "purchase",
      destinationShape: "bq|t",
      properties: ["c", "a", "b"],
      limit: 100,
    });
    expect(a).toBe(b);
  });
});

describe("EnrichCache read/write", () => {
  it("round-trips a plan", () => {
    const cache = new EnrichCache({ rootDir: tmp });
    const key = "abc123";
    const plan = {
      calls: [{ tool: "execute_sql", args: { sql: "SELECT 1" } }],
      extractor_hint: "rows are objects",
    };
    cache.write(key, plan);
    expect(cache.read(key)).toEqual(plan);
  });

  it("returns undefined on miss", () => {
    const cache = new EnrichCache({ rootDir: tmp });
    expect(cache.read("nope")).toBeUndefined();
  });

  it("creates the cache directory if missing", () => {
    const cache = new EnrichCache({ rootDir: tmp });
    cache.write("k1", { calls: [] });
    const dir = path.join(tmp, ".emit", "cache", "enrich");
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, "k1.json"))).toBe(true);
  });
});
