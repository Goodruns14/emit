import { createHash } from "crypto";

export function computeContextHash(
  context: string,
  callSiteContexts: string[],
  literalValues: Record<string, string[]>,
  extraFiles: { path: string; content: string }[] = []
): string {
  const h = createHash("sha256");
  h.update(context);
  for (const cs of callSiteContexts) h.update(cs);
  h.update(JSON.stringify(literalValues));
  // Fold reference helper files into the hash so the catalog-level
  // incremental-skip mechanism invalidates when a configured context_file
  // changes. Without this, editing a helper file would leave the cached
  // catalog entry in place on the next non-fresh scan.
  for (const f of extraFiles) {
    h.update(f.path);
    h.update(f.content);
  }
  return h.digest("hex").slice(0, 16);
}
