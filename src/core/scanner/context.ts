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
    const start = Math.max(0, idx - window);
    const end = Math.min(lines.length, idx + window);
    return lines.slice(start, end).join("\n");
  } catch {
    return "";
  }
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
