import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildPointerPrompt,
  writeBriefFile,
} from "../src/commands/suggest.js";

// Track files we create so we can clean them up after the suite.
const createdFiles: string[] = [];

afterAll(() => {
  for (const f of createdFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      // already gone — fine
    }
  }
});

describe("writeBriefFile", () => {
  it("writes the brief to os.tmpdir() with a deterministic-shaped filename", () => {
    const brief = "# test brief\n\nbody content";
    const briefPath = writeBriefFile(brief, "survey-dropoff");
    createdFiles.push(briefPath);

    expect(briefPath.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(briefPath)).toMatch(
      /^emit-brief-survey-dropoff-\d+\.md$/
    );
  });

  it("writes the brief contents exactly as passed in", () => {
    const brief = "line one\nline two\nline three";
    const briefPath = writeBriefFile(brief, "x");
    createdFiles.push(briefPath);

    const readBack = fs.readFileSync(briefPath, "utf8");
    expect(readBack).toBe(brief);
  });

  it("handles large briefs (>64KB) without truncation", () => {
    // Realistic worst case: papermark feature-launch can exceed 90K chars.
    const big = "x".repeat(100_000);
    const briefPath = writeBriefFile(big, "large");
    createdFiles.push(briefPath);

    const readBack = fs.readFileSync(briefPath, "utf8");
    expect(readBack.length).toBe(100_000);
  });

  it("produces distinct paths for concurrent writes with the same slug", async () => {
    const a = writeBriefFile("a", "concurrent");
    // sleep 2ms to ensure a different timestamp
    await new Promise((r) => setTimeout(r, 2));
    const b = writeBriefFile("b", "concurrent");
    createdFiles.push(a, b);

    expect(a).not.toBe(b);
    expect(fs.readFileSync(a, "utf8")).toBe("a");
    expect(fs.readFileSync(b, "utf8")).toBe("b");
  });
});

describe("buildPointerPrompt", () => {
  it("references the exact brief path", () => {
    const prompt = buildPointerPrompt("/tmp/emit-brief-foo-123.md");
    expect(prompt).toContain("/tmp/emit-brief-foo-123.md");
  });

  it("instructs Claude Code to use the Read tool", () => {
    const prompt = buildPointerPrompt("/tmp/x.md");
    expect(prompt).toMatch(/Read tool/);
  });

  it("tells Claude Code NOT to summarize the brief back", () => {
    const prompt = buildPointerPrompt("/tmp/x.md");
    expect(prompt).toMatch(/[Dd]o not summarize/);
  });

  it("stays short — the whole point is to avoid exceeding viewport", () => {
    const prompt = buildPointerPrompt("/tmp/x.md");
    // A realistic terminal is ~40 lines tall. The pointer prompt should fit
    // in a small fraction of that to leave room for everything else.
    expect(prompt.split("\n").length).toBeLessThan(10);
    expect(prompt.length).toBeLessThan(500);
  });
});
