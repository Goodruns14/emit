import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RepoScanner } from "../src/core/scanner/index.js";
import { buildExtractionPrompt } from "../src/core/extractor/prompts.js";
import { computeContextHash } from "../src/utils/hash.js";
import type { CodeContext } from "../src/types/index.js";

// ─────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────

function mkTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "emit-context-files-"));
}

function rmRepo(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─────────────────────────────────────────────
// RepoScanner — context_files attachment
// ─────────────────────────────────────────────

describe("RepoScanner + backend_patterns context_files", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkTempRepo();
  });

  afterEach(() => {
    rmRepo(repo);
  });

  it("attaches configured context_files when the pattern matches the call site", async () => {
    // Wrapper call site — no properties visible
    fs.writeFileSync(
      path.join(repo, "consumer.ts"),
      `import { audit } from "./audit";\n` +
        `export function handleCrud() {\n` +
        `  audit.fire(AuditEvents.CAPTURE_ENTITY_CRUD);\n` +
        `}\n`
    );
    // The helper where the payload actually assembles
    fs.writeFileSync(
      path.join(repo, "appender.ts"),
      `import { analytics } from "segment";\n` +
        `export function append(event: string, ctx: Ctx) {\n` +
        `  analytics.track(event, { entity_id: ctx.id, org_id: ctx.org });\n` +
        `}\n`
    );

    const scanner = new RepoScanner({
      paths: [repo],
      sdk: "custom",
      backendPatterns: [
        {
          pattern: "audit.fire(",
          context_files: [path.join(repo, "appender.ts")],
        },
      ],
    });

    const ctx = await scanner.findEvent("CAPTURE_ENTITY_CRUD");
    expect(ctx.match_type).not.toBe("not_found");
    expect(ctx.extra_context_files).toBeDefined();
    expect(ctx.extra_context_files).toHaveLength(1);
    expect(ctx.extra_context_files![0].path).toBe(path.join(repo, "appender.ts"));
    expect(ctx.extra_context_files![0].content).toContain("entity_id");
  });

  it("does not attach context_files for events whose pattern has no entry", async () => {
    fs.writeFileSync(
      path.join(repo, "call.ts"),
      `analytics.track("purchase_completed", { total: 100 });\n`
    );
    fs.writeFileSync(path.join(repo, "helper.ts"), `// unrelated\n`);

    const scanner = new RepoScanner({
      paths: [repo],
      sdk: "segment",
      backendPatterns: [
        {
          pattern: "audit.fire(",
          context_files: [path.join(repo, "helper.ts")],
        },
      ],
    });

    const ctx = await scanner.findEvent("purchase_completed");
    expect(ctx.extra_context_files).toBeUndefined();
  });

  it("falls back to a window scan when the matched pattern is not the configured one (multi-line call sites)", async () => {
    // Matched line is the enum line, but the pattern `audit.fire(` is one line up.
    fs.writeFileSync(
      path.join(repo, "multi.ts"),
      `export function run() {\n` +
        `  audit.fire(\n` +
        `    AuditEvents.CAPTURE_ENTITY_CRUD\n` +
        `  );\n` +
        `}\n`
    );
    fs.writeFileSync(
      path.join(repo, "appender.ts"),
      `// pretend: analytics.track(event, { entity_id, org_id })\n`
    );

    const scanner = new RepoScanner({
      paths: [repo],
      sdk: "custom",
      backendPatterns: [
        {
          pattern: "audit.fire(",
          context_files: [path.join(repo, "appender.ts")],
        },
      ],
    });

    const ctx = await scanner.findEvent("CAPTURE_ENTITY_CRUD");
    expect(ctx.extra_context_files).toBeDefined();
    expect(ctx.extra_context_files![0].path).toContain("appender.ts");
  });

  it("plain-string backend_patterns preserve existing behavior (no extras attached)", async () => {
    fs.writeFileSync(
      path.join(repo, "server.ts"),
      `sendEvent("signup_completed", { user_id: "u1" });\n`
    );

    const scanner = new RepoScanner({
      paths: [repo],
      sdk: "custom",
      backendPatterns: ["sendEvent("],
    });

    const ctx = await scanner.findEvent("signup_completed");
    expect(ctx.match_type).not.toBe("not_found");
    expect(ctx.extra_context_files).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// Prompt builder
// ─────────────────────────────────────────────

describe("buildExtractionPrompt with extra_context_files", () => {
  const baseCtx: CodeContext = {
    file_path: "src/consumer.ts",
    line_number: 3,
    context: "audit.fire(AuditEvents.CAPTURE_ENTITY_CRUD);",
    match_type: "direct",
    all_call_sites: [
      {
        file_path: "src/consumer.ts",
        line_number: 3,
        context: "audit.fire(AuditEvents.CAPTURE_ENTITY_CRUD);",
      },
    ],
  };

  it("includes a 'Reference helper sources' section when extras are present", () => {
    const ctx: CodeContext = {
      ...baseCtx,
      extra_context_files: [
        { path: "src/appender.ts", content: "analytics.track(event, { entity_id, org_id })" },
      ],
    };
    const prompt = buildExtractionPrompt("CAPTURE_ENTITY_CRUD", ctx, {});
    expect(prompt).toContain("Reference helper sources");
    expect(prompt).toContain("src/appender.ts");
    expect(prompt).toContain("entity_id");
  });

  it("omits the section when no extras are provided", () => {
    const prompt = buildExtractionPrompt("CAPTURE_ENTITY_CRUD", baseCtx, {});
    expect(prompt).not.toContain("Reference helper sources");
  });
});

// ─────────────────────────────────────────────
// Hashing — cache invalidation
// ─────────────────────────────────────────────

describe("computeContextHash with extraFiles", () => {
  it("produces the same hash when extra files are identical", () => {
    const h1 = computeContextHash("ctx", [], {}, [{ path: "a.ts", content: "hello" }]);
    const h2 = computeContextHash("ctx", [], {}, [{ path: "a.ts", content: "hello" }]);
    expect(h1).toBe(h2);
  });

  it("invalidates the hash when a reference file's content changes", () => {
    const h1 = computeContextHash("ctx", [], {}, [{ path: "a.ts", content: "v1" }]);
    const h2 = computeContextHash("ctx", [], {}, [{ path: "a.ts", content: "v2" }]);
    expect(h1).not.toBe(h2);
  });

  it("invalidates the hash when a reference file is added", () => {
    const h1 = computeContextHash("ctx", [], {}, []);
    const h2 = computeContextHash("ctx", [], {}, [{ path: "a.ts", content: "v1" }]);
    expect(h1).not.toBe(h2);
  });

  it("matches the legacy 3-arg call signature when no extras are provided", () => {
    const legacy = computeContextHash("ctx", ["site1"], { foo: ["bar"] });
    const explicit = computeContextHash("ctx", ["site1"], { foo: ["bar"] }, []);
    expect(legacy).toBe(explicit);
  });
});
