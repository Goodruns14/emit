import { execSync } from "child_process";
import * as fs from "fs";
import * as yaml from "js-yaml";
import type { EmitCatalog, CatalogEvent } from "../types/index.js";

export interface CommitEntry {
  sha: string;
  date: string;
  message: string;
}

export function getCurrentCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export function getCatalogHistory(filePath: string): CommitEntry[] {
  try {
    const output = execSync(
      `git log --follow --format="%H|%ai|%s" -- "${filePath}"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    if (!output) return [];

    return output
      .split("\n")
      .filter(Boolean)
      .slice(0, 20)
      .map((line) => {
        const [sha, date, ...msgParts] = line.split("|");
        return {
          sha: sha.slice(0, 8),
          date: date.slice(0, 10),
          message: msgParts.join("|").slice(0, 80),
        };
      });
  } catch {
    return [];
  }
}

export function getEventAtCommit(
  catalogFile: string,
  eventName: string,
  sha: string
): CatalogEvent | null {
  try {
    const content = execSync(`git show "${sha}:${catalogFile}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const catalog = yaml.load(content) as EmitCatalog;
    return catalog?.events?.[eventName] ?? null;
  } catch {
    return null;
  }
}

export function isGitRepo(cwd?: string): boolean {
  try {
    execSync("git rev-parse --git-dir", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: cwd ?? process.cwd(),
    });
    return true;
  } catch {
    return false;
  }
}

export function getCatalogAtRef(ref: string, catalogPath: string): EmitCatalog | null {
  try {
    const content = execSync(`git show "${ref}:${catalogPath}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = yaml.load(content) as EmitCatalog;
    return parsed?.events ? parsed : null;
  } catch {
    return null;
  }
}

export function getChangedFiles(baseRef: string): string[] {
  try {
    const output = execSync(`git diff --name-only "${baseRef}...HEAD"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function getLastModifier(filePath: string, lineNumber: number): string | null {
  try {
    const output = execSync(
      `git log -1 --format="%an" -L ${lineNumber},${lineNumber}:"${filePath}"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return output.split("\n")[0] || null;
  } catch {
    return null;
  }
}

export function getRelativeCatalogPath(absolutePath: string): string {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return absolutePath.startsWith(root)
      ? absolutePath.slice(root.length + 1)
      : absolutePath;
  } catch {
    return absolutePath;
  }
}
