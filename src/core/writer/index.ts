import type { EmitCatalog } from "../../types/index.js";
import { writeCatalog } from "../catalog/index.js";

export function writeOutput(catalog: EmitCatalog, outputPath: string): void {
  writeCatalog(outputPath, catalog);
}
