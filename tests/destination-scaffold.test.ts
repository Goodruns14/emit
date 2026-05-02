import { describe, it, expect } from "vitest";
import { scaffoldAdapter, toClassName, toSlug } from "../src/commands/destination/scaffold.js";

describe("scaffold name helpers", () => {
  it("toSlug lowercases and dashifies", () => {
    expect(toSlug("Statsig")).toBe("statsig");
    expect(toSlug("My Service")).toBe("my-service");
    expect(toSlug("Foo_Bar.baz")).toBe("foo-bar-baz");
    expect(toSlug("  --  ")).toBe("custom");
  });

  it("toClassName PascalCases with Adapter suffix", () => {
    expect(toClassName("Statsig")).toBe("StatsigAdapter");
    expect(toClassName("my service")).toBe("MyServiceAdapter");
    expect(toClassName("2legit")).toBe("Custom2legitAdapter");
    expect(toClassName("!!!")).toBe("CustomAdapter");
  });
});

describe("scaffoldAdapter — shape", () => {
  it("always starts with docblock and exports default class", () => {
    const out = scaffoldAdapter({
      name: "Statsig",
      className: "StatsigAdapter",
      authStyle: "custom-header",
      envVar: "STATSIG_API_KEY",
      headerName: "STATSIG-API-KEY",
      docsUrl: "https://docs.statsig.com/console-api/metrics",
    });
    expect(out).toMatch(/^\/\*\*\n \* Statsig destination adapter/);
    expect(out).toMatch(/export default class StatsigAdapter \{/);
    expect(out).toMatch(/name = "Statsig";/);
    expect(out).toContain("async push(catalog, opts = {})");
    expect(out).toContain("if (opts.dryRun)");
    expect(out).toContain("opts.events");
    expect(out).toContain("docs.statsig.com/console-api/metrics");
  });
});

describe("scaffoldAdapter — auth styles", () => {
  it("custom-header includes the provided header name and reads env var", () => {
    const out = scaffoldAdapter({
      name: "Statsig",
      className: "StatsigAdapter",
      authStyle: "custom-header",
      envVar: "STATSIG_API_KEY",
      headerName: "STATSIG-API-KEY",
    });
    expect(out).toContain(`options.api_key_env ?? "STATSIG_API_KEY"`);
    expect(out).toContain(`"STATSIG-API-KEY": this.apiKey`);
    expect(out).not.toContain("Authorization");
  });

  it("bearer renders an Authorization: Bearer header", () => {
    const out = scaffoldAdapter({
      name: "MyApi",
      className: "MyApiAdapter",
      authStyle: "bearer",
      envVar: "MYAPI_TOKEN",
    });
    expect(out).toContain(`options.api_key_env ?? "MYAPI_TOKEN"`);
    expect(out).toContain("`Bearer ${this.apiKey}`");
  });

  it("basic uses basic_auth_env and Buffer.from(...).toString('base64')", () => {
    const out = scaffoldAdapter({
      name: "Legacy",
      className: "LegacyAdapter",
      authStyle: "basic",
      envVar: "LEGACY_BASIC_AUTH",
    });
    expect(out).toContain(`options.basic_auth_env ?? "LEGACY_BASIC_AUTH"`);
    expect(out).toContain("this.basicAuth = process.env[envVar]");
    expect(out).toContain('Buffer.from(this.basicAuth).toString("base64")');
  });

  it("none omits credential setup and auth headers", () => {
    const out = scaffoldAdapter({
      name: "Public",
      className: "PublicAdapter",
      authStyle: "none",
    });
    expect(out).not.toContain("process.env");
    expect(out).not.toContain("Authorization");
    expect(out).not.toContain("api_key_env");
    expect(out).toContain("this.options = options;");
  });

  it("missing docsUrl falls back to placeholder", () => {
    const out = scaffoldAdapter({
      name: "X",
      className: "XAdapter",
      authStyle: "none",
    });
    expect(out).toContain("https://your-destination-docs-url");
  });
});
