/**
 * Cross-repo catalog set (registry) API.
 *
 * The implementation lives in `./index.ts` so the core `readCatalog` can be registry-aware
 * without an import cycle. This module re-exports the public surface as a stable, discoverable
 * import path for callers that think in terms of "catalog sets" (e.g. `emit reconcile`).
 */
export {
  loadCatalogSet,
  loadRegistry,
  isRegistryFile,
  type CatalogRegistryEntry,
} from "./index.js";
