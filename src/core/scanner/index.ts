import * as fs from "fs";
import { execa } from "execa";
import type { BackendPatternConfig, CodeContext, CallSite, SdkType } from "../../types/index.js";
import { searchDirect, searchConstant, searchBroad, searchDiscriminatorValue, generateCasingVariants, filterExactEventMatches, hasNearbyTrackingCall, parseCallSites, buildExcludeArgs, SDK_PATTERNS } from "./search.js";
import { producerPatterns } from "./backend-patterns.js";
import { extractContext, resolveEnumStringValue, isOutboxFile, findEventClassDefinitions } from "./context.js";
import { findSchemaFiles } from "./schema-files.js";

/** Cap per reference-file body so the LLM prompt never explodes. */
const CONTEXT_FILE_MAX_BYTES = 8 * 1024;

export class RepoScanner {
  private paths: string[];
  /**
   * SDK families this scanner is configured for. Stored as an array so
   * multi-broker services (e.g. SQS-in / Google-Pub/Sub-out transformers)
   * can union patterns from multiple SDKs in one scan. Single-SDK callers
   * still pass a string — the constructor normalizes.
   */
  private sdks: SdkType[];
  private customPatterns: string[];
  private backendPatterns: string[];
  /** pattern → list of reference-file paths to attach when it matches. */
  private contextFilesByPattern: Map<string, string[]>;
  /** Per-scan cache of loaded file contents (path → content, trimmed). */
  private contextFileCache: Map<string, string>;

  /**
   * Primary SDK — used by call sites that still expect a single value
   * (legacy paths, log messages). For multi-SDK configs this is the first
   * entry; the full set is used internally for pattern enumeration.
   */
  get sdk(): SdkType {
    return this.sdks[0] ?? "custom";
  }

  constructor(opts: {
    paths: string[];
    sdk: SdkType | SdkType[];
    trackPattern?: string | string[];
    backendPatterns?: BackendPatternConfig[];
  }) {
    this.paths = opts.paths;
    this.sdks = Array.isArray(opts.sdk) ? opts.sdk : [opts.sdk];
    if (this.sdks.length === 0) this.sdks = ["custom"];
    if (!opts.trackPattern) {
      this.customPatterns = [];
    } else if (Array.isArray(opts.trackPattern)) {
      this.customPatterns = opts.trackPattern;
    } else {
      this.customPatterns = [opts.trackPattern];
    }

    this.backendPatterns = [];
    this.contextFilesByPattern = new Map();
    this.contextFileCache = new Map();
    for (const entry of opts.backendPatterns ?? []) {
      if (typeof entry === "string") {
        this.backendPatterns.push(entry);
      } else {
        this.backendPatterns.push(entry.pattern);
        if (entry.context_files?.length) {
          this.contextFilesByPattern.set(entry.pattern, entry.context_files);
        }
      }
    }
  }

  /**
   * Load reference helper files for a call site.
   *
   * Preference order:
   *  1. If the scanner already identified a matched pattern (direct/constant/
   *     broad strategies record `matchedPattern`), use that pattern's configured
   *     files directly — zero extra I/O.
   *  2. Otherwise (or if the matched pattern has no configured files), scan a
   *     ±5-line window around the match for any configured pattern. This
   *     handles multi-line calls where the helper name sits on one line and
   *     the enum/event name on another (the single-line grep hit may land on
   *     the enum line, a line or two away from the pattern).
   *
   * Files are read once per scan and memoized. Each body is truncated to
   * CONTEXT_FILE_MAX_BYTES so the LLM prompt stays bounded.
   */
  private loadContextFilesFor(
    matchedPattern: string | undefined,
    fallbackFile?: string,
    fallbackLine?: number,
  ): CodeContext["extra_context_files"] {
    if (this.contextFilesByPattern.size === 0) return undefined;

    let pattern: string | undefined =
      matchedPattern && this.contextFilesByPattern.has(matchedPattern)
        ? matchedPattern
        : undefined;

    if (!pattern && fallbackFile && fallbackLine) {
      // Scan a window around the match for any configured pattern.
      try {
        const content = fs.readFileSync(fallbackFile, "utf8");
        const lines = content.split("\n");
        const start = Math.max(0, fallbackLine - 1 - 5);
        const end = Math.min(lines.length, fallbackLine - 1 + 5);
        const window = lines.slice(start, end).join("\n");
        for (const p of this.contextFilesByPattern.keys()) {
          if (window.includes(p)) {
            pattern = p;
            break;
          }
        }
      } catch {
        // file unreadable — fall through, no extras attached
      }
    }

    if (!pattern) return undefined;

    const paths = this.contextFilesByPattern.get(pattern) ?? [];
    const files: { path: string; content: string }[] = [];
    for (const p of paths) {
      let content = this.contextFileCache.get(p);
      if (content === undefined) {
        try {
          content = fs.readFileSync(p, "utf8");
          if (content.length > CONTEXT_FILE_MAX_BYTES) {
            content =
              content.slice(0, CONTEXT_FILE_MAX_BYTES) +
              `\n\n/* …truncated, file is ${content.length} bytes; first ${CONTEXT_FILE_MAX_BYTES} shown */`;
          }
          this.contextFileCache.set(p, content);
        } catch {
          content = "";
          this.contextFileCache.set(p, content);
        }
      }
      if (content) files.push({ path: p, content });
    }
    return files.length > 0 ? files : undefined;
  }

  async findEvent(eventName: string): Promise<CodeContext> {
    // ── Strategy 1: direct string search ──────────────────────────────
    const directMatches = await searchDirect(
      eventName,
      this.paths,
      this.sdks,
      this.customPatterns,
      this.backendPatterns
    );

    if (directMatches.length > 0) {
      // Filter out substring matches (e.g. "Create Comment" matching "Create Comment Failed")
      const exactMatches = filterExactEventMatches(directMatches, eventName);
      const primary = exactMatches[0];
      const allCallSites: CallSite[] = exactMatches.map((m) => ({
        file_path: m.file,
        line_number: m.line,
        context: extractContext(m.file, m.line, 15),
      }));

      return {
        file_path: primary.file,
        line_number: primary.line,
        context: extractContext(primary.file, primary.line, 50),
        match_type: "direct",
        track_pattern: exactMatches[0]?.matchedPattern,
        all_call_sites: allCallSites,
        extra_context_files: this.loadContextFilesFor(
          exactMatches[0]?.matchedPattern,
          primary.file,
          primary.line,
        ),
      };
    }

    // ── Strategy 2: constant/enum search with casing variants ─────────
    // Try UPPER_SNAKE_CASE, PascalCase, camelCase, etc.
    const variants = generateCasingVariants(eventName);
    for (const variant of variants) {
      if (variant === eventName) continue; // already tried in direct search
      const constantMatches = await searchConstant(
        variant,
        this.paths,
        this.sdks,
        this.customPatterns,
        this.backendPatterns
      );

      if (constantMatches.length > 0) {
        const primary = constantMatches[0];
        const segmentEventName = resolveEnumStringValue(variant, this.paths) ?? undefined;
        const allCallSites: CallSite[] = constantMatches.map((m) => ({
          file_path: m.file,
          line_number: m.line,
          context: extractContext(m.file, m.line, 15),
        }));

        return {
          file_path: primary.file,
          line_number: primary.line,
          context: extractContext(primary.file, primary.line, 50),
          match_type: "constant",
          segment_event_name: segmentEventName,
          track_pattern: constantMatches[0]?.matchedPattern,
          all_call_sites: allCallSites,
          extra_context_files: this.loadContextFilesFor(
            constantMatches[0]?.matchedPattern,
            primary.file,
            primary.line,
          ),
        };
      }
    }

    // ── Strategy 3: broad search fallback ────────────────────────────
    // Search for all casing variants without pattern filtering. Because this
    // is case-insensitive and pattern-agnostic, fuzzy hits like comments,
    // GraphQL field names, or stray identifiers can easily match. Require at
    // least one match to sit near a real tracking call; otherwise treat as
    // not_found rather than saddling the catalog with a phantom event.
    const broadMatchesRaw = await searchBroad(eventName, this.paths);
    // Multi-SDK aware — collect patterns from each configured SDK and union.
    const sdkPatterns = this.sdks.flatMap((s) =>
      s === "custom" ? this.customPatterns : (SDK_PATTERNS[s] ?? [])
    );
    const allTrackingPatterns = Array.from(new Set([
      ...sdkPatterns,
      ...this.customPatterns,
      ...this.backendPatterns,
    ]));
    const broadMatches = allTrackingPatterns.length > 0
      ? broadMatchesRaw.filter((m) => hasNearbyTrackingCall(m.file, m.line, allTrackingPatterns))
      : broadMatchesRaw;
    if (broadMatches.length > 0) {
      const primary = broadMatches[0];
      const allCallSites: CallSite[] = broadMatches.slice(0, 10).map((m) => ({
        file_path: m.file,
        line_number: m.line,
        context: extractContext(m.file, m.line, 15),
      }));

      return {
        file_path: primary.file,
        line_number: primary.line,
        context: extractContext(primary.file, primary.line, 50),
        match_type: "broad",
        track_pattern: broadMatches[0]?.matchedPattern,
        all_call_sites: allCallSites,
        extra_context_files: this.loadContextFilesFor(
          broadMatches[0]?.matchedPattern,
          primary.file,
          primary.line,
        ),
      };
    }

    // ── Not found ──────────────────────────────────────────────────────
    return {
      file_path: "",
      line_number: 0,
      context: "",
      match_type: "not_found",
      all_call_sites: [],
    };
  }

  /**
   * Producer-mode discovery: enumerate all publish call sites in scope by
   * grepping for each producer-kind pattern from backend-patterns.ts (filtered
   * by the configured SDK), then extracting a context window around each
   * match.
   *
   * Returns one CodeContext per call site. The caller (scan command) then
   * runs producer-mode extraction on each context — the LLM derives the topic
   * name and payload schema from the surrounding code.
   *
   * Unlike findEvent, this method does NOT require an event name upfront —
   * it's the entry point for the "discover what events this service publishes"
   * UX. findEvent stays the manual-loop entry point.
   *
   * Custom track patterns (from config.repo.track_pattern) and user-declared
   * backend_patterns are also scanned, treated as producer patterns. This
   * lets a user with a custom EventBus wrapper class declare the wrapper
   * name in track_pattern and have it discovered alongside Kafka/SNS/etc.
   */
  async findAllProducerCallSites(): Promise<CodeContext[]> {
    // Pull producer-kind patterns for each configured SDK from
    // backend-patterns.ts and union them. Multi-SDK configs (e.g. a service
    // that both consumes from SQS and publishes to Google Pub/Sub) get all
    // patterns from each SDK in one scan. Custom and user-declared patterns
    // are also included — when a user declares
    // track_pattern: "eventBus.fire(", that wrapper gets discovered.
    const sdkPatterns = this.sdks.flatMap((s) =>
      s === "custom" ? [] : producerPatterns(s),
    );
    const allPatterns = Array.from(
      new Set([...sdkPatterns, ...this.customPatterns, ...this.backendPatterns]),
    ).filter(Boolean);

    if (allPatterns.length === 0) {
      // Misconfigured: producer mode with sdk=custom and no patterns. Caller
      // should surface a clearer error; we return empty to keep the scanner
      // pure.
      return [];
    }

    // Run one grep per pattern, in parallel across paths. Aggregate matches.
    const matchTasks: Promise<{ file: string; line: number; rawLine: string; matchedPattern: string }[]>[] = [];
    for (const pattern of allPatterns) {
      for (const searchPath of this.paths) {
        matchTasks.push(
          execa(
            "grep",
            [
              "-rn",
              "--fixed-strings",
              pattern,
              searchPath,
              ...buildExcludeArgs(),
            ],
            { reject: false },
          )
            .then(({ stdout }) => {
              if (!stdout.trim()) return [];
              return parseCallSites(stdout).map((m) => ({
                ...m,
                matchedPattern: pattern,
              }));
            })
            .catch(() => []),
        );
      }
    }

    const allHits = (await Promise.all(matchTasks)).flat();
    if (allHits.length === 0) return [];

    // Dedupe by file:line — a line containing two patterns (e.g. a generic
    // wrapper that calls into a specific SDK) shouldn't produce two contexts.
    // First pattern wins for the matched_pattern label.
    const byFileLine = new Map<string, { file: string; line: number; rawLine: string; matchedPattern: string }>();
    for (const hit of allHits) {
      const key = `${hit.file}:${hit.line}`;
      if (!byFileLine.has(key)) byFileLine.set(key, hit);
    }

    // Build a CodeContext per unique call site. Each context becomes the
    // input to one extraction LLM call.
    const contexts: CodeContext[] = [];
    for (const hit of byFileLine.values()) {
      // Outbox detection happens inside extractContext (it widens the
      // window to whole-file when both halves of the pattern are present).
      // We also flag it on the CodeContext so the catalog reconciler can
      // add a deterministic outbox_pattern flag to the entry — independent
      // of whether the LLM noticed.
      let isOutbox = false;
      try {
        const fileContent = fs.readFileSync(hit.file, "utf8");
        isOutbox = isOutboxFile(fileContent);
      } catch {
        // file unreadable — leave as false
      }

      const contextSrc = extractContext(hit.file, hit.line, 50);

      // Event-class follow-through (Day 4.5): when the publish call references
      // typed event classes (CQRS, DDD-style), find their definitions and
      // attach them so the LLM can extract proper payload schema. This is
      // what unlocks high-confidence extraction on event-class fixtures
      // like aleks-cqrs-eventsourcing.
      const declaredExtras = this.loadContextFilesFor(hit.matchedPattern, hit.file, hit.line) ?? [];
      const discoveredEventClasses = findEventClassDefinitions(contextSrc, this.paths);

      // Schema-file ingestion (Day 3): locate .avsc / .proto / .json schema
      // files near the call site (explicit paths in code, schemas/ directory,
      // or .proto files declaring referenced message types) and attach them
      // as authoritative payload schema. Tier 1 — no user config required
      // for the standard layouts (schemas/, src/main/protobuf/, etc.).
      const discoveredSchemas = findSchemaFiles(contextSrc, this.paths);

      const extraContextFiles = [...declaredExtras, ...discoveredEventClasses, ...discoveredSchemas];

      contexts.push({
        file_path: hit.file,
        line_number: hit.line,
        context: contextSrc,
        match_type: "direct",
        track_pattern: hit.matchedPattern,
        all_call_sites: [
          {
            file_path: hit.file,
            line_number: hit.line,
            context: extractContext(hit.file, hit.line, 15),
          },
        ],
        extra_context_files: extraContextFiles.length > 0 ? extraContextFiles : undefined,
        outbox_detected: isOutbox,
      });
    }

    // Sort for stable output: file path then line number. Keeps the harness
    // and downstream catalogs deterministic across runs.
    contexts.sort((a, b) => {
      if (a.file_path !== b.file_path) return a.file_path.localeCompare(b.file_path);
      return a.line_number - b.line_number;
    });

    return contexts;
  }

  async findDiscriminatorValue(value: string): Promise<CodeContext> {
    const matches = await searchDiscriminatorValue(value, this.paths, this.customPatterns);

    if (matches.length > 0) {
      const primary = matches[0];
      const allCallSites: CallSite[] = matches.slice(0, 10).map((m) => ({
        file_path: m.file,
        line_number: m.line,
        context: extractContext(m.file, m.line, 15),
      }));

      return {
        file_path: primary.file,
        line_number: primary.line,
        context: extractContext(primary.file, primary.line, 50),
        match_type: "discriminator",
        all_call_sites: allCallSites,
        // Discriminator sub-events typically share the parent's call-site
        // context (same wrapper, same helper). Run the same window scan so
        // configured helper files are attached here too.
        extra_context_files: this.loadContextFilesFor(undefined, primary.file, primary.line),
      };
    }

    return {
      file_path: "",
      line_number: 0,
      context: "",
      match_type: "not_found",
      all_call_sites: [],
    };
  }
}
