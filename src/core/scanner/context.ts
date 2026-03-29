import * as fs from "fs";
import { execSync } from "child_process";
import type { LiteralValues } from "../../types/index.js";

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

    // Fallback: fixed window
    const start = Math.max(0, idx - window);
    const end = Math.min(lines.length, idx + window);
    return lines.slice(start, end).join("\n");
  } catch {
    return "";
  }
}

/**
 * Find the enclosing function boundaries around a given line.
 * Uses function declaration markers (not brace-counting) to avoid confusion
 * with TypeScript parameter types like `(params: { ... })`.
 */
function findEnclosingFunction(
  lines: string[],
  targetIdx: number
): { start: number; end: number } | null {
  const funcDeclPattern =
    /^\s*(?:\/\*\*.*\*\/\s*)?(?:export\s+)?(?:async\s+)?function\s+\w+/;

  // Search backwards for the function declaration containing our target line
  let start = -1;
  for (let i = targetIdx; i >= Math.max(0, targetIdx - 80); i--) {
    if (funcDeclPattern.test(lines[i])) {
      start = i;
      break;
    }
  }

  if (start === -1) return null;

  // Search forwards for the next function declaration (or EOF) to find the end
  let end = lines.length - 1;
  for (let i = targetIdx + 1; i < Math.min(lines.length, start + 200); i++) {
    if (funcDeclPattern.test(lines[i])) {
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
    try {
      const result = execSync(
        `grep -rn "${constantName}\\s*=" "${repoPath}" --include="*.ts" --include="*.tsx" --include="*.java" 2>/dev/null | grep -v "node_modules" | head -5`,
        { encoding: "utf8" }
      ).trim();
      if (!result) continue;
      const match = result.match(/=\s*["']([^"']+)["']/);
      if (match) return match[1];
    } catch {
      // no match in this path
    }
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
