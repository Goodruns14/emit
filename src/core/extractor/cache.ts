import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const CACHE_DIR = path.resolve(process.cwd(), ".emit", "cache");

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cacheKey(eventName: string, codeContext: string): string {
  const raw = `${eventName}::${codeContext}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

export function getCached<T>(eventName: string, codeContext: string): T | null {
  try {
    ensureCacheDir();
    const key = cacheKey(eventName, codeContext);
    const file = cachePath(key);
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export function setCached<T>(eventName: string, codeContext: string, value: T): void {
  try {
    ensureCacheDir();
    const key = cacheKey(eventName, codeContext);
    fs.writeFileSync(cachePath(key), JSON.stringify(value, null, 2));
  } catch {
    // Cache write failures are non-fatal
  }
}

export function clearCache(): void {
  try {
    if (fs.existsSync(CACHE_DIR)) {
      const files = fs.readdirSync(CACHE_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(CACHE_DIR, file));
      }
    }
  } catch {
    // non-fatal
  }
}
