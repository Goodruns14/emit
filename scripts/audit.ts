#!/usr/bin/env npx tsx
/**
 * Emit Audit Agent — Independent validation of emit scan output
 *
 * This script independently greps for ALL tracking calls in a repo,
 * extracts ground truth (event names, properties, static/dynamic),
 * runs `emit scan`, and diffs the results.
 *
 * Usage:
 *   npx tsx scripts/audit.ts <repo-path> [--pattern "analytics.track("] [--sdk segment] [--emit-scan]
 *
 * Does NOT use emit's scanner code — fully independent validation.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml"; // emit already has this dep

// ─── Types ─────────────────────────────────────────────────────────

interface AuditCallSite {
  file: string;
  line: number;
  rawLine: string;
  eventName: string | null;
  eventNameType: "string_literal" | "constant" | "template_literal" | "variable" | "unknown";
  properties: AuditProperty[];
  rawContext: string;
  functionScope: string | null;
}

interface AuditProperty {
  name: string;
  type: "static_string" | "static_number" | "static_boolean" | "dynamic" | "computed" | "spread" | "shorthand";
  value?: string;
}

interface EmitCatalogEvent {
  event_name: string;
  properties?: Record<string, any>;
  code_location?: { file_path: string; line_number: number };
  all_call_sites?: Array<{ file_path: string; line_number: number }>;
  status?: string;
}

interface DiffResult {
  eventName: string;
  inGroundTruth: boolean;
  inEmitCatalog: boolean;
  groundTruthSites: number;
  emitCallSites: number;
  propertiesCorrect: string[];
  propertiesMissing: string[];
  propertiesFalsePositive: string[];
  issues: string[];
}

interface AuditReport {
  repo: string;
  pattern: string;
  sdk: string;
  timestamp: string;
  discovery: {
    totalCallSites: number;
    uniqueEvents: number;
    stringLiteralEvents: number;
    constantEvents: number;
    templateLiteralEvents: number;
    variableEvents: number;
    unknownEvents: number;
  };
  groundTruth: Map<string, AuditCallSite[]>;
  emitEvents: EmitCatalogEvent[];
  diff: DiffResult[];
  concerns: ConcernCheck[];
}

interface ConcernCheck {
  concern: string;
  status: "pass" | "fail" | "warning" | "not_applicable";
  details: string;
  affectedEvents?: string[];
}

// ─── Config Loading ────────────────────────────────────────────────

function loadRepoConfig(repoPath: string): {
  patterns: string[];
  sdk: string;
  scanPaths: string[];
  manualEvents: string[];
} {
  const configPath = path.join(repoPath, "emit.config.yml");
  if (!fs.existsSync(configPath)) {
    console.error(`No emit.config.yml found at ${repoPath}`);
    process.exit(1);
  }

  const raw = yaml.load(fs.readFileSync(configPath, "utf8")) as any;
  const sdk = raw?.repo?.sdk ?? "custom";
  const scanPaths = (raw?.repo?.paths ?? ["."]).map((p: string) =>
    path.resolve(repoPath, p)
  );
  const manualEvents = raw?.manual_events ?? [];

  let patterns: string[] = [];
  if (raw?.repo?.track_pattern) {
    patterns = Array.isArray(raw.repo.track_pattern)
      ? raw.repo.track_pattern
      : [raw.repo.track_pattern];
  } else if (sdk === "segment") {
    patterns = ["analytics.track(", "Analytics.track("];
  } else if (sdk === "rudderstack") {
    patterns = ["rudderanalytics.track("];
  }

  return { patterns, sdk, scanPaths, manualEvents };
}

// ─── Independent Discovery ─────────────────────────────────────────

const FILE_EXTS = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.py", "*.go", "*.java", "*.kt", "*.swift"];
const EXCLUDE_DIRS = ["node_modules", ".git", "dist", "build", "bazel-", "__pycache__", ".next", "coverage"];

function grepForPattern(pattern: string, searchPaths: string[]): string[] {
  const excludeArgs = EXCLUDE_DIRS.map(d => `--exclude-dir=${d}`).join(" ");
  const includeArgs = FILE_EXTS.map(e => `--include=${e}`).join(" ");
  const results: string[] = [];

  for (const searchPath of searchPaths) {
    try {
      // Use grep -F for fixed-string matching (no regex interpretation)
      const cmd = `grep -rn -F "${pattern}" "${searchPath}" ${includeArgs} ${excludeArgs} 2>/dev/null || true`;
      const output = execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
      if (output.trim()) {
        results.push(...output.trim().split("\n"));
      }
    } catch {
      // grep returns 1 for no matches
    }
  }

  return results;
}

function isCommentOrImport(codeLine: string): boolean {
  const trimmed = codeLine.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("#") ||
    /^\s*(import\s|from\s|require\()/.test(trimmed) ||
    // Test file mocks/assertions
    /^\s*(expect|assert|describe|it|test)\s*\(/.test(trimmed) ||
    // String inside a comment at end of line
    /^\s*\*\s/.test(trimmed)
  );
}

function parseGrepLine(line: string): { file: string; lineNum: number; code: string } | null {
  // Format: file:lineNum:code
  const firstColon = line.indexOf(":");
  if (firstColon === -1) return null;
  const secondColon = line.indexOf(":", firstColon + 1);
  if (secondColon === -1) return null;

  const file = line.slice(0, firstColon);
  const lineNum = parseInt(line.slice(firstColon + 1, secondColon));
  const code = line.slice(secondColon + 1);

  if (isNaN(lineNum)) return null;
  return { file, lineNum, code };
}

// ─── Event Name Extraction ─────────────────────────────────────────

function extractEventName(
  code: string,
  fullContext: string,
  pattern: string
): { name: string | null; type: AuditCallSite["eventNameType"] } {
  // Find the pattern in the code, then extract the first argument
  const patIdx = code.indexOf(pattern);
  if (patIdx === -1) {
    // Try in full context for multi-line calls
    const ctxIdx = fullContext.indexOf(pattern);
    if (ctxIdx === -1) return { name: null, type: "unknown" };
    return extractEventNameFromArgs(fullContext.slice(ctxIdx + pattern.length));
  }
  return extractEventNameFromArgs(code.slice(patIdx + pattern.length));
}

function extractEventNameFromArgs(argsStr: string): {
  name: string | null;
  type: AuditCallSite["eventNameType"];
} {
  const trimmed = argsStr.trimStart();

  // String literal: 'event_name' or "event_name"
  const strMatch = trimmed.match(/^["'`]([^"'`\n]+)["'`]/);
  if (strMatch) {
    // Check for template literal with interpolation
    if (strMatch[0].startsWith("`") && strMatch[1].includes("${")) {
      return { name: strMatch[1], type: "template_literal" };
    }
    return { name: strMatch[1], type: "string_literal" };
  }

  // Template literal at start
  if (trimmed.startsWith("`")) {
    const endTick = trimmed.indexOf("`", 1);
    if (endTick > 0) {
      return { name: trimmed.slice(1, endTick), type: "template_literal" };
    }
  }

  // Constant reference: SomeEnum.MEMBER or SOME_CONSTANT
  const constMatch = trimmed.match(/^([A-Z][A-Za-z0-9_.]+)/);
  if (constMatch) {
    return { name: constMatch[1], type: "constant" };
  }

  // Variable reference: someVar or something.property
  const varMatch = trimmed.match(/^([a-z][A-Za-z0-9_.[\]]+)/);
  if (varMatch) {
    // Check for common patterns like analytics.event.something
    return { name: varMatch[1], type: "variable" };
  }

  // Newline — event name is on next line in multi-line call
  if (trimmed.startsWith("\n") || trimmed === "") {
    const nextLine = trimmed.trimStart();
    if (nextLine) {
      return extractEventNameFromArgs(nextLine);
    }
  }

  return { name: null, type: "unknown" };
}

// ─── Property Extraction ───────────────────────────────────────────

function extractProperties(
  file: string,
  lineNum: number,
  pattern: string
): AuditProperty[] {
  try {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");

    // Get a window around the call site
    const start = Math.max(0, lineNum - 3);
    const end = Math.min(lines.length, lineNum + 40);
    const window = lines.slice(start, end).join("\n");

    // Find the pattern and then the properties object
    const patIdx = window.indexOf(pattern);
    if (patIdx === -1) return [];

    const afterPattern = window.slice(patIdx + pattern.length);

    // Skip past the event name argument to find the properties object
    // Pattern: eventName, { ... } or eventName, props)
    return extractPropertiesFromArgs(afterPattern);
  } catch {
    return [];
  }
}

function extractPropertiesFromArgs(argsStr: string): AuditProperty[] {
  const props: AuditProperty[] = [];

  // Skip past the first argument (event name) — find the comma after it
  let depth = 0;
  let inString: string | null = null;
  let i = 0;

  // Skip event name argument
  for (; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inString) {
      if (ch === inString && argsStr[i - 1] !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth < 0) return props; // closed the function call, no props arg
    }
    if (ch === "," && depth === 0) {
      i++; // skip the comma
      break;
    }
  }

  const rest = argsStr.slice(i).trimStart();

  // Case 1: Object literal { ... }
  if (rest.startsWith("{")) {
    return parseObjectProperties(rest);
  }

  // Case 2: Variable reference (e.g., `properties` or `data`)
  const varMatch = rest.match(/^([a-zA-Z_]\w*)/);
  if (varMatch) {
    props.push({
      name: `[variable: ${varMatch[1]}]`,
      type: "dynamic",
    });
  }

  return props;
}

function parseObjectProperties(objStr: string): AuditProperty[] {
  const props: AuditProperty[] = [];

  // Simple brace-depth parser to extract the object body
  let depth = 0;
  let bodyStart = -1;
  let bodyEnd = -1;

  for (let i = 0; i < objStr.length; i++) {
    if (objStr[i] === "{") {
      if (depth === 0) bodyStart = i + 1;
      depth++;
    } else if (objStr[i] === "}") {
      depth--;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }

  if (bodyStart === -1 || bodyEnd === -1) return props;

  const body = objStr.slice(bodyStart, bodyEnd);

  // Extract properties line by line
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;

    // Spread operator: ...something
    const spreadMatch = trimmed.match(/^\.\.\.([\w.]+)/);
    if (spreadMatch) {
      props.push({ name: `...${spreadMatch[1]}`, type: "spread" });
      continue;
    }

    // Key-value pairs
    // key: "value" — static string
    const staticStrMatch = trimmed.match(/^(\w+)\s*:\s*["']([^"']*)["']/);
    if (staticStrMatch) {
      props.push({ name: staticStrMatch[1], type: "static_string", value: staticStrMatch[2] });
      continue;
    }

    // key: 123 — static number
    const staticNumMatch = trimmed.match(/^(\w+)\s*:\s*(-?\d+(?:\.\d+)?)\s*[,}]?/);
    if (staticNumMatch) {
      props.push({ name: staticNumMatch[1], type: "static_number", value: staticNumMatch[2] });
      continue;
    }

    // key: true/false — static boolean
    const staticBoolMatch = trimmed.match(/^(\w+)\s*:\s*(true|false)\s*[,}]?/);
    if (staticBoolMatch) {
      props.push({ name: staticBoolMatch[1], type: "static_boolean", value: staticBoolMatch[2] });
      continue;
    }

    // key: expression — dynamic/computed
    const dynamicMatch = trimmed.match(/^(\w+)\s*:\s*(.+?)[\s,}]*$/);
    if (dynamicMatch) {
      const value = dynamicMatch[2].trim();
      // Check if it's a computed expression
      const isComputed = value.includes("(") || value.includes("[") ||
        value.includes("?") || value.includes("+") || value.includes("-") ||
        value.includes("||") || value.includes("&&") || value.includes("??");
      props.push({
        name: dynamicMatch[1],
        type: isComputed ? "computed" : "dynamic",
        value: value.slice(0, 80),
      });
      continue;
    }

    // Shorthand property: just `varName,` or `varName`
    const shorthandMatch = trimmed.match(/^(\w+)\s*[,}]?\s*$/);
    if (shorthandMatch && !["return", "const", "let", "var", "if", "else", "for", "while"].includes(shorthandMatch[1])) {
      props.push({ name: shorthandMatch[1], type: "shorthand" });
      continue;
    }
  }

  return props;
}

// ─── Function Scope Detection (independent impl) ──────────────────

function findFunctionScope(file: string, lineNum: number): string | null {
  try {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");
    const idx = lineNum - 1;

    // Search backwards for function boundary
    for (let i = idx; i >= Math.max(0, idx - 80); i--) {
      const line = lines[i];
      // function declarations
      if (/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/.test(line)) {
        const match = line.match(/function\s+(\w+)/);
        return match ? match[1] : null;
      }
      // arrow functions
      if (/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/.test(line) &&
          (line.includes("=>") || lines[i + 1]?.includes("=>"))) {
        const match = line.match(/(?:const|let|var)\s+(\w+)/);
        return match ? match[1] : null;
      }
      // class methods
      if (/^\s{2,}(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\S+\s*)?\{/.test(line)) {
        const match = line.match(/(?:async\s+)?(\w+)\s*\(/);
        return match ? match[1] : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Read Context Window ───────────────────────────────────────────

function readContext(file: string, lineNum: number, window: number = 10): string {
  try {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");
    const start = Math.max(0, lineNum - 1 - window);
    const end = Math.min(lines.length, lineNum - 1 + window);
    return lines.slice(start, end).join("\n");
  } catch {
    return "";
  }
}

// ─── Emit Catalog Parsing ──────────────────────────────────────────

function parseEmitCatalog(repoPath: string): EmitCatalogEvent[] {
  const catalogPath = path.join(repoPath, "emit.catalog.yml");
  if (!fs.existsSync(catalogPath)) return [];

  try {
    const raw = yaml.load(fs.readFileSync(catalogPath, "utf8")) as any;
    if (!raw?.events || !Array.isArray(raw.events)) return [];
    return raw.events;
  } catch {
    return [];
  }
}

// ─── Concern-Specific Checks ──────────────────────────────────────

function checkArrowFunctionScoping(sites: AuditCallSite[]): ConcernCheck {
  const arrowFuncSites = sites.filter(s => {
    // Check if call site is inside an arrow function
    try {
      const content = fs.readFileSync(s.file, "utf8");
      const lines = content.split("\n");
      const idx = s.line - 1;
      // Look backwards for arrow function pattern
      for (let i = idx; i >= Math.max(0, idx - 20); i--) {
        if (lines[i].includes("=>")) return true;
        if (/^\s*(?:export\s+)?(?:async\s+)?function\s/.test(lines[i])) return false;
      }
    } catch { /* ignore */ }
    return false;
  });

  const noScope = arrowFuncSites.filter(s => !s.functionScope);

  if (arrowFuncSites.length === 0) {
    return {
      concern: "Arrow function scoping",
      status: "not_applicable",
      details: "No tracking calls found inside arrow functions",
    };
  }

  if (noScope.length === 0) {
    return {
      concern: "Arrow function scoping",
      status: "pass",
      details: `All ${arrowFuncSites.length} arrow function call sites have function scope detected`,
    };
  }

  return {
    concern: "Arrow function scoping",
    status: noScope.length > arrowFuncSites.length / 2 ? "fail" : "warning",
    details: `${noScope.length}/${arrowFuncSites.length} arrow function call sites have NO function scope detected`,
    affectedEvents: noScope.map(s => s.eventName ?? "unknown").filter((v, i, a) => a.indexOf(v) === i),
  };
}

function checkCSSContamination(sites: AuditCallSite[], emitEvents: EmitCatalogEvent[]): ConcernCheck {
  const CSS_PROPS = new Set([
    "zIndex", "overflow", "backgroundColor", "background", "margin",
    "marginTop", "marginBottom", "marginLeft", "marginRight",
    "padding", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight",
    "fontSize", "fontWeight", "fontFamily", "lineHeight",
    "textAlign", "textDecoration", "color", "border", "borderRadius",
    "display", "position", "width", "height", "maxWidth", "maxHeight",
    "opacity", "cursor", "transform", "transition", "boxShadow",
    "flexDirection", "justifyContent", "alignItems", "gap",
  ]);

  const contaminated: string[] = [];
  for (const evt of emitEvents) {
    if (!evt.properties) continue;
    const cssProps = Object.keys(evt.properties).filter(p => CSS_PROPS.has(p));
    if (cssProps.length > 0) {
      contaminated.push(`${evt.event_name}: [${cssProps.join(", ")}]`);
    }
  }

  return {
    concern: "CSS-in-JS contamination",
    status: contaminated.length === 0 ? "pass" : "fail",
    details: contaminated.length === 0
      ? "No CSS properties found in emit catalog"
      : `${contaminated.length} events have CSS property contamination`,
    affectedEvents: contaminated,
  };
}

function checkSubstringCollisions(sites: AuditCallSite[]): ConcernCheck {
  const eventNames = [...new Set(sites.map(s => s.eventName).filter(Boolean))] as string[];
  const collisions: string[] = [];

  for (let i = 0; i < eventNames.length; i++) {
    for (let j = 0; j < eventNames.length; j++) {
      if (i === j) continue;
      if (eventNames[j].includes(eventNames[i]) && eventNames[i] !== eventNames[j]) {
        collisions.push(`"${eventNames[i]}" is substring of "${eventNames[j]}"`);
      }
    }
  }

  return {
    concern: "Substring event name collisions",
    status: collisions.length === 0 ? "pass" : "warning",
    details: collisions.length === 0
      ? "No substring collisions found"
      : `${collisions.length} potential substring collisions`,
    affectedEvents: collisions,
  };
}

function checkMultiFileConstruction(sites: AuditCallSite[]): ConcernCheck {
  const multiFile: string[] = [];
  for (const site of sites) {
    // Check for spread operators or imported props
    const hasSpread = site.properties.some(p => p.type === "spread");
    const hasDynamic = site.properties.some(p =>
      p.type === "dynamic" && p.value && p.value.includes(".")
    );
    if (hasSpread || hasDynamic) {
      multiFile.push(`${site.eventName ?? "?"} (${site.file}:${site.line}) — ${hasSpread ? "spread" : "cross-ref"}: ${
        site.properties.filter(p => p.type === "spread" || (p.type === "dynamic" && p.value?.includes(".")))
          .map(p => p.name + (p.value ? `=${p.value}` : ""))
          .join(", ")
      }`);
    }
  }

  return {
    concern: "Multi-file event construction",
    status: multiFile.length === 0 ? "pass" : "warning",
    details: multiFile.length === 0
      ? "All properties are locally defined"
      : `${multiFile.length} call sites use spread/imported properties`,
    affectedEvents: multiFile,
  };
}

function checkConstantEnumNames(sites: AuditCallSite[]): ConcernCheck {
  const constants = sites.filter(s => s.eventNameType === "constant" || s.eventNameType === "variable");
  if (constants.length === 0) {
    return {
      concern: "Constant/enum event names",
      status: "pass",
      details: "All events use string literal names",
    };
  }

  return {
    concern: "Constant/enum event names requiring resolution",
    status: "warning",
    details: `${constants.length} call sites use constants/variables as event names`,
    affectedEvents: constants.map(s => `${s.eventName} (${s.eventNameType}) at ${s.file}:${s.line}`),
  };
}

function checkDynamicProperties(sites: AuditCallSite[]): ConcernCheck {
  const dynamic: string[] = [];
  for (const site of sites) {
    const dynProps = site.properties.filter(p =>
      p.type === "computed" || p.type === "spread" || p.type === "shorthand"
    );
    if (dynProps.length > 0) {
      dynamic.push(`${site.eventName ?? "?"}: ${dynProps.map(p => `${p.name}(${p.type})`).join(", ")}`);
    }
  }

  return {
    concern: "Dynamic/computed properties",
    status: dynamic.length === 0 ? "pass" : "warning",
    details: dynamic.length === 0
      ? "All properties are statically extractable"
      : `${dynamic.length} call sites have dynamic/computed properties`,
    affectedEvents: dynamic,
  };
}

// ─── Diff Engine ───────────────────────────────────────────────────

function diffResults(
  groundTruth: Map<string, AuditCallSite[]>,
  emitEvents: EmitCatalogEvent[],
  manualEvents: string[]
): DiffResult[] {
  const results: DiffResult[] = [];
  const emitByName = new Map<string, EmitCatalogEvent>();
  for (const evt of emitEvents) {
    emitByName.set(evt.event_name, evt);
  }

  const allEventNames = new Set([
    ...groundTruth.keys(),
    ...emitByName.keys(),
  ]);

  for (const name of allEventNames) {
    const gtSites = groundTruth.get(name) ?? [];
    const emitEvt = emitByName.get(name);

    // Collect ground truth property names
    const gtProps = new Set<string>();
    for (const site of gtSites) {
      for (const prop of site.properties) {
        if (!prop.name.startsWith("[") && !prop.name.startsWith("...")) {
          gtProps.add(prop.name);
        }
      }
    }

    // Collect emit property names
    const emitProps = new Set<string>();
    if (emitEvt?.properties) {
      for (const key of Object.keys(emitEvt.properties)) {
        emitProps.add(key);
      }
    }

    const correct = [...gtProps].filter(p => emitProps.has(p));
    const missing = [...gtProps].filter(p => !emitProps.has(p));
    const falsePos = [...emitProps].filter(p => !gtProps.has(p));

    const issues: string[] = [];
    if (!emitEvt && manualEvents.includes(name)) {
      issues.push("In manual_events but not in emit catalog (scan may not have been run)");
    } else if (!emitEvt && !manualEvents.includes(name)) {
      issues.push("Not in manual_events — emit cannot discover without warehouse/config");
    }

    const emitCallSiteCount = emitEvt?.all_call_sites?.length ?? (emitEvt ? 1 : 0);

    results.push({
      eventName: name,
      inGroundTruth: gtSites.length > 0,
      inEmitCatalog: !!emitEvt,
      groundTruthSites: gtSites.length,
      emitCallSites: emitCallSiteCount,
      propertiesCorrect: correct,
      propertiesMissing: missing,
      propertiesFalsePositive: falsePos,
      issues,
    });
  }

  return results.sort((a, b) => {
    // Sort: in both first, then GT-only, then emit-only
    if (a.inGroundTruth && a.inEmitCatalog && !(b.inGroundTruth && b.inEmitCatalog)) return -1;
    if (!(a.inGroundTruth && a.inEmitCatalog) && b.inGroundTruth && b.inEmitCatalog) return 1;
    return a.eventName.localeCompare(b.eventName);
  });
}

// ─── Report Formatting ────────────────────────────────────────────

function formatReport(report: AuditReport): string {
  const lines: string[] = [];

  lines.push(`# Audit Report: ${path.basename(report.repo)}`);
  lines.push(`**Date:** ${report.timestamp}`);
  lines.push(`**Pattern:** \`${report.pattern}\``);
  lines.push(`**SDK:** ${report.sdk}`);
  lines.push("");

  // Discovery summary
  lines.push("## Discovery Summary");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  lines.push(`| Total call sites | ${report.discovery.totalCallSites} |`);
  lines.push(`| Unique events | ${report.discovery.uniqueEvents} |`);
  lines.push(`| String literal names | ${report.discovery.stringLiteralEvents} |`);
  lines.push(`| Constant/enum names | ${report.discovery.constantEvents} |`);
  lines.push(`| Template literal names | ${report.discovery.templateLiteralEvents} |`);
  lines.push(`| Variable names | ${report.discovery.variableEvents} |`);
  lines.push(`| Unknown/unparseable | ${report.discovery.unknownEvents} |`);
  lines.push("");

  // Emit catalog comparison
  const inBoth = report.diff.filter(d => d.inGroundTruth && d.inEmitCatalog);
  const gtOnly = report.diff.filter(d => d.inGroundTruth && !d.inEmitCatalog);
  const emitOnly = report.diff.filter(d => !d.inGroundTruth && d.inEmitCatalog);

  lines.push("## Emit Catalog Comparison");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  lines.push(`| Events in both (matched) | ${inBoth.length} |`);
  lines.push(`| Ground truth only (missed by emit) | ${gtOnly.length} |`);
  lines.push(`| Emit only (not found by audit grep) | ${emitOnly.length} |`);
  lines.push(`| Total emit catalog events | ${report.emitEvents.length} |`);
  lines.push("");

  // Detailed diff table
  if (inBoth.length > 0) {
    lines.push("### Matched Events");
    lines.push("");
    lines.push("| Event | GT Sites | Emit Sites | Props Correct | Props Missing | Props False+ | Issues |");
    lines.push("|-------|----------|------------|---------------|---------------|--------------|--------|");
    for (const d of inBoth) {
      lines.push(
        `| ${d.eventName} | ${d.groundTruthSites} | ${d.emitCallSites} | ${d.propertiesCorrect.length} | ${d.propertiesMissing.length} | ${d.propertiesFalsePositive.length} | ${d.issues.join("; ") || "—"} |`
      );
    }
    lines.push("");

    // Detail on false positives and missing
    const withIssues = inBoth.filter(d => d.propertiesMissing.length > 0 || d.propertiesFalsePositive.length > 0);
    if (withIssues.length > 0) {
      lines.push("#### Property Discrepancies (matched events)");
      lines.push("");
      for (const d of withIssues) {
        lines.push(`**${d.eventName}:**`);
        if (d.propertiesMissing.length > 0) {
          lines.push(`- Missing from emit: ${d.propertiesMissing.join(", ")}`);
        }
        if (d.propertiesFalsePositive.length > 0) {
          lines.push(`- False positives in emit: ${d.propertiesFalsePositive.join(", ")}`);
        }
        lines.push("");
      }
    }
  }

  if (gtOnly.length > 0) {
    lines.push("### Events Found by Audit but NOT in Emit Catalog");
    lines.push("");
    lines.push("| Event | Call Sites | Name Type | Properties Found | Reason |");
    lines.push("|-------|-----------|-----------|-----------------|--------|");
    for (const d of gtOnly) {
      const gtSites = report.groundTruth.get(d.eventName) ?? [];
      const nameType = gtSites[0]?.eventNameType ?? "?";
      const propCount = new Set(gtSites.flatMap(s => s.properties.map(p => p.name))).size;
      lines.push(
        `| ${d.eventName} | ${d.groundTruthSites} | ${nameType} | ${propCount} | ${d.issues.join("; ") || "—"} |`
      );
    }
    lines.push("");
  }

  if (emitOnly.length > 0) {
    lines.push("### Events in Emit Catalog but NOT found by Audit Grep");
    lines.push("");
    lines.push("| Event | Status |");
    lines.push("|-------|--------|");
    for (const d of emitOnly) {
      const evt = report.emitEvents.find(e => e.event_name === d.eventName);
      lines.push(`| ${d.eventName} | ${evt?.status ?? "?"} |`);
    }
    lines.push("");
  }

  // Concern checks
  lines.push("## Concern Validation");
  lines.push("");
  lines.push("| Concern | Status | Details |");
  lines.push("|---------|--------|---------|");
  for (const c of report.concerns) {
    const icon = c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : c.status === "warning" ? "WARN" : "N/A";
    lines.push(`| ${c.concern} | ${icon} | ${c.details} |`);
  }
  lines.push("");

  // Detailed concern output
  const detailedConcerns = report.concerns.filter(
    c => (c.status === "fail" || c.status === "warning") && c.affectedEvents && c.affectedEvents.length > 0
  );
  if (detailedConcerns.length > 0) {
    lines.push("### Concern Details");
    lines.push("");
    for (const c of detailedConcerns) {
      lines.push(`#### ${c.concern} (${c.status.toUpperCase()})`);
      lines.push("");
      for (const item of c.affectedEvents!.slice(0, 30)) {
        lines.push(`- ${item}`);
      }
      if (c.affectedEvents!.length > 30) {
        lines.push(`- ... and ${c.affectedEvents!.length - 30} more`);
      }
      lines.push("");
    }
  }

  // Ground truth event inventory
  lines.push("## Full Event Inventory (Ground Truth)");
  lines.push("");
  lines.push("| # | Event Name | Type | File | Line | Props | In Emit? |");
  lines.push("|---|-----------|------|------|------|-------|----------|");
  let n = 0;
  for (const [eventName, sites] of [...report.groundTruth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const firstSite = sites[0];
    const propNames = [...new Set(sites.flatMap(s => s.properties.map(p => p.name)))];
    const inEmit = report.emitEvents.some(e => e.event_name === eventName);
    n++;
    lines.push(
      `| ${n} | ${eventName} | ${firstSite.eventNameType} | ${path.basename(firstSite.file)} | ${firstSite.line} | ${propNames.slice(0, 5).join(", ")}${propNames.length > 5 ? "..." : ""} | ${inEmit ? "YES" : "NO"} |`
    );
    // Show additional call sites
    for (const site of sites.slice(1)) {
      lines.push(
        `| | ↳ | | ${path.basename(site.file)} | ${site.line} | | |`
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

// ─── Main ──────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log(`
Usage: npx tsx scripts/audit.ts <repo-path> [options]

Options:
  --pattern "analytics.track("   Override SDK pattern (reads from emit.config.yml by default)
  --sdk segment                  Override SDK type
  --emit-scan                    Also run emit scan and diff results
  --output <file>                Write report to file (default: stdout + .emit/audit-<repo>.md)
  --json                         Output JSON instead of markdown

Reads emit.config.yml from the repo for default pattern/sdk/paths.
    `);
    process.exit(0);
  }

  const repoPath = path.resolve(args[0]);
  const repoName = path.basename(repoPath);

  if (!fs.existsSync(repoPath)) {
    console.error(`Repo path not found: ${repoPath}`);
    process.exit(1);
  }

  // Parse options
  let patternOverride: string | null = null;
  let sdkOverride: string | null = null;
  let runEmitScan = false;
  let outputFile: string | null = null;
  let jsonOutput = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--pattern" && args[i + 1]) { patternOverride = args[++i]; }
    else if (args[i] === "--sdk" && args[i + 1]) { sdkOverride = args[++i]; }
    else if (args[i] === "--emit-scan") { runEmitScan = true; }
    else if (args[i] === "--output" && args[i + 1]) { outputFile = args[++i]; }
    else if (args[i] === "--json") { jsonOutput = true; }
  }

  // Load config
  const config = loadRepoConfig(repoPath);
  const patterns = patternOverride ? [patternOverride] : config.patterns;
  const sdk = sdkOverride ?? config.sdk;
  const scanPaths = config.scanPaths;
  const manualEvents = config.manualEvents;

  if (patterns.length === 0) {
    console.error("No tracking patterns found. Specify --pattern or configure emit.config.yml");
    process.exit(1);
  }

  console.error(`Auditing ${repoName}...`);
  console.error(`  Patterns: ${patterns.join(", ")}`);
  console.error(`  SDK: ${sdk}`);
  console.error(`  Scan paths: ${scanPaths.join(", ")}`);
  console.error(`  Manual events: ${manualEvents.length}`);

  // ── Phase 1: Independent Discovery ────────────────────────────
  console.error("\nPhase 1: Independent discovery...");

  const allCallSites: AuditCallSite[] = [];

  for (const pattern of patterns) {
    const grepResults = grepForPattern(pattern, scanPaths);
    console.error(`  Pattern "${pattern}": ${grepResults.length} raw grep hits`);

    for (const grepLine of grepResults) {
      const parsed = parseGrepLine(grepLine);
      if (!parsed) continue;

      // Skip comments and imports
      if (isCommentOrImport(parsed.code)) continue;

      // Read context for multi-line parsing
      const context = readContext(parsed.file, parsed.lineNum, 15);

      // Extract event name
      const { name, type } = extractEventName(parsed.code, context, pattern);

      // Extract properties
      const properties = extractProperties(parsed.file, parsed.lineNum, pattern);

      // Detect function scope
      const functionScope = findFunctionScope(parsed.file, parsed.lineNum);

      allCallSites.push({
        file: parsed.file,
        line: parsed.lineNum,
        rawLine: parsed.code.trim(),
        eventName: name,
        eventNameType: type,
        properties,
        rawContext: context,
        functionScope,
      });
    }
  }

  console.error(`  Total valid call sites: ${allCallSites.length}`);

  // Group by event name
  const groundTruth = new Map<string, AuditCallSite[]>();
  for (const site of allCallSites) {
    const key = site.eventName ?? `[unknown@${path.basename(site.file)}:${site.line}]`;
    if (!groundTruth.has(key)) groundTruth.set(key, []);
    groundTruth.get(key)!.push(site);
  }

  console.error(`  Unique events: ${groundTruth.size}`);

  // ── Phase 2: Parse Emit Catalog ───────────────────────────────
  console.error("\nPhase 2: Parsing emit catalog...");
  const emitEvents = parseEmitCatalog(repoPath);
  console.error(`  Events in catalog: ${emitEvents.length}`);

  // ── Phase 3: Diff ─────────────────────────────────────────────
  console.error("\nPhase 3: Diffing...");
  const diff = diffResults(groundTruth, emitEvents, manualEvents);

  // ── Phase 4: Concern Checks ───────────────────────────────────
  console.error("\nPhase 4: Running concern checks...");
  const concerns: ConcernCheck[] = [
    checkArrowFunctionScoping(allCallSites),
    checkCSSContamination(allCallSites, emitEvents),
    checkSubstringCollisions(allCallSites),
    checkMultiFileConstruction(allCallSites),
    checkConstantEnumNames(allCallSites),
    checkDynamicProperties(allCallSites),
  ];

  // ── Build Report ──────────────────────────────────────────────
  const report: AuditReport = {
    repo: repoPath,
    pattern: patterns.join(", "),
    sdk,
    timestamp: new Date().toISOString(),
    discovery: {
      totalCallSites: allCallSites.length,
      uniqueEvents: groundTruth.size,
      stringLiteralEvents: allCallSites.filter(s => s.eventNameType === "string_literal").length,
      constantEvents: allCallSites.filter(s => s.eventNameType === "constant").length,
      templateLiteralEvents: allCallSites.filter(s => s.eventNameType === "template_literal").length,
      variableEvents: allCallSites.filter(s => s.eventNameType === "variable").length,
      unknownEvents: allCallSites.filter(s => s.eventNameType === "unknown").length,
    },
    groundTruth,
    emitEvents,
    diff,
    concerns,
  };

  // ── Output ────────────────────────────────────────────────────
  if (jsonOutput) {
    // Convert Map to plain object for JSON serialization
    const jsonReport = {
      ...report,
      groundTruth: Object.fromEntries(report.groundTruth),
    };
    const json = JSON.stringify(jsonReport, null, 2);
    if (outputFile) {
      fs.writeFileSync(outputFile, json);
      console.error(`\nJSON report written to ${outputFile}`);
    } else {
      console.log(json);
    }
  } else {
    const md = formatReport(report);

    // Always write to .emit/ directory
    const emitDir = path.join(repoPath, ".emit");
    if (!fs.existsSync(emitDir)) fs.mkdirSync(emitDir, { recursive: true });
    const defaultOutput = path.join(emitDir, `audit-report.md`);
    fs.writeFileSync(defaultOutput, md);
    console.error(`\nReport written to ${defaultOutput}`);

    if (outputFile) {
      fs.writeFileSync(outputFile, md);
      console.error(`Also written to ${outputFile}`);
    }

    // Print summary to stdout
    console.log(`\n=== AUDIT SUMMARY: ${repoName} ===`);
    console.log(`Call sites found: ${allCallSites.length}`);
    console.log(`Unique events: ${groundTruth.size}`);
    console.log(`In emit catalog: ${emitEvents.length}`);
    console.log(`Matched: ${diff.filter(d => d.inGroundTruth && d.inEmitCatalog).length}`);
    console.log(`Missed by emit: ${diff.filter(d => d.inGroundTruth && !d.inEmitCatalog).length}`);
    console.log(`Emit-only: ${diff.filter(d => !d.inGroundTruth && d.inEmitCatalog).length}`);
    console.log("");
    console.log("Concerns:");
    for (const c of concerns) {
      const icon = c.status === "pass" ? "  PASS" : c.status === "fail" ? "  FAIL" : c.status === "warning" ? "  WARN" : "  N/A ";
      console.log(`  ${icon}  ${c.concern}: ${c.details}`);
    }
  }
}

main();
