import type { CodeContext, CallSite, SdkType } from "../../types/index.js";
import { searchDirect, searchConstant, searchBroad, searchDiscriminatorValue, generateCasingVariants, filterExactEventMatches } from "./search.js";
import { extractContext, resolveEnumStringValue } from "./context.js";

export class RepoScanner {
  private paths: string[];
  private sdk: SdkType;
  private customPatterns: string[];
  private backendPatterns: string[];

  constructor(opts: {
    paths: string[];
    sdk: SdkType;
    trackPattern?: string | string[];
    backendPatterns?: string[];
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
    this.backendPatterns = opts.backendPatterns ?? [];
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
        all_call_sites: allCallSites,
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
          all_call_sites: allCallSites,
        };
      }
    }

    // ── Strategy 3: broad search fallback ────────────────────────────
    // Search for all casing variants without pattern filtering,
    // then pick the best match near a tracking call.
    const broadMatches = await searchBroad(eventName, this.paths);
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
        all_call_sites: allCallSites,
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
    const matches = await searchDiscriminatorValue(value, this.paths);

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
