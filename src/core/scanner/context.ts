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
      // Expand slightly beyond function bounds for import context, but cap at ±10 lines
      const start = Math.max(0, funcBounds.start - 5);
      const end = Math.min(lines.length, funcBounds.end + 5);
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
 * Find the start and end lines of the enclosing function around a given line.
 * Uses brace-counting to detect function boundaries.
 * Returns null if no function boundary is found (e.g., top-level code).
 */
function findEnclosingFunction(
  lines: string[],
  targetIdx: number
): { start: number; end: number } | null {
  // Search backwards for function start
  let start = targetIdx;
  const funcPattern =
    /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>|\w+\s*\([^)]*\)\s*(?::\s*\w+[^{]*)?\s*\{)/;

  for (let i = targetIdx; i >= Math.max(0, targetIdx - 80); i--) {
    if (funcPattern.test(lines[i])) {
      start = i;
      break;
    }
  }

  if (start === targetIdx && targetIdx > 0) {
    // Didn't find a function declaration — fall back to null
    return null;
  }

  // Count braces from function start to find the closing brace
  let braceDepth = 0;
  let foundOpen = false;
  for (let i = start; i < Math.min(lines.length, start + 200); i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        braceDepth++;
        foundOpen = true;
      } else if (ch === "}") {
        braceDepth--;
        if (foundOpen && braceDepth === 0) {
          return { start, end: i };
        }
      }
    }
  }

  // If brace matching failed, return null to use fallback
  return null;
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

  return combined;
}
