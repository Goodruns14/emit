import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadConfig, loadConfigLight } from "../src/utils/config.js";

/**
 * Regression tests for M11: loadConfigLight should NOT throw on unresolved
 * env-var references in the config (warehouse tokens, destination creds, etc.).
 *
 * Commands that only need the catalog path (MCP server, `emit suggest`)
 * shouldn't be forced to set credentials they'll never use.
 *
 * loadConfig (strict) MUST still throw on unresolved env vars — commands
 * that need credentials should fail fast with a clear error.
 */

let tmpDir: string;
const ENV_VAR = "EMIT_TEST_NEVER_SET_VAR";

const CONFIG_WITH_UNRESOLVED_ENV = `
repo:
  paths: ["./"]
  sdk: custom
  track_pattern: "track("
output:
  file: emit.catalog.yml
  confidence_threshold: medium
llm:
  provider: claude-code
  model: claude-sonnet-4-5
manual_events:
  - foo
warehouse:
  type: snowflake
  account: \${${ENV_VAR}}
  user: someuser
`;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-cfg-lenient-"));
  fs.writeFileSync(path.join(tmpDir, "emit.config.yml"), CONFIG_WITH_UNRESOLVED_ENV);
});

afterAll(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  delete process.env[ENV_VAR];
});

describe("loadConfigLight — lenient env-var resolution (M11)", () => {
  it("does NOT throw when an env var referenced in the config is unset", async () => {
    // The config references ${EMIT_TEST_NEVER_SET_VAR} in warehouse.account.
    // loadConfigLight should succeed because suggest/MCP don't need that var.
    await expect(loadConfigLight(tmpDir)).resolves.toBeDefined();
  });

  it("loads the rest of the config correctly when an env var is unset", async () => {
    const cfg = await loadConfigLight(tmpDir);
    expect(cfg.output.file).toBe("emit.catalog.yml");
    expect(cfg.repo.paths).toEqual(["./"]);
    expect(cfg.llm?.provider).toBe("claude-code");
  });

  it("leaves the unresolved reference as the literal `${VAR}` string", async () => {
    const cfg = await loadConfigLight(tmpDir);
    // The warehouse.account field should still contain `${EMIT_TEST_NEVER_SET_VAR}`
    // verbatim — code that actually uses it will fail at use-time, but
    // commands that don't touch it can proceed.
    const warehouse = (cfg as any).warehouse;
    expect(warehouse.account).toBe(`\${${ENV_VAR}}`);
  });

  it("still resolves env vars that ARE set (lenient ≠ skip)", async () => {
    process.env[ENV_VAR] = "actual-value";
    const cfg = await loadConfigLight(tmpDir);
    const warehouse = (cfg as any).warehouse;
    expect(warehouse.account).toBe("actual-value");
  });
});

describe("loadConfig — strict env-var resolution (unchanged)", () => {
  it("DOES throw when an env var referenced in the config is unset", async () => {
    // loadConfig is the strict path used by scan/push/etc. that genuinely
    // need credentials. Behavior must NOT change.
    await expect(loadConfig(tmpDir)).rejects.toThrow(
      /Missing required environment variable: EMIT_TEST_NEVER_SET_VAR/
    );
  });

  it("succeeds when the env var is set", async () => {
    process.env[ENV_VAR] = "actual-value";
    const cfg = await loadConfig(tmpDir);
    const warehouse = (cfg as any).warehouse;
    expect(warehouse.account).toBe("actual-value");
  });
});
