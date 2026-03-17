import { describe, it, expect } from "vitest";
import { extractAllLiteralValues } from "../src/core/scanner/context.js";
import { parseCallSites } from "../src/core/scanner/search.js";

describe("extractAllLiteralValues", () => {
  it("extracts string literals from code context", () => {
    const ctx = `
      analytics.track("purchase_completed", {
        payment_method: "credit_card",
        currency: "USD",
      });
    `;
    const result = extractAllLiteralValues(ctx, [], []);
    expect(result.payment_method).toContain("credit_card");
    expect(result.currency).toContain("USD");
  });

  it("filters out noise keywords", () => {
    const ctx = `import { foo } from "bar";\nconst x = "test";`;
    const result = extractAllLiteralValues(ctx, [], []);
    expect(result.import).toBeUndefined();
    expect(result.const).toBeUndefined();
  });

  it("merges values across multiple contexts", () => {
    const ctx1 = `analytics.track("event", { status: "active" });`;
    const ctx2 = `analytics.track("event", { status: "inactive" });`;
    const result = extractAllLiteralValues(ctx1, [ctx2], []);
    expect(result.status).toContain("active");
    expect(result.status).toContain("inactive");
  });
});

describe("parseCallSites", () => {
  it("parses grep output into call sites", () => {
    const output = `src/checkout.ts:47:  analytics.track("purchase_completed", {...})
src/checkout.ts:82:  analytics.track("purchase_completed", {...})`;
    const sites = parseCallSites(output);
    expect(sites).toHaveLength(2);
    expect(sites[0].file).toBe("src/checkout.ts");
    expect(sites[0].line).toBe(47);
  });

  it("ignores malformed lines", () => {
    const output = `not-a-valid-line\nsrc/foo.ts:10:valid line`;
    const sites = parseCallSites(output);
    expect(sites.some((s) => s.line === 10)).toBe(true);
  });
});
