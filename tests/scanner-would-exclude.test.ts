import { describe, it, expect } from "vitest";
import { wouldExclude } from "../src/core/scanner/search.js";

describe("wouldExclude", () => {
  it("returns false when paths is empty", () => {
    expect(wouldExclude("src/foo.ts", [])).toBe(false);
  });

  describe("path-prefix patterns (contain /)", () => {
    it("matches direct prefix", () => {
      expect(wouldExclude("src/audit/Audit.java", ["src/audit"])).toBe(true);
    });

    it("matches with trailing /**", () => {
      expect(wouldExclude("src/audit/sub/Foo.java", ["src/audit/**"])).toBe(true);
    });

    it("matches with trailing /", () => {
      expect(wouldExclude("backend/foo/Bar.ts", ["backend/foo/"])).toBe(true);
    });

    it("strips ./ prefix on both sides", () => {
      expect(wouldExclude("./src/foo.ts", ["./src"])).toBe(true);
    });

    it("does not match unrelated prefix", () => {
      expect(wouldExclude("src/components/foo.ts", ["src/audit"])).toBe(false);
    });

    it("does not match partial directory name", () => {
      // src/auditor must NOT match prefix "src/audit"
      expect(wouldExclude("src/auditor/foo.ts", ["src/audit"])).toBe(false);
    });
  });

  describe("basename glob patterns (contain * but no /)", () => {
    it("matches *.test.ts on basename", () => {
      expect(wouldExclude("src/foo/bar.test.ts", ["*.test.ts"])).toBe(true);
    });

    it("matches **/-prefixed basename globs against the file basename", () => {
      // **/ is stripped, leaving "*.module.css" as a basename glob.
      // wouldExclude mirrors setExcludePaths classification.
      expect(wouldExclude("a/b/c.module.css", ["**/*.module.css"])).toBe(true);
    });

    it("does not match if extension differs", () => {
      expect(wouldExclude("src/foo.ts", ["*.test.ts"])).toBe(false);
    });
  });

  describe("plain directory name (no / no *)", () => {
    it("matches dir name anywhere in path", () => {
      expect(wouldExclude("src/cypress/spec.ts", ["cypress"])).toBe(true);
    });

    it("does not match when name is only the basename", () => {
      // grep --exclude-dir matches directory names, not file basenames
      expect(wouldExclude("src/cypress.ts", ["cypress"])).toBe(false);
    });

    it("does not match a partial dir name segment", () => {
      expect(wouldExclude("src/cypressy/x.ts", ["cypress"])).toBe(false);
    });
  });

  describe("multiple patterns", () => {
    it("matches if any pattern matches", () => {
      expect(wouldExclude("a/b.test.ts", ["unrelated", "*.test.ts"])).toBe(true);
    });

    it("returns false when none match", () => {
      expect(wouldExclude("src/Real.ts", ["src/audit", "*.test.ts", "cypress"])).toBe(false);
    });
  });
});
