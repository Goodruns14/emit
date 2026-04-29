/**
 * Schema-file ingestion for producer-mode scanning (Day 3).
 *
 * Locates schema files (.avsc / .proto / .json schema) near a publish call
 * site and reads them into LLM context. This is what unlocks high-confidence
 * payload extraction on fixtures that ship schemas separately from code:
 *   - ably-ticket-kafka: Avro `.avsc` files in schemas/ directory
 *   - kafka-protobuf: `.proto` file referenced via generated Java classes
 *
 * Strategies, in priority order:
 *   1. Explicit path in context — `Path('schemas/booking-schema.avsc')` etc.
 *   2. `schemas/` directory near the configured scan paths
 *   3. Protobuf message-name lookup — for `SomeMessage` references, find a
 *      `.proto` declaring `message SomeMessage { ... }`
 *
 * Best-effort: if no schema is found, the call returns an empty list.
 * Phase 1 doesn't try to surface a "schema_file_not_resolved" signal — that
 * would be a Tier 2 emit-fix concern (Day 4.7), not first-class extraction.
 */

import * as fs from "fs";
import * as path from "node:path";
import { execSync } from "child_process";

/** Per-scan cache to avoid re-reading the same schema for multiple call sites. */
const _schemaCache = new Map<string, string | null>();

/** Cap content per schema file. Keeps prompt size bounded. */
const SCHEMA_FILE_MAX_BYTES = 4 * 1024;

/** Cap total schema files attached per call site. */
const MAX_SCHEMA_FILES = 4;

/**
 * Strategy 1: pull explicit schema-file paths out of the context.
 * Matches string literals ending in .avsc / .proto / .json.
 *
 * Conservative — the .json case requires the surrounding code to look like a
 * schema reference (avoids matching arbitrary JSON config files):
 *   - "$schema" or "$id" nearby
 *   - JSON Schema-related identifiers
 *   - Or the filename suggests it (schema.json, *-schema.json)
 */
const SCHEMA_PATH_PATTERN = /['"`]([^'"`\n]*\.(?:avsc|proto))['"`]|['"`]([^'"`\n]*(?:schema|Schema)[^'"`\n]*\.json)['"`]/g;

function fromExplicitPaths(
  contextSrc: string,
  scanPaths: string[],
): { path: string; content: string }[] {
  const found = new Map<string, string>();
  for (const m of contextSrc.matchAll(SCHEMA_PATH_PATTERN)) {
    const candidate = m[1] ?? m[2];
    if (!candidate) continue;
    const resolved = resolveAgainstPaths(candidate, scanPaths);
    if (!resolved || found.has(resolved)) continue;
    const content = readSchemaFile(resolved);
    if (content) found.set(resolved, content);
  }
  return Array.from(found, ([p, c]) => ({ path: p, content: c }));
}

/**
 * Strategy 2: walk a `schemas/` (or `schema/`) directory adjacent to each
 * scan path. Standard Avro / Protobuf / Schema-Registry layout.
 */
function fromSchemasDirectory(scanPaths: string[]): { path: string; content: string }[] {
  const found = new Map<string, string>();
  const candidateDirs: string[] = [];
  for (const root of scanPaths) {
    candidateDirs.push(path.join(root, "schemas"));
    candidateDirs.push(path.join(root, "schema"));
    candidateDirs.push(path.join(root, "src/main/protobuf"));
    candidateDirs.push(path.join(root, "src/main/avro"));
    candidateDirs.push(path.join(root, "src/main/resources/schemas"));
  }
  for (const dir of candidateDirs) {
    let entries: string[];
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) continue;
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.match(/\.(avsc|proto)$/) && !entry.match(/(?:schema|Schema).*\.json$/)) continue;
      const fullPath = path.join(dir, entry);
      if (found.has(fullPath)) continue;
      const content = readSchemaFile(fullPath);
      if (content) found.set(fullPath, content);
    }
  }
  return Array.from(found, ([p, c]) => ({ path: p, content: c }));
}

/**
 * Strategy 3: protobuf message-name lookup. When the context references
 * `SimpleMessage` (or a class generated from `SimpleMessage.proto`),
 * grep `.proto` files in the scan paths for a `message SimpleMessage {`
 * declaration.
 *
 * This catches the kafka-protobuf case where the publish code has
 * `new ProducerRecord<>(topic, null, simpleMessage)` and the actual schema
 * lives in `src/main/protobuf/SimpleMessage.proto`.
 */
const PROTO_MESSAGE_REF_PATTERN = /\b([A-Z][a-zA-Z0-9_]{3,}(?:Message|Event|Command|Notification|Record))\b/g;
const PROTO_REF_BLOCKLIST = new Set([
  "Message", "Event", "Command", "Record",
  "BaseEvent", "DomainEvent", "MessageHandler", "MessageEvent",
]);

function fromProtoMessageLookup(
  contextSrc: string,
  scanPaths: string[],
): { path: string; content: string }[] {
  const refs = new Set<string>();
  for (const m of contextSrc.matchAll(PROTO_MESSAGE_REF_PATTERN)) {
    const name = m[1];
    if (!PROTO_REF_BLOCKLIST.has(name)) refs.add(name);
  }
  if (refs.size === 0) return [];

  const found = new Map<string, string>();
  for (const messageName of refs) {
    if (found.size >= MAX_SCHEMA_FILES) break;
    const filePath = locateProtoMessage(messageName, scanPaths);
    if (!filePath || found.has(filePath)) continue;
    const content = readSchemaFile(filePath);
    if (content) found.set(filePath, content);
  }
  return Array.from(found, ([p, c]) => ({ path: p, content: c }));
}

function locateProtoMessage(messageName: string, scanPaths: string[]): string | null {
  for (const root of scanPaths) {
    try {
      const out = execSync(
        `grep -rlE "(message|enum)[[:space:]]+${messageName}[[:space:]]*\\{" ` +
          `--include='*.proto' ` +
          `--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=target ` +
          `${root} 2>/dev/null | head -1`,
        { encoding: "utf8" },
      ).trim();
      if (out) return out;
    } catch {
      // grep returned non-zero (no match) — try next path
    }
  }
  return null;
}

/**
 * Resolve a relative-or-absolute path against scan paths. Returns the
 * first existing file path, or null if none of the candidates exist.
 */
function resolveAgainstPaths(candidate: string, scanPaths: string[]): string | null {
  if (path.isAbsolute(candidate)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      return null;
    }
    return null;
  }
  for (const root of scanPaths) {
    const resolved = path.join(root, candidate);
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // not found, try next
    }
  }
  return null;
}

function readSchemaFile(filePath: string): string | null {
  if (_schemaCache.has(filePath)) return _schemaCache.get(filePath) ?? null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const trimmed = raw.length > SCHEMA_FILE_MAX_BYTES
      ? raw.slice(0, SCHEMA_FILE_MAX_BYTES) + `\n... (truncated, ${raw.length} bytes total)`
      : raw;
    _schemaCache.set(filePath, trimmed);
    return trimmed;
  } catch {
    _schemaCache.set(filePath, null);
    return null;
  }
}

/**
 * Find schema files relevant to a publish call site. Returns up to
 * MAX_SCHEMA_FILES results across all three strategies, deduped by path.
 *
 * Used by `RepoScanner.findAllProducerCallSites` to attach schemas to the
 * extra_context_files list — which the LLM then sees as authoritative
 * payload schema during extraction.
 */
export function findSchemaFiles(
  contextSrc: string,
  scanPaths: string[],
): { path: string; content: string }[] {
  const aggregate = new Map<string, string>();

  for (const file of fromExplicitPaths(contextSrc, scanPaths)) {
    aggregate.set(file.path, file.content);
  }
  if (aggregate.size < MAX_SCHEMA_FILES) {
    for (const file of fromProtoMessageLookup(contextSrc, scanPaths)) {
      if (aggregate.size >= MAX_SCHEMA_FILES) break;
      if (!aggregate.has(file.path)) aggregate.set(file.path, file.content);
    }
  }
  if (aggregate.size === 0) {
    // Fallback to schemas/ directory only when no explicit-path or proto-name
    // resolution found anything. Avoids attaching unrelated schemas when the
    // call site already pointed at a specific file.
    for (const file of fromSchemasDirectory(scanPaths)) {
      if (aggregate.size >= MAX_SCHEMA_FILES) break;
      aggregate.set(file.path, file.content);
    }
  }

  return Array.from(aggregate, ([p, c]) => ({ path: p, content: c })).slice(0, MAX_SCHEMA_FILES);
}
