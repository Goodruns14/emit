import { createHash } from "crypto";

export function computeContextHash(
  context: string,
  callSiteContexts: string[],
  literalValues: Record<string, string[]>
): string {
  const h = createHash("sha256");
  h.update(context);
  for (const cs of callSiteContexts) h.update(cs);
  h.update(JSON.stringify(literalValues));
  return h.digest("hex").slice(0, 16);
}
