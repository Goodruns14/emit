import * as fs from "fs";
import type { BackendPatternConfig, CodeContext, CallSite, SdkType } from "../../types/index.js";
import { searchDirect, searchConstant, searchBroad, searchDiscriminatorValue, generateCasingVariants, filterExactEventMatches, hasNearbyTrackingCall, SDK_PATTERNS } from "./search.js";
import { extractContext, resolveEnumStringValue } from "./context.js";

/** Cap per reference-file body so the LLM prompt never explodes. */
const CONTEXT_FILE_MAX_BYTES = 8 * 1024;

export class RepoScanner {
  private paths: string[];
  private sdk: SdkType;
  private customPatterns: string[];
  private backendPatterns: string[];
  /** pattern → list of reference-file paths to attach when it matches. */
  private contextFilesByPattern: Map<string, string[]>;
  /** Per-scan cache of loaded file contents (path → content, trimmed). */
  private contextFileCache: Map<string, string>;

  constructor(opts: {
    paths: string[];
    sdk: SdkType;
    trackPattern?: string | string[];
    backendPatterns?: BackendPatternConfig[];
  }) {
    this.paths = opts.paths;
    this.sdk = opts.sdk;
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
      this.sdk,
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
        this.sdk,
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
    const sdkPatterns = this.sdk === "custom"
      ? this.customPatterns
      : SDK_PATTERNS[this.sdk] ?? [];
    const allTrackingPatterns = [...sdkPatterns, ...this.customPatterns, ...this.backendPatterns];
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
