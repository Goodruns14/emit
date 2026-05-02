import { execFileSync } from "child_process";
import * as fs from "fs";
import * as yaml from "js-yaml";
import type { EmitCatalog, CatalogEvent } from "../types/index.js";
import { isCatalogDirectory, slugifyEventName } from "../core/catalog/index.js";

export interface CommitEntry {
  sha: string;
  date: string;
  message: string;
}

export function getCurrentCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export function getCatalogHistory(filePath: string): CommitEntry[] {
  try {
    // For directory mode, track history of the _index.yml file
    const trackPath = isCatalogDirectory(filePath)
      ? `${filePath}/_index.yml`
      : filePath;

    const output = execFileSync(
      "git",
      ["log", "--follow", "--format=%H|%ai|%s", "--", trackPath],
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
  // Try directory mode first if the path looks like a directory catalog
  if (isCatalogDirectory(catalogFile)) {
    const result = getEventAtCommitDirectory(catalogFile, eventName, sha);
    if (result) return result;
    // Fall back to single-file (pre-migration history): try with .yml appended
    return getEventAtCommitFile(`${catalogFile}.yml`, eventName, sha);
  }

  return getEventAtCommitFile(catalogFile, eventName, sha);
}

function getEventAtCommitFile(
  catalogFile: string,
  eventName: string,
  sha: string
): CatalogEvent | null {
  try {
    const content = execFileSync("git", ["show", `${sha}:${catalogFile}`], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const catalog = yaml.load(content) as EmitCatalog;
    return catalog?.events?.[eventName] ?? null;
  } catch {
    return null;
  }
}

function getEventAtCommitDirectory(
  catalogDir: string,
  eventName: string,
  sha: string
): CatalogEvent | null {
  try {
    // Try the direct slug path first
    const slug = slugifyEventName(eventName);
    const eventPath = `${catalogDir}/events/${slug}.yml`;
    const content = execFileSync("git", ["show", `${sha}:${eventPath}`], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const parsed = yaml.load(content) as Record<string, CatalogEvent>;
    if (parsed?.[eventName]) return parsed[eventName];

    // If the slug file exists but doesn't have the exact event name,
    // scan all event files at that commit
    return scanEventFilesAtCommit(catalogDir, eventName, sha);
  } catch {
    // Direct slug file doesn't exist at that commit — try scanning
    return scanEventFilesAtCommit(catalogDir, eventName, sha);
  }
}

function scanEventFilesAtCommit(
  catalogDir: string,
  eventName: string,
  sha: string
): CatalogEvent | null {
  try {
    const listing = execFileSync(
      "git",
      ["ls-tree", "--name-only", sha, `${catalogDir}/events/`],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    if (!listing) return null;

    for (const filePath of listing.split("\n").filter(Boolean)) {
      if (!filePath.endsWith(".yml") && !filePath.endsWith(".yaml")) continue;
      try {
        const content = execFileSync("git", ["show", `${sha}:${filePath}`], {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        const parsed = yaml.load(content) as Record<string, CatalogEvent>;
        if (parsed?.[eventName]) return parsed[eventName];
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function isGitRepo(cwd?: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
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
  if (isCatalogDirectory(catalogPath)) {
    return getCatalogAtRefDirectory(ref, catalogPath);
  }
  return getCatalogAtRefFile(ref, catalogPath);
}

function getCatalogAtRefFile(ref: string, catalogPath: string): EmitCatalog | null {
  try {
    const content = execFileSync("git", ["show", `${ref}:${catalogPath}`], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = yaml.load(content) as EmitCatalog;
    return parsed?.events ? parsed : null;
  } catch {
    return null;
  }
}

function getCatalogAtRefDirectory(ref: string, catalogDir: string): EmitCatalog | null {
  try {
    // Read _index.yml at ref
    const indexContent = execFileSync(
      "git",
      ["show", `${ref}:${catalogDir}/_index.yml`],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const index = yaml.load(indexContent) as any;
    if (!index || typeof index !== "object") return null;

    // Enumerate event files at ref
    const listing = execFileSync(
      "git",
      ["ls-tree", "--name-only", ref, `${catalogDir}/events/`],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    const events: Record<string, CatalogEvent> = {};
    if (listing) {
      for (const filePath of listing.split("\n").filter(Boolean)) {
        if (!filePath.endsWith(".yml") && !filePath.endsWith(".yaml")) continue;
        try {
          const content = execFileSync("git", ["show", `${ref}:${filePath}`], {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          const parsed = yaml.load(content) as Record<string, CatalogEvent>;
          if (parsed && typeof parsed === "object") {
            for (const [name, data] of Object.entries(parsed)) {
              events[name] = data;
            }
          }
        } catch {
          continue;
        }
      }
    }

    return {
      version: index.version,
      generated_at: index.generated_at,
      commit: index.commit,
      stats: index.stats,
      property_definitions: index.property_definitions ?? {},
      events,
      not_found: index.not_found ?? [],
      resolved: index.resolved,
    } as EmitCatalog;
  } catch {
    // Directory doesn't exist at that ref — try single-file fallback
    return getCatalogAtRefFile(ref, `${catalogDir}.yml`);
  }
}

export function getChangedFiles(baseRef: string): string[] {
  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", `${baseRef}...HEAD`],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function getLastModifier(filePath: string, lineNumber: number): string | null {
  if (!Number.isInteger(lineNumber) || lineNumber < 1) return null;
  try {
    const output = execFileSync(
      "git",
      ["log", "-1", "--format=%an", `-L${lineNumber},${lineNumber}:${filePath}`],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return output.split("\n")[0] || null;
  } catch {
    return null;
  }
}

export function getRelativeCatalogPath(absolutePath: string): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
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
