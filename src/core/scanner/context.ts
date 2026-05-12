import * as fs from "fs";
import { execSync, execFileSync } from "child_process";
import type { LiteralValues } from "../../types/index.js";
import { buildExcludeArgs } from "./search.js";

export function extractContext(
  filePath: string,
  lineNumber: number,
  window = 50
): string {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const idx = lineNumber - 1;

    // Try to find the enclosing function boundaries for tighter scoping.
    // This prevents cross-contamination when multiple tracking calls are in the same file.
    const funcBounds = findEnclosingFunction(lines, idx);
    if (funcBounds) {
      // Expand before for import context, but do NOT expand after to avoid bleeding into next function
      const start = Math.max(0, funcBounds.start - 3);
      const end = Math.min(lines.length, funcBounds.end + 1);
      return lines.slice(start, end).join("\n");
    }

    // Fallback: expanded window (no function boundary found = uncertainty, scan more)
    const expanded = window * 2;
    const start = Math.max(0, idx - expanded);
    const end = Math.min(lines.length, idx + expanded);
    return lines.slice(start, end).join("\n");
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event-class follow-through (Day 4.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pattern that captures references to event-class names in producer code.
 * Matches PascalCase identifiers ending in Event/Command/Message/Notification —
 * the conventional naming for domain events. Examples:
 *   `new BalanceDepositedEvent(`     → BalanceDepositedEvent
 *   `OrderCreatedCommand.builder()`  → OrderCreatedCommand
 *   `instanceof InvoiceFinalizedEvent` → InvoiceFinalizedEvent
 *
 * We intentionally exclude generic Class<Event> usage and skip names that
 * are too short to be meaningful (e.g. `Event` alone).
 */
const EVENT_CLASS_REF_PATTERN = /\b([A-Z][a-zA-Z0-9_]{4,}(?:Event|Command|Message|Notification))\b/g;

const EVENT_CLASS_REF_BLOCKLIST = new Set([
  "Event", "BaseEvent", "DomainEvent", "ApplicationEvent", "ContextEvent",
  "MessageEvent", "Command", "BaseCommand", "Notification",
]);

/** Per-scan cache of event-class file lookups (className → fileContent). */
const _eventClassCache = new Map<string, string | null>();

/**
 * Cap class-definition content per file. Keeps the LLM prompt bounded
 * even if the user has very large event classes.
 */
const EVENT_CLASS_MAX_BYTES = 4 * 1024;

/**
 * Find event-class definitions referenced from the given context. For each
 * unique PascalCase identifier ending in Event/Command/Message/Notification,
 * search the configured paths for a file declaring that class and read it.
 *
 * Used by the producer-mode discovery flow: when the publish call site
 * references typed event classes (CQRS, DDD-style), the LLM benefits from
 * seeing the class definitions to extract proper payload schema.
 *
 * Returns up to `maxClasses` results to bound prompt size.
 */
export function findEventClassDefinitions(
  contextSrc: string,
  paths: string[],
  maxClasses = 4,
): { path: string; content: string }[] {
  const matches = contextSrc.matchAll(EVENT_CLASS_REF_PATTERN);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const m of matches) {
    const name = m[1];
    if (EVENT_CLASS_REF_BLOCKLIST.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    candidates.push(name);
  }
  if (candidates.length === 0) return [];

  const results: { path: string; content: string }[] = [];
  for (const className of candidates.slice(0, maxClasses)) {
    if (_eventClassCache.has(className)) {
      const cached = _eventClassCache.get(className);
      if (cached !== null && cached !== undefined) {
        results.push({ path: `${className} (definition)`, content: cached });
      }
      continue;
    }
    // Cheap grep: look for `class ClassName` or `record ClassName` declarations
    // in the configured paths. Restricted to source extensions to avoid noise.
    const filePath = locateClassDefinition(className, paths);
    if (!filePath) {
      _eventClassCache.set(className, null);
      continue;
    }
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const trimmed = raw.length > EVENT_CLASS_MAX_BYTES
        ? raw.slice(0, EVENT_CLASS_MAX_BYTES) + `\n... (truncated, ${raw.length} bytes total)`
        : raw;
      _eventClassCache.set(className, trimmed);
      results.push({ path: filePath, content: trimmed });
    } catch {
      _eventClassCache.set(className, null);
    }
  }
  return results;
}

/** Locate the file declaring a given event class name. Returns first match. */
function locateClassDefinition(className: string, paths: string[]): string | null {
  for (const root of paths) {
    try {
      // Use grep -l to find files containing the class declaration. This
      // catches Java/Kotlin/Scala (`class X`, `record X`), TS/JS
      // (`class X`, `interface X`, `type X`), and Python (`class X`).
      // The ordering of regex alternatives matters: most specific first.
      const out = execSync(
        `grep -rlE "(class|record|interface|type)[[:space:]]+${className}\\b" ` +
          `--include='*.java' --include='*.kt' --include='*.scala' ` +
          `--include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' ` +
          `--include='*.py' ` +
          `--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=target ` +
          `${root} 2>/dev/null | head -1`,
        { encoding: "utf8" }
      ).trim();
      if (out) return out;
    } catch {
      // grep returned non-zero (no matches) — try next path
    }
  }
  return null;
}

/**
 * Patterns that mark the start of a function scope.
 * Order matters: more specific patterns first.
 */
const FUNC_START_PATTERNS: RegExp[] = [
  // Traditional: export async function foo(
  /^\s*(?:\/\*\*.*\*\/\s*)?(?:export\s+)?(?:async\s+)?function\s+\w+/,
  // Arrow assigned to const/let/var: const foo = async () =>
  // Also matches: const foo = (params) => {
  /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*(?::\s*\S+\s*)?=>|\w+\s*=>)/,
  // Arrow assigned to const with type annotation: const foo: Type = () =>
  /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*:\s*\S+\s*=\s*(?:async\s+)?(?:\(|[a-z])/,
  // React component: const Foo = ({ prop }) => { (capitalized name, common React pattern)
  /^\s*(?:export\s+)?(?:const|let)\s+[A-Z]\w+\s*=\s*(?:React\.memo\()?(?:async\s+)?\(/,
  // Class method or object method: methodName() { or async methodName() {
  /^\s{2,}(?:async\s+)?\w+\s*\([^)]*\)\s*(?::\s*\S+\s*)?\{/,
];

/**
 * Find the enclosing function boundaries around a given line.
 * Matches function declarations, arrow functions, class/object methods,
 * and React component definitions.
 */
function findEnclosingFunction(
  lines: string[],
  targetIdx: number
): { start: number; end: number } | null {
  function isFuncStart(line: string): boolean {
    return FUNC_START_PATTERNS.some((p) => p.test(line));
  }

  // Search backwards for the function declaration containing our target line
  let start = -1;
  for (let i = targetIdx; i >= Math.max(0, targetIdx - 200); i--) {
    if (isFuncStart(lines[i])) {
      start = i;
      break;
    }
  }

  if (start === -1) return null;

  // Search forwards for the next function declaration (or EOF) to find the end
  let end = lines.length - 1;
  for (let i = targetIdx + 1; i < Math.min(lines.length, start + 200); i++) {
    if (isFuncStart(lines[i])) {
      // End at the line before the next function (or its JSDoc comment)
      end = i - 1;
      // Also skip blank lines and JSDoc comments above the next function
      while (end > targetIdx && /^\s*($|\/\*\*)/.test(lines[end])) {
        end--;
      }
      break;
    }
  }

  return { start, end };
}

export function resolveEnumStringValue(
  constantName: string,
  repoPaths: string[]
): string | null {
  for (const repoPath of repoPaths) {
    let result: string;
    try {
      result = execFileSync(
        "grep",
        [
          "-rn",
          `${constantName}\\s*=`,
          repoPath,
          "--include=*.ts",
          "--include=*.tsx",
          "--include=*.java",
          ...buildExcludeArgs(),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
    } catch {
      // grep exits non-zero when no match found
      continue;
    }
    if (!result) continue;
    const head = result.split("\n").slice(0, 5).join("\n");
    const match = head.match(/=\s*["']([^"']+)["']/);
    if (match) return match[1];
  }
  return null;
}

export function extractAllLiteralValues(
  primaryContext: string,
  additionalContexts: string[],
  repoPaths: string[]
): LiteralValues {
  const combined: LiteralValues = {};
  const allContexts = [primaryContext, ...additionalContexts];

  for (const ctx of allContexts) {
    if (!ctx) continue;

    // Extract string literals: propName: "value" or propName: 'value'
    const stringLiteralRegex = /(\w+)\s*:\s*["']([^"'\n]{1,120})["']/g;
    let m: RegExpExecArray | null;
    while ((m = stringLiteralRegex.exec(ctx)) !== null) {
      const [, propName, value] = m;
      if (!combined[propName]) combined[propName] = [];
      if (!combined[propName].includes(value)) combined[propName].push(value);
    }

    // Extract enum accesses: propName: SomeEnum.MEMBER
    const enumAccessRegex = /(\w+)\s*:\s*\w+\.([A-Z][A-Z0-9_]+)/g;
    while ((m = enumAccessRegex.exec(ctx)) !== null) {
      const [, propName, enumMember] = m;
      const resolved = resolveEnumStringValue(enumMember, repoPaths);
      if (resolved) {
        if (!combined[propName]) combined[propName] = [];
        const labeled = `${resolved} (enum: ${enumMember})`;
        if (!combined[propName].includes(labeled)) combined[propName].push(labeled);
      }
    }
  }

  // Remove noise keywords
  const SKIP = new Set([
    "import", "from", "return", "const", "let", "var",
    "type", "class", "interface", "export", "default",
  ]);
  for (const key of Object.keys(combined)) {
    if (SKIP.has(key)) delete combined[key];
  }

  // Remove CSS-in-JS properties that leak from inline style={{ }} objects
  // when the context window includes JSX near the tracking call.
  const CSS_PROPS = new Set([
    "zIndex", "overflow", "backgroundColor", "background", "backgroundImage",
    "marginTop", "marginBottom", "marginLeft", "marginRight", "margin",
    "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "padding",
    "fontSize", "fontWeight", "fontFamily", "fontStyle", "lineHeight",
    "textAlign", "textDecoration", "textTransform", "letterSpacing",
    "whiteSpace", "wordBreak", "wordWrap", "overflowWrap",
    "color", "border", "borderRadius", "borderColor", "borderWidth",
    "borderStyle", "borderTop", "borderBottom", "borderLeft", "borderRight",
    "display", "position", "visibility", "float", "clear",
    "width", "height", "maxWidth", "maxHeight", "minWidth", "minHeight",
    "top", "bottom", "left", "right",
    "opacity", "cursor", "pointerEvents", "userSelect",
    "transform", "transition", "animation", "animationName",
    "boxShadow", "boxSizing", "outline", "outlineColor",
    "flexDirection", "justifyContent", "alignItems", "alignSelf",
    "flexWrap", "flexGrow", "flexShrink", "flexBasis",
    "gap", "rowGap", "columnGap",
    "gridTemplateColumns", "gridTemplateRows", "gridColumn", "gridRow",
    "objectFit", "objectPosition", "verticalAlign",
    "content", "listStyle", "listStyleType",
    "stroke", "strokeWidth", "fill",
  ]);
  for (const key of Object.keys(combined)) {
    if (CSS_PROPS.has(key)) delete combined[key];
  }

  // Remove keys that are likely TypeScript type annotation params (camelCase)
  // rather than actual tracking payload properties (usually snake_case).
  // A literal like `metricType: "gauge"` in a TS params type is noise;
  // the real payload uses `metric_type: params.metricType` (no string literal).
  for (const key of Object.keys(combined)) {
    // If the key matches a line that looks like a TS type annotation (followed by `;` or `|`)
    // in any of the contexts, it's probably a param type, not a payload property.
    const isTypeAnnotation = allContexts.some((ctx) => {
      if (!ctx) return false;
      const typePattern = new RegExp(
        `\\b${key}\\s*[:?]\\s*["'][^"']*["']\\s*[|;]`
      );
      return typePattern.test(ctx);
    });
    if (isTypeAnnotation) delete combined[key];
  }

  return combined;
}
