import type { CodeContext, CallSite, SdkType } from "../../types/index.js";
import { searchDirect, searchConstant } from "./search.js";
import { extractContext, resolveEnumStringValue } from "./context.js";

export class RepoScanner {
  private paths: string[];
  private sdk: SdkType;
  private customPattern?: string;

  constructor(opts: {
    paths: string[];
    sdk: SdkType;
    trackPattern?: string;
  }) {
    this.paths = opts.paths;
    this.sdk = opts.sdk;
    this.customPattern = opts.trackPattern;
  }

  async findEvent(eventName: string): Promise<CodeContext> {
    // ── Strategy 1: direct string search ──────────────────────────────
    const directMatches = await searchDirect(
      eventName,
      this.paths,
      this.sdk,
      this.customPattern
    );

    if (directMatches.length > 0) {
      const primary = directMatches[0];
      const allCallSites: CallSite[] = directMatches.map((m) => ({
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

    // ── Strategy 2: constant name search (e.g. ENTITY_DOWNLOAD) ───────
    const constantName = eventName.toUpperCase().replace(/-/g, "_").replace(/\s/g, "_");
    const constantMatches = await searchConstant(
      constantName,
      this.paths,
      this.sdk,
      this.customPattern
    );

    if (constantMatches.length > 0) {
      const primary = constantMatches[0];
      const segmentEventName = resolveEnumStringValue(constantName, this.paths) ?? undefined;
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

    // ── Not found ──────────────────────────────────────────────────────
    return {
      file_path: "",
      line_number: 0,
      context: "",
      match_type: "not_found",
      all_call_sites: [],
    };
  }
}
