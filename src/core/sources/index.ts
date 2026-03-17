export type { SourceAdapter } from "../../types/index.js";
export { SegmentSourceAdapter } from "./segment.js";

import type { SegmentSourceConfig, SourceAdapter } from "../../types/index.js";
import { SegmentSourceAdapter } from "./segment.js";

export function createSourceAdapter(config: SegmentSourceConfig): SourceAdapter {
  switch (config.type) {
    case "segment":
      return new SegmentSourceAdapter(config);
    default:
      throw new Error(`Unknown source type: ${(config as any).type}`);
  }
}
